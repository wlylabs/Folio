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
npm run forge:gas       # print the create-cost comparison against FolioSale
```

## Layout

| Path | What it is |
| --- | --- |
| `src/FolioFactory.sol` | Deploys launches, holds default curve terms, owns the emergency stop |
| `src/FolioToken.sol` | The cloned ERC20 + bonding curve, one instance per launch |
| `src/types/CurveConfig.sol` | The curve terms a launch is frozen to at creation |
| `src/interfaces/IFolioFactory.sol` | The slice of the factory a token reads at runtime |
| `test/FolioFactory.t.sol` | Creating launches: proxies, bounds, owner powers, gas |
| `test/FolioTrading.t.sol` | The curve: pricing, buy, sell, reserve, reentrancy, ordering |
| `test/FolioSafety.t.sol` | Pause, ownership, reserve cap, price signal, audit trail |
| `test/FolioAntiSniper.t.sol` | The opening-window per-wallet buy cap, and its limits |
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
shipped defaults (2 ETH virtual, 4 ETH threshold) that is **9x**. Raising the
virtual reserve to 6 ETH makes it 2.8x. Nothing in `FolioToken.sol` changes.

Graduation closes buying and emits `Graduated`. Selling stays open forever, and
there is no migration path to a DEX in this contract — that is a later stage.

### The opening window

The first buyer gets the lowest price the curve will ever offer. That is the
curve working, and it is also what a bot watching for `TokenCreated` is there to
collect. `sniperWindowSeconds` and `sniperMaxEthPerWallet` bound it: for that many
seconds after creation, any one address may spend at most that much across all
its buys. The shipped default is **0.1 ETH a wallet for 120 seconds**, which
against a 4 ETH graduation caps a single address at 2.5% of the whole curve
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
