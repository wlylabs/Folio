# Contracts

Two generations live here side by side.

**`FolioSale.sol`** is what is deployed on Base Sepolia today: a dependency-free
ERC20 that runs its own fixed-price sale, deployed in full per launch. The app
still reads it, so it stays until the frontend moves over. Its toolchain is
unchanged — `npm run compile:contracts`, `npm test`.

**`src/`** is the replacement: a factory that stamps out launches as EIP-1167
minimal proxies, each running a constant-product bonding curve. Built and tested
with Foundry.

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
| `test/FolioFactory.t.sol` | Foundry tests |
| `test/folioSale.test.mjs` | Legacy in-memory-EVM tests for `FolioSale.sol` |

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
