"use client";

import { useAccount, useConfig, useReadContract, useReadContracts } from "wagmi";
import { getAccount, switchChain, writeContract } from "wagmi/actions";
import { formatEther, formatUnits, parseEther, parseUnits, zeroAddress } from "viem";
import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { chainBySlug, explorerAddressUrl, explorerTxUrl } from "@/lib/chains";
import WalletButton from "@/components/WalletButton";
import WalletHandoff from "@/components/WalletHandoff";
import FiatValue from "@/components/FiatValue";
import { GasNotice, fixedChainWayOut } from "@/components/GasNotice";
import { useTradeDensity } from "@/components/useTradeDensity";
import { useGasBalance } from "@/components/useGasBalance";
import { classifyTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
import { awaitReceipt } from "@/lib/receipt";
import { useTxPhase } from "@/components/useTxPhase";
import { announceTradeSettled } from "@/lib/tradeEvents";
import { formatBps, formatEth, formatTokens, type CurveStats, type Token } from "@/lib/types";

type Status = { kind: "info" | "error" | "success" | "muted"; message: string; tx?: string };
type Side = "buy" | "sell";

/** FolioToken.decimals, a constant on the contract. */
const DECIMALS = 18;

/** Basis-point denominator, the same one the contract uses. */
const BPS = 10_000n;

/** Slippage presets, in basis points. 1% is the default. */
const SLIPPAGE_PRESETS = [50, 100, 200];
const DEFAULT_SLIPPAGE_BPS = 100;

/**
 * Quick sizes for a buy, in ETH.
 *
 * Typing a decimal into a number field is the slowest thing on this panel and
 * the easiest to get wrong by an order of magnitude — on a phone, with the
 * article underneath and a keyboard over it. Three sizes and the ceiling cover
 * almost every trade anyone makes here, and the field stays for the rest.
 */
const BUY_PRESETS_ETH = ["0.01", "0.05", "0.1"] as const;

/** Quick sizes for a sell, as fractions of what the reader holds. */
const SELL_FRACTIONS = [
  { label: "25%", numerator: 1n, denominator: 4n },
  { label: "50%", numerator: 1n, denominator: 2n },
  { label: "75%", numerator: 3n, denominator: 4n },
  { label: "Max", numerator: 1n, denominator: 1n },
] as const;

/** How often the curve state and the open quote are re-read, in ms. Someone
 *  else's trade moves the price, and a stale quote is a failed transaction. */
const REFRESH_MS = 12_000;

/**
 * The trade panel for a bonding-curve launch.
 *
 * Everything priced here is priced by the contract, not by this file: the quote
 * under the amount field is `getBuyQuote`/`getSellPrice`, the same code path
 * `buy` and `sell` run, re-read whenever the amount changes and on a timer while
 * the panel is open. Nothing about the price is stored or assumed, because on a
 * curve there is no such thing as *the* price — only the price for a given size
 * at a given instant.
 *
 * That quote is also what the slippage floor is computed from. Every trade goes
 * out with a `minTokensOut`/`minEthOut`, so a price that moves between the quote
 * and the block reverts the trade instead of filling it at whatever a sandwich
 * left behind.
 */
export default function CurveTradeBar({ token, stats }: { token: Token; stats: CurveStats }) {
  const { address, isConnected, status: walletStatus } = useAccount();
  const config = useConfig();
  const router = useRouter();

  // `isConnected` is already true while wagmi is reviving a stored session, and
  // the connector it hands out until that finishes cannot sign — so a trade
  // offered here fails on signature. Only "connected" is a wallet that answers.
  const walletWaking = isConnected && walletStatus !== "connected";

  const [side, setSide] = useState<Side>("buy");
  const [spendEth, setSpendEth] = useState("0.01");
  const [sellTokens, setSellTokens] = useState("");
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [status, setStatus] = useState<Status | null>(null);

  // How much of the panel to draw. Compact keeps the trade and folds the
  // settings and the curve's accounting away — see useTradeDensity.
  const { compact, setCompact } = useTradeDensity();

  const { phase, pending, slow, begin, confirming, done, abandon } = useTxPhase();

  const chainEntry = chainBySlug(token.chain);
  const targetChainId = chainEntry?.chain.id;
  const contract = { address: token.contract_address as `0x${string}`, abi: FOLIO_TOKEN_ABI } as const;

  const spendWei = useMemo(() => toWei(spendEth), [spendEth]);
  const sellUnits = useMemo(() => toUnits(sellTokens), [sellTokens]);

  // Quotes are re-read on every keystroke otherwise, and each one is an RPC
  // round trip. A third of a second is below the threshold where a number feels
  // like it lags the field.
  const debouncedSpend = useDebounced(spendWei, 300);
  const debouncedSell = useDebounced(sellUnits, 300);

  // Polls itself, so ETH that arrives in another tab shows up here without a
  // reload. See useGasBalance.
  const {
    balance: ethBalance,
    noGas,
    unreadable: gasUnreadable,
    elsewhere: gasElsewhere,
    checking: checkingGas,
    refetch: refetchEth,
  } = useGasBalance({ address, chainId: targetChainId });

  const { data: tokenBalanceRaw, refetch: refetchTokens } = useReadContract({
    ...contract,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: targetChainId,
    query: { enabled: Boolean(address && targetChainId) },
  });

  /**
   * The live curve state, re-read on a timer.
   *
   * The server rendered this page with its own copy of these numbers, and they
   * were true when it did. They stop being true the moment anybody else trades,
   * so the panel that gates the buttons reads them itself rather than trusting
   * the props it was mounted with.
   */
  const { data: live, refetch: refetchLive } = useReadContracts({
    contracts: [
      { ...contract, functionName: "tradingPaused" },
      { ...contract, functionName: "graduated" },
      { ...contract, functionName: "ethHeadroom" },
      { ...contract, functionName: "getReserveBalance" },
      { ...contract, functionName: "currentPrice" },
      { ...contract, functionName: "tokensSold" },
    ],
    allowFailure: false,
    query: { refetchInterval: REFRESH_MS },
  });

  /**
   * The parts of the token added after the first factory shipped, read apart
   * from the batch above.
   *
   * A token cloned from an older implementation has none of these functions, and
   * folding them into a strict batch would take the whole panel down with them —
   * live price, headroom and all — over features that launch never had.
   * `allowFailure` turns each absence into what it should be: no window, and not
   * migrated.
   */
  const { data: extras } = useReadContracts({
    contracts: [
      { ...contract, functionName: "sniperWindowActive" },
      { ...contract, functionName: "sniperWindowEndsAt" },
      { ...contract, functionName: "migrated" },
    ],
    allowFailure: true,
    query: { refetchInterval: REFRESH_MS },
  });
  const windowState = extras;

  const paused = live ? (live[0] as boolean) : stats.paused;
  const graduated = live ? (live[1] as boolean) : stats.graduated;
  const headroomWei = live ? (live[2] as bigint) : weiFromNumber(stats.headroom);
  const reserveWei = live ? (live[3] as bigint) : weiFromNumber(stats.reserve);
  const priceWei = live ? (live[4] as bigint) : weiFromNumber(stats.price);
  const soldUnits = live ? (live[5] as bigint) : 0n;
  const migrated =
    extras?.[2]?.status === "success" ? extras[2].result === true : stats.migrated;
  const windowOpen = windowState?.[0]?.status === "success" && windowState[0].result === true;
  const windowEndsAt =
    windowState?.[1]?.status === "success" ? (windowState[1].result as bigint) : 0n;

  // Migration is the strongest close: `graduated` is always true alongside it,
  // but naming it here means the buy side does not depend on that coupling
  // holding forever.
  const curveClosed = graduated || migrated || headroomWei === 0n;

  /**
   * What is left of this wallet's opening-window allowance.
   *
   * Only read while the window is open — outside it the contract answers
   * `type(uint256).max`, which is true but not a number worth putting on a
   * screen. Polled on the same timer as the rest, since it falls as the wallet
   * spends and the window can close underneath it.
   */
  const { data: allowanceRaw } = useReadContract({
    ...contract,
    functionName: "sniperAllowance",
    args: address ? [address] : undefined,
    chainId: targetChainId,
    query: {
      enabled: Boolean(address && targetChainId && windowOpen),
      refetchInterval: REFRESH_MS,
    },
  });
  const allowanceWei = windowOpen && allowanceRaw !== undefined ? (allowanceRaw as bigint) : null;

  /**
   * Roughly how much of the opening window is left.
   *
   * Relative rather than a clock time, which keeps it out of locale formatting
   * and therefore out of hydration mismatches. It only renders once `live` has
   * come back from the chain, so the server never produces a competing value.
   * Accurate to within one refresh tick, which is the resolution the sentence
   * it sits in deserves.
   */
  const windowLeftLabel = useMemo(() => {
    if (!windowOpen || windowEndsAt === 0n) return null;
    const seconds = Number(windowEndsAt) - Math.floor(Date.now() / 1000);
    if (seconds <= 0) return "any moment now";
    if (seconds < 60) return `${seconds}s`;
    return `${Math.ceil(seconds / 60)} min`;
  }, [windowOpen, windowEndsAt]);

  /**
   * What this much ETH actually buys, straight from the contract.
   *
   * Quoted *for the connected wallet*, not for whoever the RPC decides the
   * caller is. Inside the opening window the answer depends on what that
   * address has already spent, so the plain `getBuyQuote` would quote a
   * different trade than the one about to be signed.
   */
  const { data: buyQuote, isFetching: quotingBuy } = useReadContract({
    ...contract,
    functionName: "getBuyQuoteFor",
    args:
      debouncedSpend !== null ? [debouncedSpend, address ?? zeroAddress] : undefined,
    chainId: targetChainId,
    query: { enabled: debouncedSpend !== null, refetchInterval: REFRESH_MS },
  });

  /** What these tokens actually pay out, net of the creator fee. Reverts when
   *  the amount exceeds what the curve ever issued, which the UI reports. */
  const {
    data: sellQuote,
    isFetching: quotingSell,
    error: sellQuoteError,
  } = useReadContract({
    ...contract,
    functionName: "getSellPrice",
    args: debouncedSell !== null ? [debouncedSell] : undefined,
    chainId: targetChainId,
    query: { enabled: debouncedSell !== null, refetchInterval: REFRESH_MS },
  });

  const tokensOut = buyQuote ? (buyQuote[0] as bigint) : null;
  const ethSpent = buyQuote ? (buyQuote[1] as bigint) : null;
  const refund = buyQuote ? (buyQuote[2] as bigint) : null;
  const ethOut = (sellQuote as bigint | undefined) ?? null;

  const tokenBalance = tokenBalanceRaw === undefined ? null : Number(formatUnits(tokenBalanceRaw, DECIMALS));
  const overSells = sellUnits !== null && tokenBalanceRaw !== undefined && sellUnits > tokenBalanceRaw;

  /**
   * The quick sizes under each field.
   *
   * Both sides get four, always — a fraction of a balance that is zero comes
   * back unpressable rather than absent, so switching tabs never moves the
   * button under the reader's thumb. `value` is the string the field would hold,
   * so a chip can also show itself as the current amount.
   */
  const buyPicks = useMemo<Pick[]>(
    () => [
      ...BUY_PRESETS_ETH.map((eth) => ({ label: `${eth} ETH`, value: eth })),
      // The ceiling, which is a size like any other: past it the curve refunds
      // the difference, so there is nothing above this worth offering.
      { label: "Fill curve", value: headroomWei > 0n ? trimZeros(formatEther(headroomWei)) : null },
    ],
    [headroomWei]
  );

  const sellPicks = useMemo<Pick[]>(
    () =>
      SELL_FRACTIONS.map(({ label, numerator, denominator }) => ({
        label,
        value:
          tokenBalanceRaw && tokenBalanceRaw > 0n
            ? trimZeros(formatUnits((tokenBalanceRaw * numerator) / denominator, DECIMALS))
            : null,
      })),
    [tokenBalanceRaw]
  );

  /**
   * Whether the quote on screen was fetched for the amount in the field.
   *
   * It is not, for the 300ms after each keystroke: the quotes are debounced and
   * the field is not. Signing in that window sends the *typed* amount with a
   * floor computed for the *previous* one — which either reverts on slippage or,
   * worse, fills at a floor far below what the trade is worth. Cheaper to hold
   * the button for a third of a second than to explain that afterwards.
   */
  const buyQuoteStale = debouncedSpend !== spendWei;
  const sellQuoteStale = debouncedSell !== sellUnits;

  /** The floor that goes on chain: the quote, less the tolerance. */
  const minTokensOut = tokensOut === null ? null : withSlippage(tokensOut, slippageBps);
  const minEthOut = ethOut === null ? null : withSlippage(ethOut, slippageBps);

  /** Common preamble: a supported chain, a live wallet, and the two pointed at each other. */
  async function prepare() {
    if (!chainEntry) {
      throw new Error(`This token is on an unsupported network ("${token.chain}").`);
    }

    // Before the chain check, because reviving a session can change the chain
    // the wallet reports — and reading it from the store rather than the render
    // closure keeps that fresh.
    await ensureWalletReady(config);

    if (getAccount(config).chainId !== chainEntry.chain.id) {
      await switchChain(config, { chainId: chainEntry.chain.id }).catch(() => {
        throw new Error(`Switch your wallet to ${chainEntry.chain.name} to trade.`);
      });
    }
    return chainEntry.chain.id;
  }

  /** Pull fresh figures for the whole page after something landed. */
  async function reread() {
    await Promise.all([refetchEth(), refetchTokens(), refetchLive()]);
    // The price history and the creator's fee balance both just changed, and
    // neither is downstream of this component or of router.refresh().
    announceTradeSettled();
    router.refresh();
  }

  /**
   * Wait for the receipt, then re-read.
   *
   * `alive` is what keeps a slow transaction from writing over a panel the
   * reader has already moved on from — see useTxPhase. A wait that runs out is
   * reported as still pending rather than as a failure: the transaction was
   * sent, and the explorer link is the honest answer.
   */
  async function settle(
    hash: `0x${string}`,
    id: number,
    succeeded: string,
    alive: () => boolean
  ) {
    setStatus({ kind: "info", message: "Sent — waiting for the chain.", tx: hash });
    const outcome = await awaitReceipt(config, { hash, chainId: id });
    if (!alive()) return;

    if (outcome.kind === "reverted") {
      setStatus({ kind: "error", message: "Reverted. Nothing changed.", tx: hash });
      return;
    }

    if (outcome.kind === "pending") {
      setStatus({
        kind: "info",
        message: "Sent, but not confirmed yet — the explorer has the truth.",
        tx: hash,
      });
      await reread();
      return;
    }

    setStatus({ kind: "success", message: succeeded, tx: hash });
    await reread();
  }

  /** Shared failure handling, so a cancelled transaction never reads as an error. */
  function report(err: unknown, label: string) {
    console.error(`${label} failed:`, err);
    const failure = classifyTxError(err);
    setStatus({
      // A wallet rejection is a decision, not a fault. It gets the quiet
      // treatment; everything else is red.
      kind: failure.kind === "cancelled" ? "muted" : "error",
      message: failure.message,
    });
  }

  const handleBuy = async () => {
    setStatus(null);
    if (spendWei === null || spendWei === 0n) {
      setStatus({ kind: "error", message: "Enter how much ETH you want to spend." });
      return;
    }
    if (minTokensOut === null || buyQuoteStale) {
      setStatus({ kind: "error", message: "Still pricing that amount — try again in a second." });
      return;
    }

    const alive = begin();
    try {
      const id = await prepare();
      const hash = await writeContract(config, {
        ...contract,
        functionName: "buy",
        args: [minTokensOut],
        value: spendWei,
        chainId: id,
      });
      if (!alive()) return;
      confirming();
      await settle(hash, id, `Bought $${token.symbol}.`, alive);
    } catch (err) {
      if (alive()) report(err, "Buy");
    } finally {
      if (alive()) done();
    }
  };

  const handleSell = async () => {
    setStatus(null);
    if (sellUnits === null || sellUnits === 0n) {
      setStatus({ kind: "error", message: `Enter how many $${token.symbol} to sell.` });
      return;
    }
    if (overSells) {
      setStatus({ kind: "error", message: `You only hold ${formatTokens(tokenBalance)} $${token.symbol}.` });
      return;
    }
    if (minEthOut === null || sellQuoteStale) {
      setStatus({ kind: "error", message: "Still pricing that amount — try again in a second." });
      return;
    }

    const alive = begin();
    try {
      const id = await prepare();
      const hash = await writeContract(config, {
        ...contract,
        functionName: "sell",
        args: [sellUnits, minEthOut],
        chainId: id,
      });
      if (!alive()) return;
      confirming();
      await settle(hash, id, `Sold $${token.symbol} back to the curve.`, alive);
      if (alive()) setSellTokens("");
    } catch (err) {
      if (alive()) report(err, "Sell");
    } finally {
      if (alive()) done();
    }
  };

  const explorer = explorerAddressUrl(token.chain, token.contract_address);
  const statusTx = status?.tx ? explorerTxUrl(token.chain, status.tx) : null;

  // A quote of zero is the contract saying the trade would revert —
  // PaymentTooSmall one way, PayoutTooSmall the other. Better to disable the
  // button and say so than to let the user pay gas to find out.
  const buyTooSmall = tokensOut !== null && tokensOut === 0n && !curveClosed;
  const sellTooSmall = ethOut !== null && ethOut === 0n;

  const buyDisabled =
    pending ||
    paused ||
    curveClosed ||
    spendWei === null ||
    noGas ||
    tokensOut === null ||
    buyQuoteStale ||
    buyTooSmall;
  const sellDisabled =
    pending ||
    paused ||
    // Selling survives graduation but not migration: the reserve has gone to
    // the pool and `sell` reverts with CurveMigrated.
    migrated ||
    sellUnits === null ||
    overSells ||
    noGas ||
    ethOut === null ||
    sellQuoteStale ||
    sellTooSmall ||
    tokenBalance === 0;

  /** What the primary button says while a transaction is in flight. */
  const busyLabel = phase === "signing" ? "Check your wallet..." : "Confirming...";

  const detailsId = useId();

  /**
   * Give up on the wait in progress, and say which wait was given up on.
   *
   * The two are not the same admission. Nothing has been signed while the
   * wallet is still being asked, so the reader is told to go dismiss it there.
   * Once it is signed the transaction is out of everyone's hands, this panel's
   * included — so the explorer link stays on screen.
   */
  const stopWaiting = () => {
    const wasSigning = phase === "signing";
    abandon();
    setStatus((prev) => ({
      kind: "muted",
      message: wasSigning
        ? "Stopped waiting on your wallet — reject the request there if it's still open."
        : "Stopped watching. If it was mined, the explorer will show it.",
      tx: wasSigning ? undefined : prev?.tx,
    }));
  };

  return (
    <div className="trade-panel">
      <div className="trade-panel__inner">
        <div className="tabs">
          <div className="tabs__list" role="tablist" aria-label="Trade side">
            <button
              type="button"
              role="tab"
              className="tab"
              aria-selected={side === "buy"}
              onClick={() => setSide("buy")}
            >
              Buy
            </button>
            <button
              type="button"
              role="tab"
              className="tab"
              aria-selected={side === "sell"}
              onClick={() => setSide("sell")}
            >
              Sell
            </button>
          </div>

          <div className="tabs__aside">
            {tokenBalance !== null && <>{formatTokens(tokenBalance)} ${token.symbol}</>}
            {ethBalance && <> · {formatEth(Number(formatUnits(ethBalance.value, 18)))} ETH</>}
          </div>

        </div>

        <div className="trade-panel__body">
          {status && (
            <p
              // Keyed on the message so each step of a trade — sent, confirming,
              // settled — mounts as its own line and plays the entry animation,
              // rather than React swapping the text inside one node and the panel
              // appearing to flicker between states.
              key={status.message}
              className={`status${status.kind === "error" ? " status--error" : ""}`}
              role="status"
            >
              {status.message}
              {statusTx && (
                <>
                  {" "}
                  <a href={statusTx} target="_blank" rel="noopener noreferrer">
                    view transaction
                  </a>
                </>
              )}
            </p>
          )}

          {/*
            A wait that has gone on too long, and the way out of it.

            One of these waits can outlast everything: a wallet reached over
            WalletConnect may never answer, and until this line existed that
            left the panel reading "Confirming..." with every control disabled
            and nothing to press but reload. Stopping does not touch the chain —
            a signed transaction stays signed — it only stops this panel waiting
            on it, and puts the buttons back.
          */}
          {slow && (
            <p className="status">
              {phase === "signing"
                ? "Your wallet hasn't answered — approve it there, or"
                : "No receipt yet — keep waiting, or"}{" "}
              <button type="button" className="link-button link-button--inline" onClick={stopWaiting}>
                stop waiting
              </button>
              .
            </p>
          )}

          {/*
            The emergency stop halts both legs, holders included. Saying so is
            the least a page owes someone who can't sell right now.
          */}
          {paused && (
            <div className="notice notice--alert" role="alert">
              <p className="notice__title">Trading is halted</p>
              <p>
                The platform emergency stop is engaged, so both legs are frozen on every Folio
                launch. Your tokens are untouched.
                {explorer && (
                  <>
                    {" "}
                    <a href={explorer} target="_blank" rel="noopener noreferrer">
                      view contract
                    </a>
                  </>
                )}
              </p>
            </div>
          )}

          {/* Migration closes both legs, so the graduated copy below — which
              promises selling stays open — would send a holder to a transaction
              that reverts. It is checked first for that reason. */}
          {!paused && migrated && (
            <p className="status">
              This launch has moved to a Uniswap v4 pool. The curve is closed both
              ways; trade the token there instead.
            </p>
          )}

          {!paused && !migrated && curveClosed && side === "buy" && (
            <p className="status">
              {graduated
                ? "Graduated — closed to buys. Selling stays open."
                : "ETH ceiling reached — closed to buys. Selling stays open."}
            </p>
          )}

          {!paused && !curveClosed && windowOpen && side === "buy" && (
            <p className="status">
              {allowanceWei === null
                ? `Opening window — every wallet has a buy cap for another ${windowLeftLabel}.`
                : allowanceWei === 0n
                  ? `Opening cap reached for this wallet. Buying reopens in ${windowLeftLabel}.`
                  : `Opening window: ${formatEth(Number(formatEther(allowanceWei)))} ETH left for this wallet, ${windowLeftLabel} to go. Anything over comes straight back.`}
            </p>
          )}

          {!stats.verified && (
            <p className="status">
              Not registered with the configured factory — treat its terms as unverified.
            </p>
          )}

          {isConnected && (noGas || gasUnreadable) && (
            <GasNotice
              chain={token.chain}
              heading={`No ${chainEntry?.chain.nativeCurrency.symbol ?? "test ETH"} here`}
              address={address}
              elsewhere={gasElsewhere}
              wayOut={fixedChainWayOut(gasElsewhere, chainEntry?.chain.name)}
              unreadable={gasUnreadable}
              onRecheck={() => void refetchEth()}
              checking={checkingGas}
            />
          )}

          {/*
            The two sides, drawn from the same three parts in the same order —
            field, quick sizes, button — so switching tabs changes the numbers
            and nothing else. Everything they share afterwards is below, printed
            once.
          */}
          {side === "buy" ? (
            <div className="trade-form">
              <div className="trade-form__amount">
                <Amount
                  label="Spend (ETH)"
                  value={spendEth}
                  onChange={setSpendEth}
                  disabled={pending || paused || curveClosed}
                  step="0.001"
                  // Straight off the field, not the quote: this is what the
                  // typed amount is worth, so it follows every keystroke rather
                  // than waiting on the debounce the RPC round trip needs.
                  hint={<FiatValue eth={spendWei === null ? null : Number(formatEther(spendWei))} />}
                />
                <QuickPicks
                  picks={buyPicks}
                  current={spendEth}
                  onPick={setSpendEth}
                  disabled={pending || paused || curveClosed}
                  label="Quick amounts to spend"
                />
              </div>

              <Action
                waking={walletWaking}
                connected={isConnected}
                onClick={handleBuy}
                disabled={buyDisabled}
                busy={pending}
                label={
                  paused
                    ? "Trading halted"
                    : curveClosed
                      ? "Curve closed"
                      : pending
                        ? busyLabel
                        : buyTooSmall
                          ? "Amount too small"
                          : `Buy $${token.symbol}`
                }
              />
            </div>
          ) : (
            <div className="trade-form">
              <div className="trade-form__amount">
                <Amount
                  label={`Sell ($${token.symbol})`}
                  value={sellTokens}
                  onChange={setSellTokens}
                  disabled={pending || paused || migrated}
                  step="1"
                  placeholder="0"
                  // The buy side prices the field; this side can only price the
                  // quote, since what the tokens are worth is the curve's answer
                  // rather than an exchange rate. Same line, same place.
                  hint={<FiatValue eth={ethOut === null ? null : Number(formatEther(ethOut))} />}
                />
                <QuickPicks
                  picks={sellPicks}
                  current={sellTokens}
                  onPick={setSellTokens}
                  disabled={pending || paused || migrated}
                  label={`Quick amounts to sell`}
                />
              </div>

              <Action
                waking={walletWaking}
                connected={isConnected}
                onClick={handleSell}
                disabled={sellDisabled}
                busy={pending}
                label={
                  paused
                    ? "Trading halted"
                    : pending
                      ? busyLabel
                      : tokenBalance === 0
                        ? `No $${token.symbol} held`
                        : sellTooSmall
                          ? "Amount too small"
                          : `Sell $${token.symbol}`
                }
              />
            </div>
          )}

          {/* The second answer for a phone whose wallet will not connect from
              the browser. Renders nothing anywhere else. */}
          {!isConnected && !walletWaking && <WalletHandoff />}

          {/*
            The quote, and the control over how much sits under it.

            This line survives compacting, so whatever it says has to be enough
            to sign on — which is why the slippage in force joins it when the
            presets are folded away. Nothing disappears without being said.
          */}
          <div className="trade-summary">
            <p className="trade-foot">
              {side === "buy" ? (
                <>
                  {formatEth(Number(formatEther(priceWei)))} ETH{" "}
                  <FiatValue eth={Number(formatEther(priceWei))} /> per token
                  {tokensOut !== null && tokensOut > 0n && (
                    <>
                      {" · "}≈ {formatTokens(Number(formatUnits(tokensOut, DECIMALS)))} $
                      {token.symbol}
                    </>
                  )}
                  {minTokensOut !== null && minTokensOut > 0n && (
                    <> · min {formatTokens(Number(formatUnits(minTokensOut, DECIMALS)))}</>
                  )}
                  {quotingBuy && tokensOut === null && <> · pricing...</>}
                  {buyTooSmall && <> · too small for one token unit</>}
                  {/*
                    The curve fills to its ceiling and hands back the rest rather
                    than reverting, so an over-sized buy is legal — but a buyer is
                    owed the number before they sign it.
                  */}
                  {refund !== null && refund > 0n && ethSpent !== null && (
                    <>
                      {" · "}
                      {formatEth(Number(formatEther(ethSpent)))} ETH spent,{" "}
                      {formatEth(Number(formatEther(refund)))} refunded at the ceiling
                    </>
                  )}
                </>
              ) : (
                <>
                  {ethOut !== null && ethOut > 0n ? (
                    <>
                      ≈ {formatEth(Number(formatEther(ethOut)))} ETH{" "}
                      <FiatValue eth={Number(formatEther(ethOut))} parens />
                      {minEthOut !== null && (
                        <> · min {formatEth(Number(formatEther(minEthOut)))}</>
                      )}
                    </>
                  ) : quotingSell ? (
                    <>pricing...</>
                  ) : sellQuoteError && sellUnits !== null ? (
                    <>More than the curve ever issued.</>
                  ) : sellTooSmall ? (
                    <>Prices out to zero — sell more.</>
                  ) : (
                    <>Enter an amount.</>
                  )}
                  {overSells && <> · more than you hold</>}
                  {" · "}fee {formatBps(stats.feeBps)} per leg
                </>
              )}
              {compact && <> · slippage {formatBps(slippageBps)}</>}
            </p>

            <button
              type="button"
              className="link-button trade-summary__toggle"
              aria-expanded={!compact}
              aria-controls={detailsId}
              onClick={() => setCompact(!compact)}
            >
              {compact ? "Details" : "Compact"}
            </button>
          </div>

          <div id={detailsId} className="trade-details" hidden={compact}>
            <Slippage bps={slippageBps} onChange={setSlippageBps} disabled={pending} />

            {/*
              The reserve is the sell-back guarantee made checkable. Every token in
              circulation can be sold back into this number, so it belongs beside the
              button rather than three clicks away on an explorer.
            */}
            <p className="trade-foot">
              Reserve {formatEth(Number(formatEther(reserveWei)))} ETH{" "}
              <FiatValue eth={Number(formatEther(reserveWei))} />
              {stats.reserveCap > 0 && <> of {formatEth(stats.reserveCap)} cap</>}
              {!curveClosed && headroomWei > 0n && (
                <> · {formatEth(Number(formatEther(headroomWei)))} ETH to the ceiling</>
              )}
              {soldUnits > 0n && (
                <> · {formatTokens(Number(formatUnits(soldUnits, DECIMALS)))} ${token.symbol} out</>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Slippage tolerance, in basis points.
 *
 * It exists because a curve reprices on every trade: the quote above was true
 * when it was fetched and may not be true in the block the transaction lands in.
 * The tolerance is what the user is willing to lose to that gap before they'd
 * rather the trade simply failed.
 */
function Slippage({
  bps,
  onChange,
  disabled,
}: {
  bps: number;
  onChange: (bps: number) => void;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState("");
  const isPreset = SLIPPAGE_PRESETS.includes(bps);

  return (
    <div
      className="font-ui"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "var(--sp-2)",
        fontSize: "var(--fs-micro)",
        color: "var(--ink-soft)",
      }}
    >
      <span>Slippage</span>
      {SLIPPAGE_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          className="chip"
          aria-pressed={bps === preset}
          disabled={disabled}
          onClick={() => {
            setCustom("");
            onChange(preset);
          }}
        >
          {formatBps(preset)}
        </button>
      ))}
      <input
        type="number"
        min="0.01"
        max="50"
        step="0.1"
        inputMode="decimal"
        placeholder={isPreset ? "custom" : formatBps(bps)}
        value={custom}
        disabled={disabled}
        onChange={(e) => {
          setCustom(e.target.value);
          const percent = Number(e.target.value);
          // Above 50% the floor stops being a protection and starts being a
          // formality, so the field refuses rather than pretending.
          if (Number.isFinite(percent) && percent > 0 && percent <= 50) {
            onChange(Math.round(percent * 100));
          }
        }}
        className="input input--compact"
        style={{ width: "5rem" }}
        aria-label="Custom slippage tolerance, in percent"
      />
      <span>%</span>
    </div>
  );
}

/**
 * One quick size. `value` is what the field would be set to, or null when there
 * is nothing to set it to — no balance to take a fraction of, no headroom left
 * on the curve — which draws the chip unpressable rather than dropping it.
 */
type Pick = { label: string; value: string | null };

/**
 * The sizes under a field.
 *
 * Chips rather than a second row of buttons: each one fills the field above it
 * and can be undone by typing, so they are shortcuts to a value, not commands
 * of their own. The one matching the field reads as pressed, which is also how
 * a reader can tell that "Max" is still max after the balance moved.
 */
function QuickPicks({
  picks,
  current,
  onPick,
  disabled,
  label,
}: {
  picks: Pick[];
  current: string;
  onPick: (value: string) => void;
  disabled?: boolean;
  /** Names the group for a screen reader, since the chips share a field. */
  label: string;
}) {
  return (
    <div className="trade-quick" role="group" aria-label={label}>
      {picks.map((pick) => (
        <button
          key={pick.label}
          type="button"
          className="chip"
          aria-pressed={pick.value !== null && pick.value === current}
          disabled={disabled || pick.value === null}
          onClick={() => pick.value !== null && onPick(pick.value)}
        >
          {pick.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The button at the end of either side.
 *
 * Shared so that buy and sell cannot drift apart: same element, same size, same
 * three states — a wallet still waking, a wallet that can sign, and no wallet
 * at all — whichever tab is open.
 */
function Action({
  waking,
  connected,
  label,
  onClick,
  disabled,
  busy,
}: {
  waking: boolean;
  connected: boolean;
  label: string;
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
}) {
  return (
    <div className="trade-form__action">
      {waking ? (
        <button type="button" className="btn btn--primary btn--block" disabled data-busy>
          Reconnecting wallet...
        </button>
      ) : connected ? (
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={onClick}
          disabled={disabled}
          // Separates "waiting on your wallet" from the several other reasons
          // this button is disabled, which otherwise look identical. Drives the
          // sweep in globals.css.
          data-busy={busy || undefined}
        >
          {label}
        </button>
      ) : (
        <WalletButton variant="block" />
      )}
    </div>
  );
}

function Amount({
  label,
  value,
  onChange,
  disabled,
  step,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  step: string;
  placeholder?: string;
  /** A line under the field — the amount in the reader's currency. */
  hint?: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        type="number"
        min="0"
        step={step}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="input input--compact"
      />
      {hint}
    </label>
  );
}

/** The quote less the tolerance — what actually goes on chain as the floor. */
function withSlippage(amount: bigint, bps: number): bigint {
  const tolerance = BigInt(Math.max(0, Math.min(10_000, Math.round(bps))));
  return (amount * (BPS - tolerance)) / BPS;
}

/** Holds a value still for `ms` after it stops changing. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);

  return settled;
}

/**
 * An ETH figure that arrived as a JavaScript number, back in wei.
 *
 * The server-rendered props carry ETH as numbers, and a curve on a billion-token
 * supply prices in the 1e-9 range — where `String(n)` is "2e-9", which
 * `parseEther` rightly refuses. Fixing the decimals first keeps the notation
 * plain. These are first-paint fallbacks only; a second later the live reads
 * replace them with the chain's own integers.
 */
function weiFromNumber(eth: number): bigint {
  if (!Number.isFinite(eth) || eth <= 0) return 0n;
  return parseEther(eth.toFixed(18));
}

/** A positive wei amount, or null if the field isn't a usable number yet. */
function toWei(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const wei = parseEther(trimmed);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

/** A positive token amount in base units, or null. */
function toUnits(input: string): bigint | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const units = parseUnits(trimmed, DECIMALS);
    return units > 0n ? units : null;
  } catch {
    return null;
  }
}

/** "101.250000000000000000" -> "101.25" */
function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}
