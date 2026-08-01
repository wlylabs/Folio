# Contracts

Two generations live here side by side.

**`FolioSale.sol`** is the retired generation: a dependency-free ERC20 that runs
its own fixed-price sale, deployed in full per launch. What was deployed of it
lives on Base Sepolia, which Folio no longer supports, so those listings are no
longer reachable from the app — the code and its toolchain stay because the
frontend still carries the reader for them (`npm run compile:contracts`,
`npm test`).

**`src/`** is the replacement: a factory that stamps out launches as EIP-1167
minimal proxies, each running a constant-product bonding curve with buying,
selling and a reserve that always covers the sell side. Built and tested with
Foundry.

```
npm run forge:build     # compile src/
npm run forge:test      # run test/*.t.sol
npm run forge:test:v4   # run test-v4/*.t.sol — the migration suite
npm run forge:gas       # print the create-cost comparison against FolioSale
```

The migration suite is a second profile because Uniswap's `PoolManager` is built
on transient storage and cannot compile at the paris this project ships at. It
gets its own directory, its own artifacts, and `evm_version = "cancun"`; nothing
Folio deploys uses transient storage, and `FolioMigrator` builds with everything
else under the default profile. Set `ROBINHOOD_MAINNET_RPC_URL` and the same
command also checks the recorded Uniswap addresses against the live chain —
without it those tests skip and say so.

## Layout

| Path | What it is |
| --- | --- |
| `src/FolioFactory.sol` | Deploys launches, holds default curve terms, owns the emergency stop |
| `src/FolioToken.sol` | The cloned ERC20 + bonding curve, one instance per launch |
| `src/FolioMigrator.sol` | Moves a graduated launch onto a locked Uniswap v4 pool |
| `src/types/CurveConfig.sol` | The curve terms a launch is frozen to at creation |
| `src/interfaces/IFolioFactory.sol` | The slice of the factory a token reads at runtime |
| `test/FolioFactory.t.sol` | Creating launches: proxies, bounds, owner powers, gas |
| `test/FolioTrading.t.sol` | The curve: pricing, buy, sell, reserve, reentrancy, ordering |
| `test/FolioSafety.t.sol` | Pause, ownership, reserve cap, price signal, audit trail |
| `test/FolioAntiSniper.t.sol` | The opening-window per-wallet buy cap, and its limits |
| `test-v4/FolioMigration.t.sol` | Migration against a locally deployed v4 `PoolManager` |
| `test-v4/FolioMigrationFork.t.sol` | The same, against the real v4 on Robinhood Chain |
| `test/folioSale.test.mjs` | Legacy in-memory-EVM tests for `FolioSale.sol` |

## How the curve prices a trade

`x * y = k`, where `x = virtualEthReserve + ethReserve` and
`y = curveSupply - tokensSold`. The ETH side is part imaginary and the token side
is entirely so — nothing is minted until someone buys, so `totalSupply()` is the
circulating supply at all times.

| Function | Direction | Includes fee? |
| --- | --- | --- |
| `getBuyPrice(tokenAmount)` | tokens → ETH to send | yes, rounded up |
| `getBuyQuote(ethIn)` | ETH → tokens, spend, refund | yes; mirrors `buy` for `msg.sender` |
| `getBuyQuoteFor(ethIn, buyer)` | the same, for a named buyer | yes; what a frontend should call |
| `getSellPrice(tokenAmount)` | tokens → ETH received | yes, net of fee |

All of them are `view`, and the two quote functions run the same internal maths
that `buy` and `sell` run, so a preview and the trade it previews cannot disagree.

`feeBps` is charged once per leg — 100 bps (1%) by default. A 1 ETH buy puts
0.99 ETH into the reserve and 0.01 ETH into the creator's claimable balance; a
sell withholds the same fraction of the payout the curve produced. Fees are never
part of `ethReserve`, so they cannot be spent on paying sellers.

### Why the reserve is always enough

Buying back every circulating token costs `(V + R) * T / S`, which reduces to `R`
exactly — the reserve, and not a wei more. Rounding on both legs is resolved in
the reserve's favour, so `k` only ever grows and the difference accumulates as
surplus. `getOutstandingSellObligation()` computes that liability the long way
round instead of returning `ethReserve`, so it is a real check rather than a
restatement, and `reserveHealthBps()` should never read below `10_000`.

### Aggression is a config number, not a curve choice

The price multiple from launch to graduation is
`((virtualEthReserve + graduationThreshold) / virtualEthReserve) ** 2`. At the
shipped defaults (5 ETH virtual, 10 ETH threshold) that is **9x**. Raising the
virtual reserve to 6 ETH makes it 2.8x. Nothing in `FolioToken.sol` changes.

Note what that formula does *not* depend on: the absolute size of either number.
Aggression is the ratio, so `2 / 4` and `5 / 10` are the same 9x curve at
different scales — the same 67% of supply sold at graduation, the same shape.
That is what lets the threshold be chosen for the size of the reserve it
accumulates without making the climb steeper for late buyers. Move one without
the other and the shape changes: `2 / 10` is 36x.

### Why the threshold is also a liquidity decision

The graduation threshold is the whole real reserve a launch ever holds, so it is
also the depth of whatever market comes after the curve. Extracting `X` ETH from
a constant-product pool of depth `D` moves the price to `((D - X) / D) ** 2`:

| Threshold | A 0.5 ETH sell | A 1 ETH sell |
| --- | --- | --- |
| 4 ETH | −23% | −44% |
| 10 ETH | −10% | −19% |
| 20 ETH | −5% | −10% |

The shipped 10 ETH is a deliberate middle: high enough that a graduated launch
is a market a person can trade in, low enough to still be reachable. Set it low
and graduation produces a pool that one ordinary sell breaks; set it very high
and nothing ever graduates. It is the number to revisit first if migration to a
DEX is ever built, because it is that pool's opening depth.

Graduation closes buying and emits `Graduated`. Selling stays open forever, and
nothing in `FolioToken` moves the reserve anywhere — unless the launch was created
with a migrator.

### Migration, and what it costs

A curve that graduates is finished: buys never reopen, so the price can only fall
from there and everyone can see the threshold coming. `FolioMigrator` is the exit
from that shape. Once a launch has graduated, anyone may call `migrate(token)`,
which takes the reserve and pairs it against freshly minted tokens in a full-range
Uniswap v4 position that this contract holds and has no function to unwind.

The pool opens at exactly the price the curve closed at. `FolioToken` sizes the
token side as `reserve / closingPrice`, always strictly less than the unsold
inventory, and the remainder is never minted. Seeding with everything unsold would
open the pool *below* the closing price — the graduation dump under a new name.

**Migration ends the sell-back guarantee, and that is not a side effect.** On the
curve, selling every circulating token back returns exactly the reserve. In a pool
it does not: an AMM position holds both sides at every price, so part of the ETH is
never reachable by sellers, and at the shipped terms the collective exit falls by
roughly a quarter. `sell()` reverts with `CurveMigrated` from then on, and
`getOutstandingSellObligation()` returns zero because the curve no longer owes
anything — the liability went to the pool with the money.

So it is opt-in and it is frozen per launch. `CurveConfig.migrator` defaults to
zero, which keeps the floor and the dead end; a launch created with zero can never
migrate, whoever asks. The address is snapshotted at creation and deliberately not
read from the factory at call time, because a swappable migrator would be a lever
that moves other people's money out of a live launch.

### Creator fees after migration

The position's principal is locked; its swap fees are not. `collectFees(token)` is
callable by anyone and pays the accrued fees to the launch's creator. Without it a
creator's income stops at graduation — exactly when a launch most needs somebody
with a reason to look after it — while the pool goes on charging its 1% into a
position nobody can reach.

That is a second `modifyLiquidity`, so it is worth being exact about why the lock
survives it:

- It passes a **literal zero**. A zero delta cannot shrink a position; the poke
  only makes the manager realise fees it already owed.
- Neither branch of `unlockCallback` takes its delta from calldata — `Provide`
  widens a `uint128`, `Collect` writes `0` — so there is no input to the contract
  that removes liquidity.
- The recipient is read off the token, never supplied by the caller, and `take`
  sends straight there. Prompting a collection is a favour to the creator and
  cannot be redirected into one for the caller.

`test_Fees_CollectingLeavesThePrincipalUntouched` holds the first of those, and
`test_Fees_AnyoneMayPromptButOnlyTheCreatorIsPaid` the third.

Fees go 100% to the creator. Folio takes no protocol cut anywhere else, and this
was not the place to introduce the first one.

One thing still deliberately absent: nothing recovers the few thousand wei of
rounding dust each migration strands in the migrator. A sweep is a withdrawal path
in a contract whose whole claim is that it has none, and dust is the cheaper side
of that trade.

### The opening window

The first buyer gets the lowest price the curve will ever offer. That is the
curve working, and it is also what a bot watching for `TokenCreated` is there to
collect. `sniperWindowSeconds` and `sniperMaxEthPerWallet` bound it: for that many
seconds after creation, any one address may spend at most that much across all
its buys. The shipped default is **0.25 ETH a wallet for 120 seconds**, which
against a 10 ETH graduation caps a single address at 2.5% of the whole curve
during the minutes a launch is being discovered.

A buy over the remaining allowance is trimmed and the excess refunded — the same
clamp-and-refund the reserve ceiling uses, because reverting would make every
opening a race that most transactions lose after paying gas. Only a wallet with
nothing left reverts, with `SniperCapReached`. Set the window to zero to switch
the whole mechanism off; that is what every launch ran under before it existed.

A creator may tighten both terms at creation, the same way they may tighten
`maxReserveCap`, through the six-argument `createToken`:

| Argument | Zero means | May move |
| --- | --- | --- |
| `maxReserveCap` | platform default | down only |
| `sniperWindowSeconds` | platform default | up only |
| `sniperMaxEthPerWallet` | platform default | down only |

The directions differ but the rule does not: **no argument to `createToken` can
make a launch riskier than the platform default.** That is what lets the default
be read as a guarantee about every launch here rather than a starting point
somebody might have negotiated away. Zero is "inherit", never "switch off", so
there is no call that removes a window the platform put there. A platform that
ships the mechanism off is the one case where a creator names a cap outright —
there is no default to be under, and `InvalidSniperCap` catches a window turned
on without one.

**This is not sybil resistance, and nothing on chain could be.** N wallets get N
caps. What it buys is that taking the opening costs a funded fleet instead of one
transaction, and that the fleet is legible afterwards in `sniperSpent` and in the
holder list. `test_Sybil_EachWalletGetsItsOwnCap` exists to keep that limitation
a tested fact rather than a caveat someone can quietly drop.

It sits outside the curve, like the fees. Clamped ETH is refunded before anything
is priced, so `k`, the reserve and the sell-back guarantee never see it, and
`reserveHealthBps()` still reads exactly `10_000`. The cost is about 417 gas on a
warm buy, paid whether or not a launch has a window configured.

## The safety layer

### One emergency stop, and what it deliberately does not reach

`pause()` on the factory halts new launches and, because every token reads
`paused()` from there, halts buying and selling everywhere. Two things stay open
on purpose:

- **`claimFees`.** The stop exists to contain a curve bug, not to withhold a
  creator's earnings. Fees live outside `ethReserve` and cannot be spent on paying
  sellers, so letting them out changes nothing about anyone's ability to exit.
- **Every view function, without exception.** A halted market is one people are
  still entitled to read — prices, reserve, solvency, their own balance. Halting
  trading and blinding holders are different things, and only the first is a
  containment measure.

### The reserve cap is the blast radius

`maxReserveCap` is the most real ETH a launch's curve will ever hold. Whatever is
wrong with the curve maths that nobody has found yet, it cannot put more than this
at risk in one launch. The platform sets a default and a creator may choose a
**lower** one at creation — never higher, so the platform ceiling always binds and
the bound can only ever be tightened by the party carrying the risk.

```solidity
factory.createToken("Name", "SYM", supply);            // platform default
factory.createToken("Name", "SYM", supply, 1 ether);   // tighter, this launch only
```

A buy that would overshoot the cap **fills to exactly the cap and refunds the
rest** rather than reverting. Both designs enforce the same invariant — the
reserve never exceeds the cap — so the choice is only about the failure mode.
Rejecting would mean nothing but an exactly-sized trade could ever land a launch on
its own ceiling: every near-cap buy would race, most would fail having paid gas,
and a launch could sit stuck below the threshold it needs to reach. The refund
makes the landing deterministic. The cost is that the refund is an ETH send, so a
contract buyer with no `receive()` cannot make an overshooting buy.

A launch's cap is frozen at creation. There is deliberately no per-launch cap
setter: retuning a live market's ceiling is a lever over people's open positions,
and it buys nothing `pause()` does not already cover.

### `LargePriceMove` signals, it does not block

When one trade moves the marginal price by at least `priceMoveAlertBps`, the token
emits `LargePriceMove`. It blocks nothing, and no code reads it. It exists so
unusual activity surfaces in a log stream without an operator having to notice it
by diffing consecutive trade prices.

Not blocking is the design, not a shortcut. On a constant-product curve a large
price move *is* a large trade, which is a thing that is supposed to be possible;
refusing those would be a reserve cap enforced badly, and the launch already has a
real one.

The move is measured against the **lower** of the two prices, so a doubling and a
halving both read `10_000` and one threshold is symmetric across both directions.
Measured against `priceBefore` instead, a fall of any size would cap out at
`10_000` and a threshold tuned for rises could never fire on a sell.

### Ownership can be handed over, never lost

`Ownable2Step` plus a disabled `renounceOwnership()`. Transfer is a proposal until
the recipient calls `acceptOwnership()` from the address in question, so naming the
wrong address costs nothing and is undone by naming another. Renouncing is closed
because the one thing it accomplishes is destroying the emergency stop forever, by
accident, in a single transaction.

There is no `AccessControl` here and it would not help: there is one privileged
actor and one class of privileged action. Fee collection is not a platform role at
all — fees are per-token and gated on the creator. `AccessControl`'s own top seat
(`DEFAULT_ADMIN_ROLE`) is a *single-step* grant, which is strictly weaker than what
is already in place. Point the owner at a multisig.

### There is no rate limiting, on purpose

Per-address-per-block trade limits were considered and rejected. An attacker
sidesteps one with a second EOA, so it stops nothing that matters while taxing
legitimate users, aggregators and routers, and costing a storage write per trade.
The manipulation it is usually reached for is not the threat model here either: a
bonding curve has no order book to spoof, and nothing reads its price as an oracle.
Sandwiching is handled where it should be — `minTokensOut` / `minEthOut` slippage
floors plus the ~2% round-trip fee spread.

That answer changes the moment anything *else* prices off this curve (a lending
market, an LP migration valuation). The right control then is a TWAP or a
same-block price snapshot, not a per-address counter.

### The audit trail

Every privileged action logs who did it and when: `EmergencyPaused` and
`EmergencyUnpaused` carry `by` and `timestamp`, `DefaultConfigUpdated` carries both
alongside the new terms, and `FeesClaimed` carries a timestamp. Ownership changes
keep OpenZeppelin's standard `OwnershipTransferStarted` / `OwnershipTransferred` —
a bespoke re-emission would only make them harder for tooling to read.

None of this prevents an exploit. It is there so that if one happens, what occurred
can be reconstructed from logs alone.

### Reentrancy, swept across functions rather than within them

Every function that moves ETH — `buy`, `sell`, `claimFees` — carries the same
`nonReentrant` guard, and `createToken` carries one for the external `initialize`
call at its end. Because it is one shared guard, a payout hook cannot re-enter a
*different* ETH-moving function than the one it came from; `FolioSafety.t.sol`
exercises those cross combinations, which a per-function review is exactly what
misses.

ERC20 `transfer` / `approve` are deliberately unguarded: they touch no ETH and
OpenZeppelin's ERC20 makes no external call, so there is nothing to re-enter. A
test pins that a transfer landing mid-payout cannot desynchronise the accounting.

`foundry.toml` sits at the repo root, because Foundry's default library directory
is `lib/` and that name is already taken by the app's TypeScript. It points `src`,
`test`, `out` and `cache` into this folder instead.

OpenZeppelin comes from npm (`@openzeppelin/contracts`,
`@openzeppelin/contracts-upgradeable`) and is remapped in `foundry.toml`, so
there is one dependency manifest rather than two. `forge-std` is a submodule, the
usual Foundry way — after a fresh clone:

```
git submodule update --init --recursive
```

`evm_version` is pinned to **paris**: no PUSH0, no transient storage, no MCOPY.
Robinhood Chain's EVM revision hasn't been confirmed against a deploy, and
nothing here needs a newer opcode, so the bytecode stays portable — which is
worth more on a mainnet than the ~2% it costs on the one-off factory deploy.

## Getting a compiler in a sandbox

`forge` is installed from npm (`@foundry-rs/forge`) rather than `foundryup`, so
`npm install` is all a normal setup needs.

In a network-restricted environment — including Claude Code's remote sandbox —
`binaries.soliditylang.org` may be unreachable, and `forge build` fails while
fetching the compiler list. GitHub releases usually still work, so drop the
binary where Foundry looks for it and build offline:

```
mkdir -p ~/.svm/0.8.26
curl -sSL -o ~/.svm/0.8.26/solc-0.8.26 \
  https://github.com/ethereum/solidity/releases/download/v0.8.26/solc-static-linux
chmod +x ~/.svm/0.8.26/solc-0.8.26
forge build --offline
```

On an unrestricted machine none of this is needed; `forge` fetches solc itself.
