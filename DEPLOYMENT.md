# Deploying Folio

Two networks, both testnets:

| Network | Chain id | RPC alias | Deployment record | Explorer |
| --- | --- | --- | --- | --- |
| Base Sepolia | 84532 | `base-sepolia` | `deployments/base-sepolia.json` | Basescan (Etherscan) |
| Robinhood Chain Testnet | 46630 | `robinhood-testnet` | `deployments/robinhood-testnet.json` | Blockscout |

`foundry.toml` names no mainnet RPC alias — not Base's, not Robinhood's — and
every script reverts with `WrongNetwork` before signing anything if
`block.chainid` is neither 84532 nor 46630, so a hand-typed `--rpc-url` cannot
route a deploy somewhere real either.

**One set of scripts serves both chains.** There is no `DeployFactoryRobinhood`
and there should not be one: the chain is chosen by `--rpc-url` alone, and
everything chain-shaped — the record path, the explorer links, the banner —
comes from the `NetworkProfile` in `contracts/script/FolioScript.sol`. Adding a
chain means adding a profile there and an alias in `foundry.toml`, nothing else.

Sections 1–3 below are written against Base Sepolia because that is where the
live factory is. [Section 4](#4-deploy-to-robinhood-chain-testnet) covers what
is different about Robinhood Chain; everything else applies unchanged.

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
| `ROBINHOOD_TESTNET_RPC_URL` | Only for section 4. Defaults to the public endpoint. |
| `BLOCKSCOUT_API_KEY` | Only for section 4, and normally empty — Blockscout needs no key. |

Fund the deployer from a [Base Sepolia faucet](https://docs.base.org/chain/network-faucets),
or for Robinhood Chain from
[faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com).
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

### Deploying from CI (GitHub Actions)

`.github/workflows/deploy-base-sepolia.yml` runs the same script from CI, for
when the deployer key should live in a secret store rather than on somebody's
laptop. It is `workflow_dispatch` only — there is no push or schedule trigger,
because re-running it deploys a second factory (see *Redeploying* above).

Configure it once, on a **`base-sepolia` environment** rather than at repository
level — that is what lets you require a reviewer before a run proceeds:

| Secret | |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | 0x-prefixed. `vm.envUint` cannot parse it otherwise. Needs Base Sepolia ETH. |
| `BASE_SEPOLIA_RPC_URL` | Resolves the `base-sepolia` alias in `foundry.toml`. |
| `BASESCAN_API_KEY` | Only read when the run's `verify` input is on. |

The curve terms default to the same testnet numbers the script uses. Override
any of them with repository *variables* named `FACTORY_VIRTUAL_ETH_RESERVE`,
`FACTORY_MAX_RESERVE_CAP`, `FACTORY_GRADUATION_THRESHOLD`, `FACTORY_FEE_BPS`,
`FACTORY_PRICE_MOVE_ALERT_BPS`; only the ones you set are passed through, since
an empty value is not the same as an unset one to `vm.envOr`.

Two things the workflow does that are worth knowing when reading a failed run:

- **A failure after the broadcast does not discard the address.** Basescan
  verification is flaky often enough that treating it as fatal would lose the
  record of a factory that already exists on chain. The deploy step is allowed
  to fail, the record is written to the job summary and to a run artifact, and
  the job is only marked failed at the very end. If verification is what broke,
  retry it with `forge verify-contract` as above — no redeploy.
- **A stale record is never reported as this run's.** The workflow hashes
  `deployments/base-sepolia.json` before deploying and compares afterwards, so a
  run that fails before broadcasting says it deployed nothing instead of echoing
  the previously committed address.

On success it commits the updated `deployments/base-sepolia.json` back to the
branch it ran on, which is what `deployments/.gitkeep` asks for. Against a
protected branch the push is refused; the run warns and leaves the file in its
artifact for you to commit.

---

## 4. Deploy to Robinhood Chain Testnet

Robinhood Chain is an Arbitrum Orbit L2, EVM-compatible, ETH for gas. The
contracts, the scripts and the test suite are the same ones section 3 uses —
what follows is only the four things that differ.

### What is actually different

| | Base Sepolia | Robinhood Chain Testnet |
| --- | --- | --- |
| `--rpc-url` alias | `base-sepolia` | `robinhood-testnet` |
| Chain id | 84532 | 46630 |
| Explorer | Basescan, an Etherscan deployment | Blockscout |
| `--verify` | works on its own | needs `--verifier blockscout --verifier-url ...` |
| Record written | `deployments/base-sepolia.json` | `deployments/robinhood-testnet.json` |

Nothing else: same `DeployFactory.s.sol`, same bytecode, same `evm_version`.
The contracts read no chain id and use no post-Merge opcode.

### Step by step

**1. Point `ROBINHOOD_TESTNET_RPC_URL` at the chain.** The public endpoint in
`.env.example` is rate-limited but works for one deploy. For anything repeated,
create a Robinhood Chain Testnet app in the same Alchemy dashboard you already
use for Base Sepolia and use
`https://robinhood-testnet.g.alchemy.com/v2/<API_KEY>` instead.

Confirm the URL before spending a deploy on it — chain registries disagree
about whether the public endpoint carries a trailing `/rpc`:

```bash
cast chain-id --rpc-url $ROBINHOOD_TESTNET_RPC_URL     # must print 46630
```

**2. Fund the deployer** from
[faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com).
Under 0.05 ETH covers a deploy plus a handful of trades.

**3. Dry run.** Broadcasts nothing, and the network guard runs here — a wrong
RPC fails at this step rather than at signing.

```bash
forge script contracts/script/DeployFactory.s.sol:DeployFactory \
  --rpc-url robinhood-testnet -vvv
```

The banner must read **Robinhood Chain Testnet / 46630**. If it says anything
else, stop: the RPC is not the chain you think it is.

**4. Deploy.**

```bash
npm run deploy:robinhood-testnet
```

or spelled out — note the two extra verification flags:

```bash
forge script contracts/script/DeployFactory.s.sol:DeployFactory \
  --rpc-url robinhood-testnet --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api/ \
  -vvv
```

**5. Commit the record.**

```bash
git add deployments/robinhood-testnet.json
git commit -m "chore: record Robinhood Chain Testnet deployment"
```

This is a *second* record, not a replacement — `deployments/base-sepolia.json`
is untouched and the Base Sepolia factory keeps running. One file per chain is
what makes that true.

### Verifying on Blockscout

Foundry's default verifier is Etherscan, and Robinhood Chain is not on
Etherscan's v2 API, so `--verify` alone is not enough: `--verifier blockscout`
selects the provider and `--verifier-url` points at this chain's instance. The
`/api/` suffix is part of it — Blockscout serves its Etherscan-compatible
endpoint there, and the bare explorer URL will not work.

`foundry.toml` already carries the URL under `[etherscan] robinhood-testnet`,
but the *provider* is a command-line choice, which is why the flag is still
needed. Blockscout requires no API key; `BLOCKSCOUT_API_KEY` stays empty unless
the instance starts asking for one.

To verify after the fact, against an address that is already deployed:

```bash
forge verify-contract <FACTORY_ADDRESS> \
  contracts/src/FolioFactory.sol:FolioFactory \
  --chain-id 46630 --watch \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api/ \
  --constructor-args $(cast abi-encode \
    "constructor(address,(uint256,uint256,uint256,uint16,uint16))" \
    <OWNER> "(2000000000000000000,5000000000000000000,4000000000000000000,100,10000)")
```

A failed verification never means a failed deploy — the contract is on chain
either way, and this command can be re-run against the recorded address.

### Interacting

Every script in section 5 takes `--rpc-url robinhood-testnet` and needs no
other change. They read `deployments/robinhood-testnet.json`, so a launch made
on Robinhood cannot be confused with one made on Base Sepolia.

```bash
forge script contracts/script/CreateToken.s.sol:CreateToken \
  --rpc-url robinhood-testnet --broadcast -vvv
```

### Gas

Per-operation EVM gas is the same on both chains — same bytecode, same opcode
costs. What differs is the fee *around* it: Robinhood Chain is an Orbit L2 and
its transaction cost carries an L1 data component, so compare total fees paid
rather than the `Gas used` figure the scripts print.

One caveat specific to Arbitrum-family chains: `gasleft()` accounting is not
identical to L1's, so the `~Gas used` line the scripts print is indicative
there, not exact. It is a printed figure only — nothing in the contracts
depends on it.

### Still unconfirmed

`evm_version` stays `paris`, deliberately. Arbitrum has supported PUSH0 since
ArbOS 11 and TSTORE/MCOPY since ArbOS 20, so Cancun would very probably work —
but the measured saving is ~63k gas on the one-off factory deploy and under
0.4% per trade, which is not worth deploying on an assumption about a chain's
EVM revision. Once a deploy has landed and the explorer confirms what the chain
runs, this is worth revisiting.

---

## 5. Manual interaction scripts

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

These are pinned to `--rpc-url base-sepolia`. For Robinhood Chain, run the
`forge script` command spelled out above with `--rpc-url robinhood-testnet` —
deliberately not wrapped in a second set of shortcuts, so which chain a trade
lands on stays something you typed rather than something you picked off a list.

---

## 6. Manual testing checklist

Work top to bottom. Tick each before wiring up the frontend.

### Deployment

- [ ] `forge test` passes.
- [ ] `npm run slither` reports only the one known informational finding.
- [ ] Dry run (no `--broadcast`) completes without reverting.
- [ ] Deploy confirmation banner shows the chain you meant — **Base Sepolia / 84532** or **Robinhood Chain Testnet / 46630** — and the expected deployer.
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

## 7. Wiring the frontend

The frontend reads `deployments/base-sepolia.json` directly — `lib/contracts/deployment.ts`
is the only module that knows an address, and every page goes through it. A
re-deploy is therefore: run `DeployFactory`, commit the JSON it rewrote, push.
Nothing else changes.

### What to check after a re-deploy

- [ ] `deployments/base-sepolia.json` is committed, and `factory` is the new address.
- [ ] `deployedAtBlock` is non-zero. The indexer uses it as its scan floor; when
      it is zero the indexer finds the block by bisecting on `eth_getCode`,
      which works but costs ~20 RPC reads on the first run of each server
      process.
- [ ] The create page's "Curve terms" box shows the terms you deployed with.
      They are read from the same JSON, so a mismatch means a stale file.

### Env vars the frontend adds

None are required. All five are optional and documented in `.env.example`:

| Variable | Why you'd set it |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | The public origin. Set it on the production deploy — canonical URLs, `sitemap.xml` and every `og:image` are built from it, and the `VERCEL_URL` fallback changes on every deploy. |
| `NEXT_PUBLIC_FACTORY_ADDRESS` | Point a preview build at a different factory without editing the repo. Overrides the JSON. |
| `SUPABASE_SERVICE_ROLE_KEY` | Let the indexer write as the service role. Server-only — it bypasses row level security. |
| `INDEXER_SECRET` | Require `Authorization: Bearer <secret>` on `/api/indexer`. Set it on anything public. |
| `INDEXER_FROM_BLOCK` | Override the indexer's scan floor. |
| `COINGECKO_API_KEY` | Use a CoinGecko Pro plan for `/api/eth-price` instead of the free public endpoint. Server-only. |

### Keeping the feed in step with the chain

A token created by `CreateToken.s.sol`, or straight from Basescan, has no
listing row — the create page is what normally writes one. `/api/indexer` closes
that gap by diffing the factory's `TokenCreated` log against the table and
inserting what's missing, with a placeholder article. It is idempotent, so call
it as often as you like:

```bash
# after creating a token from a script
curl -X POST http://localhost:3000/api/indexer

# or hold a subscription open and let it fire on each launch
npm run watch:launches
```

On Vercel, the same endpoint fits a cron:

```json
{ "crons": [{ "path": "/api/indexer", "schedule": "*/5 * * * *" }] }
```

Hobby projects are capped at one cron run a day; a Pro project can run it every
few minutes. Either way, pages themselves never scan the chain for the feed —
they read the table.

---

## 8. Search indexing

A Folio listing is an article, which is the one thing this launchpad has that a
chart with a buy button does not: substantive text a search engine can index.
The plumbing for that is already in the app, but two of the pieces only work on
a real domain.

### Before the first production deploy

- [ ] **Set `NEXT_PUBLIC_SITE_URL`** to the real origin, with no trailing slash.
      Without it the app falls back to `VERCEL_URL`, which changes on every
      deploy — so canonical URLs point at a host that will not exist next week,
      and `sitemap.xml` advertises the same. This is the single setting that
      matters most here.
- [ ] Fetch `/robots.txt` and confirm the `Sitemap:` line names that origin.
- [ ] Fetch `/sitemap.xml` and confirm published listings appear in it. It is
      regenerated hourly (`revalidate` in `app/sitemap.ts`), so a launch made in
      the last few minutes may not be in it yet — it is linked from the front
      page either way.
- [ ] Open `view-source:` on a listing and confirm the article text is in the
      HTML, not fetched afterwards. Token pages are server components and this
      should never regress; if it ever does, nothing else in this section
      matters, because a crawler reads what the server sent.
- [ ] Paste a listing URL into <https://cards-dev.twitter.com/validator> and
      into a Telegram chat, and confirm the preview card renders. Both read the
      same `og:` tags.
- [ ] Run a listing through <https://search.google.com/test/rich-results> and
      confirm the `Article` block is detected with no errors.

### Then

Register the domain in Google Search Console and submit `/sitemap.xml` once.
Nothing needs resubmitting after that — new listings enter the sitemap on their
own within the hour.

### Where each piece lives

| Piece | File |
| --- | --- |
| Titles, descriptions, Open Graph, Twitter cards | `lib/seo.ts`, spread into each route's `metadata` |
| `Article` and `WebSite` structured data | `lib/seo.ts` → `components/JsonLd.tsx` |
| The share card used when a token has no avatar | `app/og.png/route.tsx` (prerendered at build) |
| `sitemap.xml` | `app/sitemap.ts` |
| `robots.txt` | `app/robots.ts` |

---

## Troubleshooting

**`WrongNetwork(1)`** — the RPC points at a chain with no `NetworkProfile`;
the argument is the chain id it actually found. Working as intended. Check the
RPC URL for the alias you used — `BASE_SEPOLIA_RPC_URL` (84532) or
`ROBINHOOD_TESTNET_RPC_URL` (46630).

**`vm.prompt: IO error: not a terminal`** — the confirmation needs a real TTY.
Run it from a terminal, or set `FOLIO_SKIP_CONFIRM=true` for CI.

**`NoDeployment`** — no `deployments/<network>.json` for the chain you are on,
or no launch recorded in it yet. Run `DeployFactory`, then `CreateToken`, or
pass `FOLIO_TOKEN=0x...`. A record for the *other* chain does not count: each
network has its own file, and pointing a script at Robinhood Chain will not find
the Base Sepolia factory.

**`ReserveCapAboveDefault`** — `TOKEN_MAX_RESERVE_CAP` exceeds the platform
default. A creator may only tighten their own cap, never widen it.

**Slither can't find solc** — it needs the compiler on `PATH`, or `FOUNDRY_SOLC`
pointing at one. `solc-select install 0.8.26 && solc-select use 0.8.26`.
