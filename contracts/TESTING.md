# Folio contracts — test suite

Stage 4. What is tested, what it found, and what is still open.

Run everything:

```bash
forge test                      # 251 tests
forge test --gas-report         # per-function gas table
forge coverage                  # coverage summary
FOUNDRY_PROFILE=deep forge test # 10k fuzz runs, 2k invariant sequences — slow
```

## Layout

| File | What it defends |
| --- | --- |
| `test/FolioFactory.t.sol` | Stage 1: creation, config validation, the registry, ownership. |
| `test/FolioTrading.t.sol` | Stage 2: the curve, buy, sell, the reserve. |
| `test/FolioSafety.t.sol` | Stage 3: the emergency stop, the cap, the price-move signal, the audit trail. |
| `test/FolioUnit.t.sol` | Happy path checked against the curve, and every edge case: zero, one wei, one unit, the ceiling, extreme creation parameters. |
| `test/FolioFuzz.t.sol` | Stateless fuzzing of both quote functions, quote-vs-settlement, and value extraction over short sequences. |
| `test/FolioInvariant.t.sol` | Stateful invariants over random call sequences. The solvency guarantee lives here. |
| `test/FolioAdversarial.t.sol` | Reentrancy, sandwiching, bank runs, griefing, access control. |
| `test/FolioIntegration.t.sol` | Full lifecycles end to end, state re-derived at every step. |
| `test/FolioGas.t.sol` | Gas measurements, including minimal proxy vs the stage-1 full deploy. |
| `test/FolioDefensiveBranches.t.sol` | The three branches ordinary use cannot reach. |
| `test/helpers/` | Shared base, the invariant handler, and the hostile counterparties. |

Two things about how the tests are written are worth knowing before reading them.

**The curve is re-implemented in the test base.** `_predictBuy` and `_predictSell` in
`helpers/FolioTestBase.sol` are written from the specification in `CurveConfig`, in plain
arithmetic, not copied from `FolioToken`. Checking the contract against its own quote
functions only proves it is self-consistent; checking it against these proves it is right.

**The invariant handler measures ETH from balance deltas**, never from the quote functions,
because quoting is itself under test. A ghost accounting built on `getBuyQuote` could not
detect a quote that lies.

## Coverage

```
| File                           | % Lines           | % Statements     | % Branches      | % Funcs         |
| contracts/src/FolioFactory.sol | 100.00% (55/55)   | 100.00% (64/64)  | 100.00% (15/15) | 100.00% (9/9)   |
| contracts/src/FolioToken.sol   | 100.00% (128/128) | 99.40% (167/168) | 96.97% (32/33)  | 100.00% (22/22) |
| Total                          | 100.00% (183/183) | 99.57% (231/232) | 97.92% (47/48)  | 100.00% (31/31) |
```

The one uncovered branch is `if (gross > ethIn) gross = ethIn;` in `_quoteBuy`. It is
unreachable — see finding 6 — and `testFuzz_TheRefundClampIsUnreachable` fails if that ever
stops being true.

Coverage is measured with the invariant suite excluded, because `forge coverage` disables the
optimiser and the invariant runs become impractically slow. The invariant suite reaches no
line the others do not; it reaches call *orders* they do not, which is not what a coverage
percentage measures.

## Findings

Nothing below has been silently patched. The two marked **open** are real and are decisions
for whoever owns this contract.

### 1. `minTokensOut = 0` loses almost everything to a sandwich — open

`test_Sandwich_Finding_AnUnprotectedBuyerIsNearlyDrained`

Against a 5 ETH buy with no slippage floor, a 20 ETH front-run leaves the victim holding
**1/41st** of the tokens they quoted, and hands the attacker **4.47 ETH** of profit — 89% of
what the victim spent. Measured, not estimated.

The severity comes from the curve's shape rather than a defect in the code. `virtualEthReserve`
defaults to 2 ETH, so a 20 ETH front-run moves the price more than tenfold and the victim buys
at the top of it. The contract prices correctly throughout, stays solvent, and every wei the
attacker gains is a wei the victim lost — the test asserts that conservation.

The mitigation already exists and works: `test_Sandwich_SlippageFloorMakesTheVictimUnsandwichable`
shows a floor taken from `getBuyQuote` repels the same attack completely. But the protection
lives entirely in the *caller's* argument. Options are to make the frontend incapable of
sending zero, to raise `virtualEthReserve` so the curve is flatter, or to reject a zero
`minTokensOut` in the contract. The third changes the contract's interface and is the only one
that protects integrators you do not control.

### 2. Graduation can be forced permanently for ~2% of the threshold — open

`test_Griefing_Finding_GraduationCanBeForcedAndIsIrreversible`

`graduated` is latched the instant the reserve touches `graduationThreshold`, and nothing ever
clears it. So anyone can buy to the threshold, be marked graduated, and sell straight back out.
Measured cost: **0.0804 ETH, or 201 bps of a 4 ETH threshold**, plus gas. The capital is needed
for one transaction only, so it is flash-loanable.

The launch is then closed to new buyers forever, with **1 wei** left in its reserve. No funds
are stolen and existing holders can still exit — but the creator's launch is dead.

Fixes each carry a trade-off: graduate on a high-water mark rather than the live reserve,
require the threshold to hold for some interval, or gate graduation on something other than an
instantaneous read. Picking between them is a design decision, so it has been left as found.

Note the hard cap does *not* have this problem — it is a live reading, not a latch, and
`test_Griefing_TheHardCapIsNotALatchAndRecovers` shows a launch recovering from being filled.

### 3. `ethHeadroom()` misreports on a graduated curve — open, frontend hazard

Same test. `ethHeadroom()` is derived from the reserve against the ceiling and knows nothing
about the `graduated` latch. On a launch that graduated and was then sold back down, it reports
**~3.99 ETH of room** on a curve that will refuse every buy.

Nothing on the trading path is wrong: `buy` reverts correctly via the latch it checks first.
But `ethHeadroom` is exactly the view a frontend reaches for to decide whether to enable a buy
button. Any caller must read `graduated()` as well. `getBuyQuote` already does, and returns a
full refund, so it is the safe thing to price against.

### 4. Splitting a buy rounds the creator's fee down twice — informational, not exploitable

`testFuzz_SplittingABuyOnlyEverRoundsTheFeeDown`

The fee is `floor(ethIn * feeBps / BPS)` per call, and `floor(a) + floor(b)` can be one less
than `floor(a + b)`. A split buy therefore pays up to **one wei** less in fees, and that wei
goes into the reserve instead.

It looks alarming in token terms — early on this curve one wei buys ~500,000 units, so the
splitter's balance is visibly larger — and it is not. The tokens are fully backed by the wei
sitting in the reserve, solvency is untouched, the cost falls on the creator's fee income, and
collecting it costs tens of thousands of gas per wei. The test pins the drift at one wei and
asserts the reserve is the only thing that gains.

### 5. Exit order redistributes heavily between holders — by design, worth knowing

`test_BankRun_ExitOrderRedistributesBetweenHoldersOnly`

Five holders each stake 0.5 ETH in sequence, then all exit in buy order:

| holder | recovered | vs stake |
| --- | --- | --- |
| 0 | 1.362 ETH | **+172%** |
| 1 | 0.523 ETH | +5% |
| 2 | 0.277 ETH | −45% |
| 3 | 0.171 ETH | −66% |
| 4 | 0.117 ETH | **−77%** |

This is not a bug and there is nothing to fix. It is what a constant-product curve with no
lock-up does — the first buyer bought at the opening price, the four behind them moved it 2.2x,
and selling first sells into that. Every AMM behaves this way.

It is in the suite because it is the difference between a property the operators chose and one
they find out about from a user. The contract is solvent throughout: the group's total shortfall
is **exactly** the fees plus rounding dust, which the test asserts as an equality, so the
redistribution is between holders and never out of the reserve.

### 6. Dead code in `_quoteBuy` — informational

`if (gross > ethIn) gross = ethIn;` cannot fire. With `E = ethIn`, `f = feeBps`, `B = BPS`, and
the clamp reachable only when `headroom = netEth - k` for `k >= 1`:

```
gross <= E  <=>  (netEth - k) * B <= E * (B - f)
```

Writing `E*f = qB + r` with `0 <= r < B`, the left side is `E*B - qB - kB` and the right is
`E*B - qB - r`, so the inequality reduces to `r <= k*B` — always true, since `r < B` and
`k >= 1`.

`testFuzz_TheRefundClampIsUnreachable` runs that proof against the fuzzer. The branch has been
left in the contract: removing a correct guard to chase a coverage percentage is a bad trade,
and it costs one comparison on a rare path.

## What held up

- **Solvency.** `reserve >= outstanding sell obligation` held across 32,768 random calls per
  invariant, through pauses, fee claims, transfers, forced ETH and full exits in every order.
  Final reserve exceeded the obligation by a handful of wei every run — surplus, as designed.
- **Exact conservation.** Every wei that entered a token is still in it, was paid to a seller,
  or was claimed by the creator. Asserted as an equality, not a bound.
- **Reentrancy.** Blocked on all three ETH exits (sell payout, buy refund, `claimFees`), against
  an attacker that retries for the whole duration of the hook rather than giving up after one
  attempt, including alternating between functions.
- **Access control.** Every privileged function refused every non-owner and non-creator. No
  function anywhere moves the reserve to a chosen address — brute-forced across a list of
  plausible names, not argued. The owner cannot touch a live launch's terms, reserve, or creator.
- **Forced ETH.** `selfdestruct` into the token changes no price, no reserve, and no fee balance.
- **Nobody gets stuck.** 100-holder bank runs in scrambled order, graduated curves, ETH-rejecting
  holders — every position remained exitable, and an ETH-rejecting holder blocks only itself.

## Gas

Measured with `gasleft()`, so these exclude the 21,000 base transaction cost and calldata.

| Operation | Gas |
| --- | --- |
| `createToken` (clone + full setup) | 306,707 |
| **`FolioSale` full deploy (stage 1)** | **926,693** |
| **saved per launch** | **619,986 (66%)** |
| bare `FolioToken` deploy, for reference | 1,807,976 |
| `FolioFactory` deploy + implementation, one-off | 2,835,297 |
| `buy`, first on a launch (all cold) | 182,284 |
| `buy`, warm | 22,896 |
| `buy`, new buyer (cold balance) | 46,796 |
| `buy`, overshoots the ceiling: clamp + refund | 59,324 |
| `sell`, partial | 20,923 |
| `sell`, full exit | 22,114 |
| `claimFees` | 40,326 |
| `transfer`, recipient warm | 4,676 |
| EIP-1167 proxy overhead, per trade | 388 |
| `LargePriceMove` signal overhead, per trade | 573 |

The clone saves 620k gas per launch against the stage-1 design and costs 388 gas per subsequent
trade — the trade-off pays for itself if a launch sees fewer than ~1,600 trades, and every launch
sees far fewer than that.

The `LargePriceMove` signal costs 573 gas per trade, which is why it was not worth making
opt-out per launch beyond the existing `priceMoveAlertBps == 0`.

## Not done here

- **Slither / static analysis.** Not run in this session.
- **External audit.** None.
- **Deployment.** Nothing has been deployed anywhere.
