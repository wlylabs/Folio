# Contracts

Two generations live here side by side.

**`FolioSale.sol`** is what is deployed on Base Sepolia today: a dependency-free
ERC20 that runs its own fixed-price sale, deployed in full per launch. The app
still reads it, so it stays until the frontend moves over. Its toolchain is
unchanged — `npm run compile:contracts`, `npm test`.

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
| `test/folioSale.test.mjs` | Legacy in-memory-EVM tests for `FolioSale.sol` |

## How the curve prices a trade

`x * y = k`, where `x = virtualEthReserve + ethReserve` and
`y = curveSupply - tokensSold`. The ETH side is part imaginary and the token side
is entirely so — nothing is minted until someone buys, so `totalSupply()` is the
circulating supply at all times.

| Function | Direction | Includes fee? |
| --- | --- | --- |
| `getBuyPrice(tokenAmount)` | tokens → ETH to send | yes, rounded up |
| `getBuyQuote(ethIn)` | ETH → tokens, spend, refund | yes; mirrors `buy` exactly |
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
Robinhood Chain's EVM revision isn't known yet and nothing here needs a newer
opcode, so the bytecode stays portable.

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
