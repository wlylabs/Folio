# Deploying Folio

One network. Folio launches on Robinhood Chain and nowhere else:

| Network | Chain id | RPC alias | Deployment record | Explorer | Funds |
| --- | --- | --- | --- | --- | --- |
| Robinhood Chain | 4663 | `robinhood-mainnet` | `deployments/robinhood-mainnet.json` | Blockscout | **Real ETH** |

Every script reverts with `WrongNetwork` before signing anything if
`block.chainid` is not 4663, and `foundry.toml` resolves no other alias, so a
hand-typed `--rpc-url` cannot route a deploy to a second network.

**Robinhood Chain is a mainnet, and there is no longer a testnet to rehearse
on.** Folio ran on Base Sepolia alongside it until that chain was removed; every
alias, record, workflow and faucet link that went with it is gone. The guard is
about *which* chain, not how much a mistake costs there, so what protects a
deploy is the confirmation banner — it prints the network name and chain id and
blocks until you type `yes`. Read it.

**Rehearse against a local fork instead.** `anvil --fork-url
$ROBINHOOD_MAINNET_RPC_URL` serves chain id 4663, so the same scripts, the same
network guard and the same deployment record path all apply, and nothing is
broadcast to the real chain:

```bash
anvil --fork-url $ROBINHOOD_MAINNET_RPC_URL          # in one terminal
forge script contracts/script/DeployFactory.s.sol:DeployFactory \
  --rpc-url http://127.0.0.1:8545 --broadcast -vvv   # in another
```

**One set of scripts serves the chain.** The chain is chosen by `--rpc-url`
alone, and everything chain-shaped — the record path, the explorer links, the
banner — comes from the `NetworkProfile` in
`contracts/script/FolioScript.sol`. Adding a chain means adding a profile there
and an alias in `foundry.toml`, nothing else.

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
| `DEPLOYER_PRIVATE_KEY` | Signs deploys and trades. It holds real ETH and ends up owning the factory's emergency stop, so there is no throwaway version of it — see section 3. |
| `ROBINHOOD_MAINNET_RPC_URL` | Defaults to the public endpoint, which is rate-limited but works. |
| `BLOCKSCOUT_API_KEY` | Normally empty — Blockscout needs no key. It exists because `foundry.toml` wants the field. |

There is no faucet to fund the deployer from: gas here is bought or bridged.
Fund it with the deploy cost and little more.

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

## 3. Deploy to Robinhood Chain (mainnet)

Robinhood Chain is an Arbitrum Orbit L2, EVM-compatible, ETH for gas.

**This chain holds real money.** Gas is paid in real ETH, the factory you deploy
is one real buyers can trade against, and nothing here is undoable. There is no
testnet run to do first any more — prove the change against a local fork (see
the top of this document) and decide the curve terms deliberately rather than
inheriting the script's defaults, which were chosen back when Folio had a chain
that handed out its ETH for free.

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

**3. Point `ROBINHOOD_MAINNET_RPC_URL` at the chain.** The public endpoint in
`.env.example` is rate-limited but works for one deploy; use a dedicated
provider endpoint for anything repeated.

Confirm the URL before spending a deploy on it — 4663 and Robinhood's own
testnet 46630 are one keystroke apart:

```bash
cast chain-id --rpc-url $ROBINHOOD_MAINNET_RPC_URL     # must print 4663
```

**4. Fund the deployer.** There is no faucet. The key in `.env` has to hold real
ETH, and it owns the factory's emergency stop afterwards, so it is never a
throwaway key — fund it with the deploy cost and little more, and prefer the CI
workflow (which reads the key from a GitHub Environment) over a plaintext key on
a laptop for anything beyond a one-off.

**5. Choose the curve terms.** `FACTORY_VIRTUAL_ETH_RESERVE`,
`FACTORY_MAX_RESERVE_CAP` and `FACTORY_GRADUATION_THRESHOLD` default to 2, 5 and
4 ETH. Those numbers were picked for a chain whose ETH was free. Set them in
`.env` for what you actually want a launch on this chain to be; the dry run
below prints all five.

**6. Dry run.** Simulates against real chain state and broadcasts nothing. The
network guard runs here — a wrong RPC fails at this step rather than at signing.

```bash
forge script contracts/script/DeployFactory.s.sol:DeployFactory \
  --rpc-url robinhood-mainnet -vvv
```

The banner must read **Robinhood Chain (MAINNET - real funds) / 4663**. If it
says anything else, stop: the RPC is not the chain you think it is.

**7. Deploy.** The confirmation prompt is the last gate — it prints the network,
the chain id, the deployer and its balance, and waits for `yes`. Anything else
aborts before signing.

```bash
npm run deploy:robinhood-mainnet
```

or spelled out — note the two extra verification flags:

```bash
forge script contracts/script/DeployFactory.s.sol:DeployFactory \
  --rpc-url robinhood-mainnet --broadcast \
  --verify --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  -vvv
```

It then:

- deploys `FolioFactory`, whose constructor also deploys the shared `FolioToken`
  implementation — so the factory can never point at a foreign implementation;
- verifies both on Blockscout;
- writes `deployments/robinhood-mainnet.json`.

Do not set `FOLIO_SKIP_CONFIRM` here. It exists for the CI workflow, where the
decision was already made by an environment reviewer.

**8. Commit the deployment record.**

```bash
git add deployments/robinhood-mainnet.json
git commit -m "chore: record Robinhood Chain deployment"
```

That file is how the frontend and every interaction script find the factory —
the address is never hardcoded and never passed on a command line.

```json
{
  "network": "robinhood-mainnet",
  "chainId": 4663,
  "factory": "0x...",
  "implementation": "0x...",
  "owner": "0x...",
  "deployer": "0x...",
  "deployedAtBlock": 12345678,
  "explorer": "https://robinhoodchain.blockscout.com",
  "lastToken": "",
  "defaultConfig": { "...": "..." }
}
```

`deployedAtBlock` is the chain head at simulation time, a block or two before
the deploy actually lands — a safe lower bound to start an indexer from, not an
exact receipt. Wei values are strings, because they exceed 2^53 and would lose
precision the moment JavaScript parsed them.

### Verifying on Blockscout

Foundry's default verifier is Etherscan, and Robinhood Chain is not on
Etherscan's v2 API, so `--verify` alone is not enough: `--verifier blockscout`
selects the provider and `--verifier-url` points at this chain's instance. The
`/api/` suffix is part of it — Blockscout serves its Etherscan-compatible
endpoint there, and the bare explorer URL will not work.

`foundry.toml` already carries the URL under `[etherscan] robinhood-mainnet`,
but the *provider* is a command-line choice, which is why the flag is still
needed. Blockscout requires no API key; `BLOCKSCOUT_API_KEY` stays empty unless
the instance starts asking for one.

### If verification fails

The deploy still succeeded — verification is a separate call to Blockscout, and
the contract is on chain either way. Retry against the recorded address without
redeploying:

```bash
forge verify-contract <FACTORY_ADDRESS> \
  contracts/src/FolioFactory.sol:FolioFactory \
  --chain-id 4663 --watch \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ \
  --constructor-args $(cast abi-encode \
    "constructor(address,(uint256,uint256,uint256,uint16,uint16))" \
    <OWNER> "(2000000000000000000,5000000000000000000,4000000000000000000,100,10000)")
```

### Redeploying

Running the deploy again produces a **second, independent factory** — nothing
mutates a live one, and the first keeps running on chain holding whatever
reserves it holds. The JSON record is overwritten, so the previous address
survives only in git history. The script prints the address it is about to
replace as part of the confirmation.

### Deploying from CI (GitHub Actions)

`.github/workflows/deploy-robinhood-mainnet.yml` runs the same script from CI,
for when the deployer key should live in a secret store rather than on
somebody's laptop. It is `workflow_dispatch` only — there is no push or schedule
trigger, because re-running it deploys a second factory (see *Redeploying*
above) — and it additionally requires typing `deploy to mainnet` into the
`confirm` input.

Configure it once, on a **`robinhood-mainnet` environment** rather than at
repository level — that is what lets you require a reviewer before a run
proceeds, which is the human gate that replaces the interactive confirmation a
workflow has no stdin for:

| Secret | |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | 0x-prefixed. `vm.envUint` cannot parse it otherwise. Holds real ETH and ends up owning the emergency stop. |
| `ROBINHOOD_MAINNET_RPC_URL` | Resolves the `robinhood-mainnet` alias in `foundry.toml`. |

No verification secret: Blockscout needs no API key, so turning the run's
`verify` input on adds nothing to check.

The curve terms default to the same numbers the script uses. Override any of
them with repository *variables* named `FACTORY_VIRTUAL_ETH_RESERVE`,
`FACTORY_MAX_RESERVE_CAP`, `FACTORY_GRADUATION_THRESHOLD`, `FACTORY_FEE_BPS`,
`FACTORY_PRICE_MOVE_ALERT_BPS`; only the ones you set are passed through, since
an empty value is not the same as an unset one to `vm.envOr`. On this chain they
are real amounts — set them.

Three things the workflow does that are worth knowing when reading a failed run:

- **The RPC is checked against the chain before anything is signed.** A secret
  that answers HTML, 404s, or belongs to another chain fails the preflight in
  one readable line instead of inside a simulation trace.
- **A failure after the broadcast does not discard the address.** Verification
  is flaky often enough that treating it as fatal would lose the record of a
  factory that already exists on chain. The deploy step is allowed to fail, the
  record is written to the job summary and to a run artifact, and the job is
  only marked failed at the very end. If verification is what broke, retry it
  with `forge verify-contract` as above — no redeploy.
- **A stale record is never reported as this run's.** The workflow hashes
  `deployments/robinhood-mainnet.json` before deploying and compares afterwards,
  so a run that fails before broadcasting says it deployed nothing instead of
  echoing the previously committed address.

On success it commits the updated `deployments/robinhood-mainnet.json` back to
the branch it ran on, which is what `deployments/.gitkeep` asks for. Against a
protected branch the push is refused; the run warns and leaves the file in its
artifact for you to commit.

### Interacting

Every script in section 4 takes `--rpc-url robinhood-mainnet` and needs no other
change. They read `deployments/robinhood-mainnet.json`, so a script can only act
on a launch made on the chain it is pointed at.

Each of them spends real ETH, `Buy.s.sol` most obviously.

```bash
forge script contracts/script/CreateToken.s.sol:CreateToken \
  --rpc-url robinhood-mainnet --broadcast -vvv
```

### Gas

Per-operation EVM gas is what the bytecode costs — the contracts read no chain
id and use no post-Merge opcode. What sits around it is the L2 fee: Robinhood
Chain is an Orbit L2 and its transaction cost carries an L1 data component, so
compare total fees paid rather than the `Gas used` figure the scripts print.

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

## 4. Manual interaction scripts

Run these one at a time from the CLI to verify the contracts behave on a real
chain before any frontend is wired up. Each prints the network banner and waits
for `yes`. Each acts on `FOLIO_TOKEN` if set, otherwise on the last launch
recorded in `deployments/robinhood-mainnet.json`.

Add `--broadcast` to actually send; leave it off for a dry run.

### `CreateToken` — launch a token

```bash
TOKEN_NAME="Midnight Kettle" TOKEN_SYMBOL=KETL TOKEN_SUPPLY=1000000 \
forge script contracts/script/CreateToken.s.sol:CreateToken \
  --rpc-url robinhood-mainnet --broadcast -vvv
```

Prints the new address, gas used, opening price, market cap, fee, reserve cap
and graduation threshold, plus a Blockscout link — and confirms the factory's
`isFolioToken` registry recognises it. Records it as `lastToken`, so everything
below runs with no arguments.

Optional `TOKEN_MAX_RESERVE_CAP` tightens this launch's blast radius below the
platform default. The factory rejects anything larger.

### `Buy` — buy off the curve

```bash
BUY_ETH=10000000000000000 \
forge script contracts/script/Buy.s.sol:Buy \
  --rpc-url robinhood-mainnet --broadcast -vvv
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
  --rpc-url robinhood-mainnet --broadcast -vvv
```

`SELL_BPS` is a fraction of the current balance (default half), which stays
correct whatever the previous buy returned. `SELL_TOKENS` sets an exact amount
instead. Prints what the curve paid *and* the wallet delta after gas — on a
the gap between those two is the whole reason a sell can look like it
lost money.

### `CheckReserve` — solvency inspector (read-only)

```bash
forge script contracts/script/CheckReserve.s.sol:CheckReserve --rpc-url robinhood-mainnet
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
forge script contracts/script/Pause.s.sol:Pause   --rpc-url robinhood-mainnet --broadcast -vvv
forge script contracts/script/Unpause.s.sol:Unpause --rpc-url robinhood-mainnet --broadcast -vvv
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

These are pinned to `--rpc-url robinhood-mainnet`, the only chain there is.
Each one still prints the network banner and waits for `yes` before it spends
anything — every trade they make settles in real ETH.

---

## 5. Manual testing checklist

Work top to bottom. Tick each before wiring up the frontend.

### Deployment

- [ ] `forge test` passes.
- [ ] `npm run slither` reports only the one known informational finding.
- [ ] Dry run (no `--broadcast`) completes without reverting.
- [ ] Deploy confirmation banner shows the chain you meant — **Robinhood Chain (MAINNET - real funds) / 4663** — and the expected deployer.
- [ ] Answering anything other than `yes` aborts and broadcasts nothing.
- [ ] Factory and implementation both show **verified** on Blockscout.
- [ ] `deployments/robinhood-mainnet.json` exists, has the right `chainId`, and is committed.
- [ ] `factory.owner()` is the address you intended.
- [ ] `factory.renounceOwnership()` reverts with `RenounceDisabled` — try it from Blockscout's write tab.

### Launching

- [ ] `CreateToken` succeeds; the address appears on Blockscout.
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
- [ ] `claimFees` still works while paused (call it from the creator wallet on Blockscout).
- [ ] `Unpause` restores trading; a `Buy` afterwards succeeds.

### Graduation (optional — needs ~4 ETH of buys, at real cost)

- [ ] Buying past `graduationThreshold` emits `Graduated` and sets `graduated`.
- [ ] Further buys revert with `CurveClosed`.
- [ ] **Selling still works after graduation.** It is never closed by anything but the pause.

### Before the frontend

- [ ] Every address the frontend needs comes from `deployments/robinhood-mainnet.json`, not a literal.
- [ ] `.env` is gitignored and `.env.example` carries no real values.
- [ ] No private key appears in shell history, a script, or a commit.
- [ ] `getBuyQuote` / `getSellPrice` on chain agree with what the scripts settled — the preview and the settlement run the same code path, so they must.

---

## 6. Wiring the frontend

The frontend reads `deployments/robinhood-mainnet.json` directly — `lib/contracts/deployment.ts`
is the only module that knows an address, and every page goes through it. A
re-deploy is therefore: run `DeployFactory`, commit the JSON it rewrote, push.
Nothing else changes.

### What to check after a re-deploy

- [ ] `deployments/robinhood-mainnet.json` is committed, and `factory` is the new address.
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
| `GOOGLE_SITE_VERIFICATION` | The `content` value from Search Console's HTML-tag method. Renders the verification `<meta>` in `<head>`. Server-only. |
| `NEXT_PUBLIC_FACTORY_ADDRESS` | Point a preview build at a different factory without editing the repo. Overrides the JSON. |
| `SUPABASE_SERVICE_ROLE_KEY` | Let the indexer write as the service role. Server-only — it bypasses row level security. |
| `INDEXER_SECRET` | Require `Authorization: Bearer <secret>` on `/api/indexer`. Set it on anything public. |
| `INDEXER_FROM_BLOCK` | Override the indexer's scan floor. |
| `COINGECKO_API_KEY` | Use a CoinGecko Pro plan for `/api/eth-price` instead of the free public endpoint. Server-only. |

### Keeping the feed in step with the chain

A token created by `CreateToken.s.sol`, or straight from Blockscout, has no
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

## 7. Search indexing

A Folio listing is an article, which is the one thing this launchpad has that a
chart with a buy button does not: substantive text a search engine can index.
The plumbing for that is already in the app, but two of the pieces only work on
a real domain.

### Before the first production deploy

- [ ] **Set `NEXT_PUBLIC_SITE_URL`** to the real origin, with no trailing slash.
      This is the single setting that matters most here. Unset, a production
      deploy falls back to `VERCEL_PROJECT_PRODUCTION_URL` — the project's
      stable alias, which is a serviceable canonical — and then to `VERCEL_URL`,
      which is not: it changes on every push, Vercel serves those hosts with
      `X-Robots-Tag: noindex`, and a canonical pointing at a noindex URL tells
      Google to drop the page that named it.
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

Verify the property with the HTML-tag method: Search Console → add property →
URL prefix → HTML tag, copy the `content` value into `GOOGLE_SITE_VERIFICATION`,
redeploy, then click Verify. A `*.vercel.app` host cannot be verified by DNS —
the zone is Vercel's, not yours — so on a preview domain this is the only method
that works.

### When the site is not in Google

Nothing here is a bug to fix in the app; it is a checklist to walk, in order.
`site:your-domain` returning nothing is the normal state of a site that has
never been submitted, not a symptom.

- [ ] **Is it submitted?** Google does not find a new site on its own for weeks
      or months. A site with no inbound links has nothing pointing a crawler at
      it. Search Console + a sitemap submission is the only fast path, and until
      that is done every other item below is moot.
- [ ] **Is the deploy public?** Vercel's Deployment Protection (Project →
      Settings → Deployment Protection) answers `401` to anyone without a
      session, crawlers included. Standard Protection covers preview deploys;
      if it is set to protect production too, Googlebot sees a login wall.
      Fetch the URL with `curl -I` from outside any logged-in browser and
      confirm a `200`.
- [ ] **Does the served host advertise itself?** `curl -s <origin>/robots.txt`
      and read the `Sitemap:` line: it must name the host you want indexed. If
      it names a per-deploy `*-git-*.vercel.app`, `NEXT_PUBLIC_SITE_URL` is
      unset and the fallback is doing the naming.
- [ ] **Does the response carry `X-Robots-Tag: noindex`?** `curl -I` again.
      Vercel adds it to preview and per-deploy URLs. It cannot be removed from
      those hosts — it is the reason a production alias or a real domain is
      worth having, and the reason a canonical must never point at one.
- [ ] **Then wait.** Indexing after a valid submission is days, not minutes, and
      Google indexes a subset of what it crawls. Use Search Console's URL
      Inspection on one listing to see what it actually decided, rather than
      inferring from an empty `site:` search.

A `*.vercel.app` subdomain is a weak SEO host regardless: it is shared,
unrelated projects on it get penalised, and none of its reputation is yours. A
domain you own is the single biggest improvement available here — and moving
later means redirects and re-verification, which is cheaper to skip by moving
early.

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
the argument is the chain id it actually found. Working as intended. Check
`ROBINHOOD_MAINNET_RPC_URL`, which must answer 4663.

**`vm.prompt: IO error: not a terminal`** — the confirmation needs a real TTY.
Run it from a terminal, or set `FOLIO_SKIP_CONFIRM=true` for CI.

**`NoDeployment`** — no `deployments/<network>.json` for the chain you are on,
or no launch recorded in it yet. Run `DeployFactory`, then `CreateToken`, or
pass `FOLIO_TOKEN=0x...`. Each network has its own file, so a record written
against one chain is never found from another.

**`ReserveCapAboveDefault`** — `TOKEN_MAX_RESERVE_CAP` exceeds the platform
default. A creator may only tighten their own cap, never widen it.

**Slither can't find solc** — it needs the compiler on `PATH`, or `FOUNDRY_SOLC`
pointing at one. `solc-select install 0.8.26 && solc-select use 0.8.26`.
