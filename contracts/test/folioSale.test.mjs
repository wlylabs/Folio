import { VM } from "@ethereumjs/vm";
import { Common, Hardfork, Chain } from "@ethereumjs/common";
import { LegacyTransaction as LegacyTx } from "@ethereumjs/tx";
import { Address, hexToBytes, bytesToHex, Account } from "@ethereumjs/util";
import { encodeDeployData, encodeFunctionData, decodeFunctionResult, parseEther, formatEther } from "viem";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs contracts/FolioSale.sol against an in-memory EVM. Exercises the sale
 * maths — pricing, rounding, inventory cap, refunds, withdrawal auth — because
 * this contract handles real value and a bad divisor here silently overcharges
 * buyers.
 *
 *   npm test          (compile first if you changed the .sol)
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifact = readFileSync(join(root, "lib", "contracts", "folioSale.ts"), "utf8");
const ABI = JSON.parse(artifact.slice(artifact.indexOf("["), artifact.lastIndexOf("] as const") + 1));
const BYTECODE = artifact.match(/"(0x[0-9a-f]+)"/)[1];

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Paris });
const vm = await VM.create({ common });

const creatorPk = hexToBytes("0x" + "11".repeat(32));
const creator = Address.fromPrivateKey(creatorPk);
const buyerPk = hexToBytes("0x" + "22".repeat(32));
const buyer = Address.fromPrivateKey(buyerPk);

for (const addr of [creator, buyer]) {
  await vm.stateManager.putAccount(addr, new Account(0n, parseEther("100")));
}

let creatorNonce = 0n;
let buyerNonce = 0n;

const SUPPLY = 1_000_000n;
const PRICE = parseEther("0.0002"); // wei per whole token

// ---- deploy ----
const deployData = encodeDeployData({
  abi: ABI,
  bytecode: BYTECODE,
  args: ["Midnight Kettle", "KETL", SUPPLY, PRICE, creator.toString()],
});

let tx = new LegacyTx(
  { nonce: creatorNonce++, gasPrice: 10n, gasLimit: 9_000_000n, data: hexToBytes(deployData), value: 0n },
  { common }
).sign(creatorPk);
let res = await vm.runTx({ tx });
if (res.execResult.exceptionError) throw new Error("deploy failed: " + res.execResult.exceptionError.error);
const contract = res.createdAddress;
console.log("deployed at", contract.toString());

async function call(fn, args = [], { from = buyer, pk = buyerPk, value = 0n, expectRevert = false } = {}) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args });
  const nonce = from === buyer ? buyerNonce++ : creatorNonce++;
  const t = new LegacyTx(
    { nonce, gasPrice: 10n, gasLimit: 5_000_000n, to: contract, data: hexToBytes(data), value },
    { common }
  ).sign(pk);
  const r = await vm.runTx({ tx: t });
  if (r.execResult.exceptionError) {
    if (expectRevert) return { reverted: true };
    throw new Error(`${fn} reverted: ${r.execResult.exceptionError.error} ${bytesToHex(r.execResult.returnValue)}`);
  }
  if (expectRevert) throw new Error(`${fn} was expected to revert but did not`);
  const out = r.execResult.returnValue.length
    ? decodeFunctionResult({ abi: ABI, functionName: fn, data: bytesToHex(r.execResult.returnValue) })
    : undefined;
  return { out, gas: r.totalGasSpent };
}

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; } else console.log("ok -", msg); };

const ethOf = async (addr) => (await vm.stateManager.getAccount(addr)).balance;

// ---- metadata ----
assert((await call("name")).out === "Midnight Kettle", "name()");
assert((await call("symbol")).out === "KETL", "symbol()");
assert((await call("decimals")).out === 18, "decimals() == 18");
const total = (await call("totalSupply")).out;
assert(total === SUPPLY * 10n ** 18n, `totalSupply == supply*1e18 (${total})`);
assert((await call("price")).out === PRICE, "price()");
assert((await call("creator")).out.toLowerCase() === creator.toString().toLowerCase(), "creator()");
assert((await call("remaining")).out === total, "remaining() == totalSupply before any sale");
assert((await call("balanceOf", [contract.toString()])).out === total, "contract holds full inventory");

// ---- buyback pricing ----
const SELL_PRICE = (PRICE * 9500n) / 10_000n;
assert((await call("SELL_FEE_BPS")).out === 500n, "SELL_FEE_BPS == 500 (5%)");
assert((await call("sellPrice")).out === SELL_PRICE, `sellPrice() == price - 5% (${formatEther(SELL_PRICE)})`);
assert((await call("reserveRequired")).out === 0n, "reserveRequired() == 0 with nothing circulating");

// ---- buy: exact multiple ----
// 0.02 ETH at 0.0002/token = 100 tokens
await call("buy", [], { value: parseEther("0.02") });
let bal = (await call("balanceOf", [buyer.toString()])).out;
assert(bal === 100n * 10n ** 18n, `buyer got 100 tokens (got ${formatEther(bal)})`);
assert((await call("sold")).out === 100n * 10n ** 18n, "sold() == 100 tokens");
assert((await ethOf(contract)) === parseEther("0.02"), "contract kept 0.02 ETH");
assert((await call("remaining")).out === total - 100n * 10n ** 18n, "remaining decremented");

// 100 tokens circulating at 0.00019 each must stay behind; the 5% spread is the
// creator's to take.
assert((await call("reserveRequired")).out === 100n * SELL_PRICE, "reserveRequired() backs the 100 sold tokens");
assert((await call("withdrawable")).out === parseEther("0.02") - 100n * SELL_PRICE, "withdrawable() == the 5% spread only");

// ---- buy: non-exact amount refunds dust ----
// 0.00025 ETH at 0.0002 = 1.25 tokens -> should get 1.25 tokens exactly (fractional ok)
await call("buy", [], { value: parseEther("0.00025") });
const bal2 = (await call("balanceOf", [buyer.toString()])).out;
assert(bal2 === 101n * 10n ** 18n + 250n * 10n ** 15n, `fractional buy credited 1.25 tokens (got ${formatEther(bal2)})`);

// ---- buy: zero value reverts ----
await call("buy", [], { value: 0n, expectRevert: true });
console.log("ok - buy() with 0 value reverts (PaymentTooSmall)");

// 1 wei is a legitimate purchase here: 1e18/2e14 = 5000 base units, costing
// exactly 1 wei, so nothing is lost to rounding.
const dustBefore = (await call("balanceOf", [buyer.toString()])).out;
const heldBefore = await ethOf(contract);
await call("buy", [], { value: 1n });
const dustAfter = (await call("balanceOf", [buyer.toString()])).out;
assert(dustAfter - dustBefore === 5000n, `1 wei buys 5000 base units (got ${dustAfter - dustBefore})`);
assert((await ethOf(contract)) - heldBefore === 1n, "1 wei purchase charges exactly 1 wei");

// ---- transfer ----
await call("transfer", [creator.toString(), 10n * 10n ** 18n]);
assert((await call("balanceOf", [creator.toString()])).out === 10n * 10n ** 18n, "transfer() moves tokens");

// ---- sell: the buyback leg ----
await call("sell", [0n], { expectRevert: true });
console.log("ok - sell(0) reverts (NothingToSell)");

await call("sell", [1_000_000n * 10n ** 18n], { expectRevert: true });
console.log("ok - selling more than you hold reverts (InsufficientBalance)");

const ONE = 10n ** 18n;
assert((await call("quoteSell", [ONE])).out === SELL_PRICE, "quoteSell(1 token) == sellPrice()");

{
  const soldBefore = (await call("sold")).out;
  const inventoryBefore = (await call("remaining")).out;
  const heldEthBefore = await ethOf(contract);
  const buyerTokensBefore = (await call("balanceOf", [buyer.toString()])).out;
  const buyerEthBefore = await ethOf(buyer);

  await call("sell", [ONE]);

  assert(
    (await call("balanceOf", [buyer.toString()])).out === buyerTokensBefore - ONE,
    "sell() takes the tokens from the seller"
  );
  assert((await call("sold")).out === soldBefore - ONE, "sold() falls by the amount sold back");
  assert(
    (await call("remaining")).out === inventoryBefore + ONE,
    "sold-back tokens return to inventory and can be bought again"
  );
  assert(heldEthBefore - (await ethOf(contract)) === SELL_PRICE, "contract paid out exactly sellPrice()");
  // Gas here is 5e7 wei at most, three orders of magnitude under the payout.
  assert((await ethOf(buyer)) > buyerEthBefore, "seller's ETH went up");
}

// ---- withdraw: only the surplus, only the creator ----
await call("withdraw", [], { expectRevert: true });
console.log("ok - withdraw() by non-creator reverts");

const surplus = (await call("withdrawable")).out;
const reserved = (await call("reserveRequired")).out;
assert(surplus > 0n, `withdrawable() is the accumulated spread (${formatEther(surplus)} ETH)`);

const creatorEthBefore = await ethOf(creator);
await call("withdraw", [], { from: creator, pk: creatorPk });
assert((await ethOf(creator)) > creatorEthBefore, "creator received the surplus");
assert((await ethOf(contract)) === reserved, "the buyback reserve stayed behind");
assert((await call("withdrawable")).out === 0n, "withdrawable() drained to zero");
await call("withdraw", [], { from: creator, pk: creatorPk, expectRevert: true });
console.log("ok - second withdraw() reverts (NothingToWithdraw)");

// The property that makes the sell button trustworthy: a holder can still cash
// out after the creator has taken everything they were allowed to.
{
  const holding = (await call("balanceOf", [buyer.toString()])).out;
  const quote = (await call("quoteSell", [holding])).out;
  assert(quote <= (await ethOf(contract)), "reserve still covers the remaining holder in full");
  await call("sell", [holding]);
  assert((await call("balanceOf", [buyer.toString()])).out === 0n, "holder sold out completely post-withdraw");
}

// ---- buy caps at remaining inventory and refunds the excess ----
// Deploy a tiny sale: 2 tokens at 1 ETH each, then send 5 ETH.
const smallDeploy = encodeDeployData({
  abi: ABI, bytecode: BYTECODE,
  args: ["Tiny", "TINY", 2n, parseEther("1"), creator.toString()],
});
tx = new LegacyTx({ nonce: creatorNonce++, gasPrice: 10n, gasLimit: 9_000_000n, data: hexToBytes(smallDeploy), value: 0n }, { common }).sign(creatorPk);
res = await vm.runTx({ tx });
const small = res.createdAddress;

async function callAt(addr, fn, args = [], value = 0n) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args });
  const t = new LegacyTx({ nonce: buyerNonce++, gasPrice: 10n, gasLimit: 5_000_000n, to: addr, data: hexToBytes(data), value }, { common }).sign(buyerPk);
  const r = await vm.runTx({ tx: t });
  if (r.execResult.exceptionError) throw new Error(`${fn} reverted: ${r.execResult.exceptionError.error}`);
  return r.execResult.returnValue.length ? decodeFunctionResult({ abi: ABI, functionName: fn, data: bytesToHex(r.execResult.returnValue) }) : undefined;
}

const ethBefore = (await vm.stateManager.getAccount(buyer)).balance;
await callAt(small, "buy", [], parseEther("5"));
const gotTiny = await callAt(small, "balanceOf", [buyer.toString()]);
assert(gotTiny === 2n * 10n ** 18n, `overpay capped at 2 tokens (got ${formatEther(gotTiny)})`);
const tinyHeld = await ethOf(small);
assert(tinyHeld === parseEther("2"), `charged only 2 ETH, refunded 3 (contract holds ${formatEther(tinyHeld)})`);
const ethAfter = (await vm.stateManager.getAccount(buyer)).balance;
const spent = ethBefore - ethAfter;
assert(spent < parseEther("2.01"), `buyer net spend ~2 ETH not 5 (spent ${formatEther(spent)})`);

// sold out
await callAt(small, "buy", [], parseEther("1")).then(
  () => { console.error("FAIL: buy on sold-out sale should revert"); process.exitCode = 1; },
  () => console.log("ok - buy() on sold-out sale reverts (SoldOut)")
);

// ---- selling out of a sold-out sale reopens it ----
await callAt(small, "sell", [2n * 10n ** 18n]);
assert((await callAt(small, "sold")) === 0n, "sold() back to zero after full sell-back");
assert((await callAt(small, "remaining")) === 2n * 10n ** 18n, "inventory restored, sale is open again");
assert((await ethOf(small)) === parseEther("2") - parseEther("1.9"), "reserve released, 5% spread left for the creator");
await callAt(small, "buy", [], parseEther("1"));
assert((await callAt(small, "balanceOf", [buyer.toString()])) === 1n * 10n ** 18n, "the reopened sale sells again");

// ---- a launch price too low to have a buyback is rejected ----
// price 1 wei floors sellPrice() to 0, which would mint unsellable tokens.
const badDeploy = encodeDeployData({
  abi: ABI, bytecode: BYTECODE, args: ["Dust", "DUST", 1n, 1n, creator.toString()],
});
res = await vm.runTx({
  tx: new LegacyTx(
    { nonce: creatorNonce++, gasPrice: 10n, gasLimit: 9_000_000n, data: hexToBytes(badDeploy), value: 0n },
    { common }
  ).sign(creatorPk),
});
assert(!!res.execResult.exceptionError, "deploy with a 1 wei price reverts (InvalidPrice)");

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL CONTRACT TESTS PASSED");
