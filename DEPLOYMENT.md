# Deploying Folio to Base Sepolia

Everything here targets **Base Sepolia (chain id 84532)** and nothing else.
`foundry.toml` names no mainnet RPC alias, and every script reverts with
`WrongNetwork` before signing anything if `block.chainid` is not 84532 — so a
hand-typed `--rpc-url` cannot route a deploy somewhere real either.

---

## 1. Prerequisites

```bash
npm install                                   # OpenZeppelin + the forge binary
git submodule update --init --recursive       # forge-std
cp .env.example .env                          # then fill it in — see below
```

`.env` is gitignored. Foundry loads it from the project root automatically, so
`source .env` is only needed if you want the variables in your own shell too.

Fill in at minimum:

| Variable | What it is |
| --- | --- |
| `DEPLOYER_PRIVATE_KEY` | Signs deploys and trades. **Use a throwaway testnet wallet.** |
| `BASE_SEPOLIA_RPC_URL` | Defaults to `https://sepolia.base.org`, which works. |
| `BASESCAN_API_KEY` | From etherscan.io → API Keys. Only needed for `--verify`. |

Fund the deployer from a [Base Sepolia faucet](https://docs.base.org/chain/network-faucets).
A deploy plus a few trades needs well under 0.05 ETH.

> **Never put a real private key in `.env.example`** — that file is committed.
> There is no script in this repo that takes a key on the command line, and none
> should be added: shell history is not a secret store.

---

## 2. Security scan (Slither)

### Install and run

```bash
pip3 install slither-analyzer
npm run slither                # uses slither.config.json automatically
npm run slither:report         # same run, written to slither-report.md
```

Slither drives `forge build` itself and reads the resulting build-info, so no
separate compile step is needed.

### What `slither.config.json` does

| Setting | Why |
| --- | --- |
| `filter_paths` | Drops `node_modules/`, `contracts/lib/`, `contracts/test/`. Dependencies are audited upstream and we do not patch them in place; the test suite deliberately does unsafe things (reverting receivers, reentrant callers) and flagging those would train us to ignore the report. |
| `exclude_*: false` | Every severity stays on. Nothing may hide a High or a Medium. |
| `detectors_to_exclude` | Five style-only detectors — `naming-convention`, `solc-version`, `pragma`, `too-many-digits`, `assembly`. None bear on safety. |

**Deliberately left enabled**, because these are the categories that matter for a
bonding curve holding user funds:

- `reentrancy-eth`, `reentrancy-no-eth`, `reentrancy-benign`, `reentrancy-events`, `reentrancy-unlimited-gas`
- `unchecked-lowlevel`, `unchecked-send`, `unchecked-transfer`
- `arbitrary-send-eth`, `arbitrary-send-erc20`, `suicidal`
- `unprotected-upgrade`, `uninitialized-state`, `incorrect-equality`

All of them run clean against `contracts/src/`.

### Findings

An unfiltered run reports **68 findings**. Filtered to our own code: **1**, and it
is informational. Full accounting:

#### In our contracts

| Severity | Detector | Where | Status |
| --- | --- | --- | --- |
| Informational | `low-level-calls` | `FolioToken._sendEth` | **Accepted — not a defect.** |
| Informational | `pragma` | `contracts/src/*` | Excluded by config. |
| Informational | `too-many-digits` | `FolioFactory.MIN_VIRTUAL_ETH_RESERVE` | Excluded by config. |

**`low-level-calls` on `_sendEth`** — Slither flags every `.call{value:}` as
informational, regardless of whether the result is handled. Here it is:

```solidity
function _sendEth(address to, uint256 amount) private {
    (bool ok,) = payable(to).call{value: amount}("");
    if (!ok) revert EthTransferFailed();
}
```

A raw `call` is the correct primitive rather than `transfer` or `send`, both of
which forward a fixed 2300 gas and would break payouts to any contract-based
holder whose fallback does more than nothing. The return value is checked and
the failure reverts, which is exactly what the `unchecked-lowlevel` detector
exists to catch — and that detector, which is the one that would signal a real
bug, reports nothing. The detector was left enabled rather than silenced so
this line gets re-reviewed on every run.

#### In dependencies (OpenZeppelin) — filtered out

Reviewed once, recorded here so that silencing them stays an argued decision
rather than a hidden one.

| Severity | Count | Detector | Verdict |
| --- | --- | --- | --- |
| **High** | 1 | `incorrect-exp` in `Math.mulDiv` | **False positive.** |
| **Medium** | 9 | `divide-before-multiply` in `Math.mulDiv` / `Math.invMod` | **False positive.** |
| Low | 1 | `missing-zero-check` in `Ownable2Step.transferOwnership` | Not applicable. |
| Informational | 57 | `assembly`, `naming-convention`, `solc-version`, `too-many-digits`, `unindexed-event-address` | Style, all upstream. |

**The one High is `inverse = (3 * denominator) ^ 2`.** Slither's `incorrect-exp`
detector assumes `^` was a typo for `**`. It was not. This is the seed step of
Remco Bloemen's 512-bit `mulDiv`: for an odd `denominator`, `(3 * d) XOR 2` is
the standard closed form giving a modular inverse correct to four bits, which
Newton–Raphson then doubles to 256. Using `**` there would be the bug. This is a
long-standing known false positive against OpenZeppelin's `Math`, and it is
library code we neither wrote nor modify.

**The nine Mediums are the same function's exact-division steps.** `mulDiv`
divides by `twos`, a power of two that divides the value exactly by
construction, then multiplies by the modular inverse. `divide-before-multiply`
warns about precision loss from truncation, and there is no truncation here —
the division is exact. `Math.invMod`'s extended-Euclid loop is the same story.

**The Low does not apply.** `Ownable2Step.transferOwnership` accepts a zero
`newOwner` without checking — but under two-step transfer, setting a pending
owner does nothing until that address calls `acceptOwnership`, which the zero
address cannot do. `FolioFactory` also overrides `renounceOwnership` to revert,
so there is no path to an ownerless factory.

> **No High or Medium finding touches `contracts/src/`.** Nothing here was
> blocking, and no contract change was made in response to this scan.

---

## 3. Deploy to Base Sepolia

### Step by step

**1. Confirm the tests still pass.**

```bash
forge test
```

**2. Run Slither and read the output.**

```bash
npm run slither
```

Expect exactly one informational finding (`low-level-calls`). Anything else is
new since this document was written — read it before deploying.

**3. Dry run.** Simulates against real chain state and broadcasts nothing.

```bash
forge script contracts/script/DeployFactory.s.sol:DeployFactory \
  --rpc-url base-sepolia -vvv
```

**4. Deploy for real.**

```bash
npm run deploy:base-sepolia
```

or the same thing spelled out:

```bash
forge script contracts/script/DeployFactory.s.sol:DeployFactory \
  --rpc-url base-sepolia --broadcast --verify -vvv
```

The script prints the network, chain id, deployer and balance, then waits for
you to type `yes`. Anything else aborts before signing. It then:

- deploys `FolioFactory`, whose constructor also deploys the shared `FolioToken`
  implementation — so the factory can never point at a foreign implementation;
- verifies both on Basescan via `--verify`;
- writes `deployments/base-sepolia.json`.

**5. Commit the deployment record.**

```bash
git add deployments/base-sepolia.json && git commit -m "chore: record Base Sepolia deployment"
```

That file is how the frontend and every interaction script find the factory —
the address is never hardcoded and never passed on a command line.

```json
{
  "network": "base-sepolia",
  "chainId": 84532,
  "factory": "0x...",
  "implementation": "0x...",
  "owner": "0x...",
  "deployer": "0x...",
  "deployedAtBlock": 12345678,
  "explorer": "https://sepolia.basescan.org",
  "lastToken": "",
  "defaultConfig": { "...": "..." }
}
```

`deployedAtBlock` is the chain head at simulation time, a block or two before
the deploy actually lands — a safe lower bound to start an indexer from, not an
exact receipt. Wei values are strings, because they exceed 2^53 and would lose
precision the moment JavaScript parsed them.

### If verification fails

The deploy still succeeded — verification is a separate call to Basescan.
Retry against the recorded address without redeploying:

```bash
forge verify-contract <FACTORY_ADDRESS> \
  contracts/src/FolioFactory.sol:FolioFactory \
  --chain 84532 --watch \
  --constructor-args $(cast abi-encode \
    "constructor(address,(uint256,uint256,uint256,uint16,uint16))" \
    <OWNER> "(2000000000000000000,5000000000000000000,4000000000000000000,100,10000)")
```

### Redeploying

Running the deploy again produces a **second, independent factory** — nothing
mutates a live one. The JSON record is overwritten, so the previous address
survives only in git history. The script prints the address it is about to
replace as part of the confirmation.

---

## 4. Manual interaction scripts

Run these one at a time from the CLI to verify the contracts behave on a real
chain before any frontend is wired up. Each prints the network banner and waits
for `yes`. Each acts on `FOLIO_TOKEN` if set, otherwise on the last launch
recorded in `deployments/base-sepolia.json`.

Add `--broadcast` to actually send; leave it off for a dry run.

### `CreateToken` — launch a token

```bash
TOKEN_NAME="Midnight Kettle" TOKEN_SYMBOL=KETL TOKEN_SUPPLY=1000000 \
forge script contracts/script/CreateToken.s.sol:CreateToken \
  --rpc-url base-sepolia --broadcast -vvv
```

Prints the new address, gas used, opening price, market cap, fee, reserve cap
and graduation threshold, plus a Basescan link — and confirms the factory's
`isFolioToken` registry recognises it. Records it as `lastToken`, so everything
below runs with no arguments.

Optional `TOKEN_MAX_RESERVE_CAP` tightens this launch's blast radius below the
platform default. The factory rejects anything larger.

### `Buy` — buy off the curve

```bash
BUY_ETH=10000000000000000 \
forge script contracts/script/Buy.s.sol:Buy \
  --rpc-url base-sepolia --broadcast -vvv
```

Quotes first, then sets `minTokensOut` to the quote less `BUY_SLIPPAGE_BPS`
(default 100 = 1%) rather than passing zero — on a public mempool a zero floor
means accepting whatever price a sandwich leaves you. Prints tokens received as
a measured balance delta, gas, the price move, and the new reserve and headroom.

Refuses to run and says why if the launch is paused, graduated, or at its cap.

### `Sell` — sell back to the curve

```bash
SELL_BPS=5000 \
forge script contracts/script/Sell.s.sol:Sell \
  --rpc-url base-sepolia --broadcast -vvv
```

`SELL_BPS` is a fraction of the current balance (default half), which stays
correct whatever the previous buy returned. `SELL_TOKENS` sets an exact amount
instead. Prints what the curve paid *and* the wallet delta after gas — on a
testnet the gap between those two is the whole reason a sell can look like it
lost money.

### `CheckReserve` — solvency inspector (read-only)

```bash
forge script contracts/script/CheckReserve.s.sol:CheckReserve --rpc-url base-sepolia
```

Broadcasts nothing, costs nothing, and works while the platform is paused. Prints
the reserve, the outstanding sell obligation, the margin between them, the
contract balance reconciled against reserve + unclaimed fees, the curve state,
and a pass/fail verdict.

**The number that matters is `reserveHealthBps`:**

| Reading | Meaning |
| --- | --- |
| `10000` | Exactly covered. The design target and the normal reading. |
| `> 10000` | Accumulated rounding surplus. Expected to creep up as trades round in the reserve's favour. |
| `< 10000` | **Should be impossible.** Both legs price off the same `k`, so the reserve is sufficient by construction. This means the curve maths is wrong — pause immediately. |

### `Pause` / `Unpause` — the emergency stop

```bash
forge script contracts/script/Pause.s.sol:Pause   --rpc-url base-sepolia --broadcast -vvv
forge script contracts/script/Unpause.s.sol:Unpause --rpc-url base-sepolia --broadcast -vvv
```

`DEPLOYER_PRIVATE_KEY` must hold the **factory owner's** key. The scripts check
that up front, so a wrong wallet fails with a readable message instead of an
`OwnableUnauthorizedAccount` revert.

After pausing, the script proves the pause took effect: it deploys a `TradeProbe`
inside the local simulation, funds it with `vm.deal`, and attempts a buy and a
sell. Both should report `TradingPaused() <- correct`. None of that is
broadcast — calls outside `vm.broadcast` execute against the script's local fork
of real chain state, so it is a genuine test of post-pause behaviour that costs
no gas and cannot accidentally trade. `Unpause` runs the mirror check.

Read the halt plainly: **while it is engaged, holders cannot sell either.** That
is the cost of containment. It does not block `claimFees`, does not block any
view function, and cannot move anyone's funds.

### npm shortcuts

```
npm run folio:create    npm run folio:buy      npm run folio:sell
npm run folio:reserve   npm run folio:pause    npm run folio:unpause
```

---

## 5. Manual testing checklist

Work top to bottom. Tick each before wiring up the frontend.

### Deployment

- [ ] `forge test` passes.
- [ ] `npm run slither` reports only the one known informational finding.
- [ ] Dry run (no `--broadcast`) completes without reverting.
- [ ] Deploy confirmation banner shows **Base Sepolia / 84532** and the expected deployer.
- [ ] Answering anything other than `yes` aborts and broadcasts nothing.
- [ ] Factory and implementation both show **verified** on Basescan.
- [ ] `deployments/base-sepolia.json` exists, has the right `chainId`, and is committed.
- [ ] `factory.owner()` is the address you intended.
- [ ] `factory.renounceOwnership()` reverts with `RenounceDisabled` — try it from Basescan's write tab.

### Launching

- [ ] `CreateToken` succeeds; the address appears on Basescan.
- [ ] `factory.isFolioToken(<token>)` is `true`.
- [ ] Opening market cap equals `virtualEthReserve` (2 ETH by default), whatever supply you chose.
- [ ] `totalSupply()` is **0** before the first buy — supply is minted on demand, not pre-minted.
- [ ] A launch with `TOKEN_MAX_RESERVE_CAP` above the platform default is **rejected** (`ReserveCapAboveDefault`).

### Buying

- [ ] `Buy` returns roughly the quoted tokens; the wallet balance matches.
- [ ] The marginal price rises after the buy.
- [ ] `ethReserve` rises by the ETH sent **less** the 1% fee.
- [ ] `feesAccrued` rises by that fee, and is *not* counted in the reserve.
- [ ] A buy with `BUY_SLIPPAGE_BPS=0` set against a stale quote reverts with `SlippageExceeded`.
- [ ] A buy larger than the remaining headroom fills to the cap and **refunds** the rest rather than reverting.

### Selling

- [ ] `Sell` pays out roughly the quoted ETH, net of the 1% fee.
- [ ] The marginal price falls back after the sell.
- [ ] Tokens are burned: `totalSupply()` and `tokensSold` both fall.
- [ ] Selling more than you hold reverts with `ERC20InsufficientBalance`.
- [ ] **Buy then immediately sell the whole position back.** You should get back roughly what you paid minus ~2% (one fee per leg) and gas. This is the sell-back guarantee.

### Reserve

- [ ] `CheckReserve` reports `reserveHealthBps` of `10000` or a little above — **never below**.
- [ ] Contract ETH balance ≥ reserve + unclaimed fees.
- [ ] After a round of buys and sells by two different wallets, health is still ≥ `10000`.
- [ ] `getOutstandingSellObligation()` tracks `ethReserve` closely as trades land.

### Emergency stop

- [ ] `Pause` from a non-owner wallet fails with `NotFactoryOwner` before broadcasting.
- [ ] `Pause` from the owner succeeds; `factory.paused()` is `true`.
- [ ] Verification reports **both** `buy()` and `sell()` reverting with `TradingPaused()`.
- [ ] A real broadcast `Buy` while paused reverts on chain — not just in simulation.
- [ ] `createToken` is also blocked while paused.
- [ ] **Views still work while paused** — `CheckReserve` runs and prints real numbers.
- [ ] `claimFees` still works while paused (call it from the creator wallet on Basescan).
- [ ] `Unpause` restores trading; a `Buy` afterwards succeeds.

### Graduation (optional — needs ~4 ETH of testnet buys)

- [ ] Buying past `graduationThreshold` emits `Graduated` and sets `graduated`.
- [ ] Further buys revert with `CurveClosed`.
- [ ] **Selling still works after graduation.** It is never closed by anything but the pause.

### Before the frontend

- [ ] Every address the frontend needs comes from `deployments/base-sepolia.json`, not a literal.
- [ ] `.env` is gitignored and `.env.example` carries no real values.
- [ ] No private key appears in shell history, a script, or a commit.
- [ ] `getBuyQuote` / `getSellPrice` on chain agree with what the scripts settled — the preview and the settlement run the same code path, so they must.

---

## Troubleshooting

**`WrongNetwork(84532, 1)`** — the RPC is not Base Sepolia. Working as intended.
Check `BASE_SEPOLIA_RPC_URL`.

**`vm.prompt: IO error: not a terminal`** — the confirmation needs a real TTY.
Run it from a terminal, or set `FOLIO_SKIP_CONFIRM=true` for CI.

**`NoDeployment`** — no `deployments/base-sepolia.json`, or no launch recorded in
it yet. Run `DeployFactory`, then `CreateToken`, or pass `FOLIO_TOKEN=0x...`.

**`ReserveCapAboveDefault`** — `TOKEN_MAX_RESERVE_CAP` exceeds the platform
default. A creator may only tighten their own cap, never widen it.

**Slither can't find solc** — it needs the compiler on `PATH`, or `FOUNDRY_SOLC`
pointing at one. `solc-select install 0.8.26 && solc-select use 0.8.26`.
