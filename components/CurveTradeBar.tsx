"use client";

import { useAccount, useConfig, useReadContract, useReadContracts } from "wagmi";
import { getAccount, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { chainBySlug, explorerAddressUrl, explorerTxUrl } from "@/lib/chains";
import WalletButton from "@/components/WalletButton";
import FiatValue from "@/components/FiatValue";
import { FaucetLinks, FaucetNotice } from "@/components/Faucet";
import { useDockHeight } from "@/components/useDockHeight";
import { useGasBalance } from "@/components/useGasBalance";
import { classifyTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
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
  const [pending, setPending] = useState(false);

  const dockRef = useDockHeight();

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

  // Polls itself, so test ETH claimed from a faucet in another tab shows up
  // here without a reload. See useGasBalance.
  const {
    balance: ethBalance,
    noGas,
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

  const paused = live ? (live[0] as boolean) : stats.paused;
  const graduated = live ? (live[1] as boolean) : stats.graduated;
  const headroomWei = live ? (live[2] as bigint) : weiFromNumber(stats.headroom);
  const reserveWei = live ? (live[3] as bigint) : weiFromNumber(stats.reserve);
  const priceWei = live ? (live[4] as bigint) : weiFromNumber(stats.price);
  const soldUnits = live ? (live[5] as bigint) : 0n;

  const curveClosed = graduated || headroomWei === 0n;

  /** What this much ETH actually buys, straight from the contract. */
  const { data: buyQuote, isFetching: quotingBuy } = useReadContract({
    ...contract,
    functionName: "getBuyQuote",
    args: debouncedSpend !== null ? [debouncedSpend] : undefined,
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

  /** Wait for the receipt, then pull fresh figures for the whole page. */
  async function settle(hash: `0x${string}`, id: number, done: string) {
    setStatus({ kind: "info", message: "Transaction sent, waiting for confirmation...", tx: hash });
    const receipt = await waitForTransactionReceipt(config, { hash, chainId: id });

    if (receipt.status !== "success") {
      setStatus({ kind: "error", message: "The transaction reverted. Nothing changed.", tx: hash });
      return;
    }

    setStatus({ kind: "success", message: done, tx: hash });
    await Promise.all([refetchEth(), refetchTokens(), refetchLive()]);
    // The price history and the creator's fee balance both just changed, and
    // neither is downstream of this component or of router.refresh().
    announceTradeSettled();
    router.refresh();
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
    if (minTokensOut === null) {
      setStatus({ kind: "error", message: "Still fetching a price for that amount — try again in a second." });
      return;
    }

    setPending(true);
    try {
      const id = await prepare();
      const hash = await writeContract(config, {
        ...contract,
        functionName: "buy",
        args: [minTokensOut],
        value: spendWei,
        chainId: id,
      });
      await settle(hash, id, `Bought $${token.symbol}.`);
    } catch (err) {
      report(err, "Buy");
    } finally {
      setPending(false);
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
    if (minEthOut === null) {
      setStatus({ kind: "error", message: "Still fetching a price for that amount — try again in a second." });
      return;
    }

    setPending(true);
    try {
      const id = await prepare();
      const hash = await writeContract(config, {
        ...contract,
        functionName: "sell",
        args: [sellUnits, minEthOut],
        chainId: id,
      });
      await settle(hash, id, `Sold $${token.symbol} back to the curve.`);
      setSellTokens("");
    } catch (err) {
      report(err, "Sell");
    } finally {
      setPending(false);
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
    pending || paused || curveClosed || spendWei === null || noGas || tokensOut === null || buyTooSmall;
  const sellDisabled =
    pending ||
    paused ||
    sellUnits === null ||
    overSells ||
    noGas ||
    ethOut === null ||
    sellTooSmall ||
    tokenBalance === 0;

  return (
    <div className="trade-dock" ref={dockRef}>
      <div className="trade-dock__inner">
        <div className="tabs" role="tablist" aria-label="Trade side">
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

          <div className="tabs__aside">
            {tokenBalance !== null && <>{formatTokens(tokenBalance)} ${token.symbol}</>}
            {ethBalance && <> · {formatEth(Number(formatUnits(ethBalance.value, 18)))} ETH</>}
          </div>
        </div>

        {status && (
          <p
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
          The emergency stop halts both legs, holders included. Saying so plainly
          is the least a page owes someone who can't sell right now.
        */}
        {paused && (
          <div className="notice notice--alert" role="alert">
            <p className="notice__title">Trading is halted</p>
            <p>
              The platform emergency stop is engaged on the factory, so buying and selling are
              disabled on every Folio launch until it is released. Your tokens are untouched, and
              the creator can still be paid — only trading is frozen.
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

        {!paused && curveClosed && side === "buy" && (
          <p className="status">
            {graduated
              ? "This curve graduated — it reached its threshold and closed to buys. Selling stays open."
              : "This curve hit its ETH ceiling and is closed to buys. Selling stays open."}
          </p>
        )}

        {!stats.verified && (
          <p className="status">
            This token answers to the Folio token contract but isn&apos;t registered with the
            configured factory — treat its terms as unverified.
          </p>
        )}

        {isConnected && noGas && (
          <FaucetNotice
            chain={token.chain}
            heading={`No ${chainEntry?.chain.nativeCurrency.symbol ?? "test ETH"} in this wallet`}
            onRecheck={() => void refetchEth()}
            checking={checkingGas}
          />
        )}

        {side === "buy" ? (
          <>
            <div className="trade-row">
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
                onMax={
                  headroomWei > 0n
                    ? () => setSpendEth(trimZeros(formatEther(headroomWei)))
                    : undefined
                }
                maxLabel="Fill curve"
              />

              <div className="trade-row__action">
                {walletWaking ? (
                  <button type="button" className="btn btn--primary btn--block" disabled>
                    Reconnecting wallet...
                  </button>
                ) : isConnected ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    onClick={handleBuy}
                    disabled={buyDisabled}
                  >
                    {paused
                      ? "Trading halted"
                      : curveClosed
                        ? "Curve closed"
                        : pending
                          ? "Confirming..."
                          : buyTooSmall
                            ? "Amount too small"
                            : `Buy $${token.symbol}`}
                  </button>
                ) : (
                  <WalletButton variant="block" />
                )}
              </div>
            </div>

            <Slippage bps={slippageBps} onChange={setSlippageBps} disabled={pending} />

            <p className="trade-foot">
              {formatEth(Number(formatEther(priceWei)))} ETH{" "}
              <FiatValue eth={Number(formatEther(priceWei))} /> per token now
              {tokensOut !== null && tokensOut > 0n && (
                <>
                  {" · "}you receive ≈ {formatTokens(Number(formatUnits(tokensOut, DECIMALS)))} $
                  {token.symbol}
                </>
              )}
              {quotingBuy && tokensOut === null && <> · pricing...</>}
              {buyTooSmall && <> · too small to buy a single token unit</>}
              {minTokensOut !== null && minTokensOut > 0n && (
                <>
                  {" · "}at least {formatTokens(Number(formatUnits(minTokensOut, DECIMALS)))} or it
                  reverts
                </>
              )}
              {/*
                The curve fills to its ceiling and hands back the rest rather
                than reverting, so an over-sized buy is legal — but a buyer is
                owed the number before they sign it.
              */}
              {refund !== null && refund > 0n && (
                <> · {formatEth(Number(formatEther(refund)))} ETH refunded (ceiling reached)</>
              )}
              {ethSpent !== null && refund !== null && refund > 0n && (
                <> · {formatEth(Number(formatEther(ethSpent)))} ETH actually spent</>
              )}
            </p>
          </>
        ) : (
          <>
            <div className="trade-row">
              <Amount
                label={`Sell ($${token.symbol})`}
                value={sellTokens}
                onChange={setSellTokens}
                disabled={pending || paused}
                step="1"
                placeholder="0"
                onMax={
                  tokenBalanceRaw && tokenBalanceRaw > 0n
                    ? () => setSellTokens(trimZeros(formatUnits(tokenBalanceRaw, DECIMALS)))
                    : undefined
                }
              />

              <div className="trade-row__action">
                {walletWaking ? (
                  <button type="button" className="btn btn--primary btn--block" disabled>
                    Reconnecting wallet...
                  </button>
                ) : isConnected ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    onClick={handleSell}
                    disabled={sellDisabled}
                  >
                    {paused
                      ? "Trading halted"
                      : pending
                        ? "Confirming..."
                        : tokenBalance === 0
                          ? `No $${token.symbol} held`
                          : sellTooSmall
                            ? "Amount too small"
                            : `Sell $${token.symbol}`}
                  </button>
                ) : (
                  <WalletButton variant="block" />
                )}
              </div>
            </div>

            <Slippage bps={slippageBps} onChange={setSlippageBps} disabled={pending} />

            <p className="trade-foot">
              {ethOut !== null && ethOut > 0n ? (
                <>
                  you receive ≈ {formatEth(Number(formatEther(ethOut)))} ETH{" "}
                  <FiatValue eth={Number(formatEther(ethOut))} parens />
                  {minEthOut !== null && (
                    <>
                      {" · "}at least {formatEth(Number(formatEther(minEthOut)))} or it reverts
                    </>
                  )}
                </>
              ) : quotingSell ? (
                <>pricing...</>
              ) : sellQuoteError && sellUnits !== null ? (
                <>That&apos;s more than the curve ever issued.</>
              ) : sellTooSmall ? (
                <>That amount prices out to zero wei — try selling more.</>
              ) : (
                <>Enter an amount to see what the curve pays.</>
              )}
              {overSells && <> · more than you hold</>}
              {" · "}fee {formatBps(stats.feeBps)} per leg
            </p>
          </>
        )}

        {/*
          The reserve is the sell-back guarantee made checkable. Every token in
          circulation can be sold back into this number, so it belongs beside the
          button rather than three clicks away on an explorer.
        */}
        <p className="trade-foot">
          Reserve {formatEth(Number(formatEther(reserveWei)))} ETH{" "}
          <FiatValue eth={Number(formatEther(reserveWei))} />
          {stats.reserveCap > 0 && <> of {formatEth(stats.reserveCap)} ETH cap</>}
          {!curveClosed && headroomWei > 0n && (
            <> · {formatEth(Number(formatEther(headroomWei)))} ETH left before buys close</>
          )}
          {soldUnits > 0n && (
            <> · {formatTokens(Number(formatUnits(soldUnits, DECIMALS)))} ${token.symbol} in circulation</>
          )}
        </p>

        {isConnected && !noGas && (
          <p className="trade-foot">
            Out of test ETH? <FaucetLinks chain={token.chain} />
          </p>
        )}
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

function Amount({
  label,
  value,
  onChange,
  disabled,
  step,
  placeholder,
  hint,
  onMax,
  maxLabel = "Max",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  step: string;
  placeholder?: string;
  /** A line under the field — the typed amount in the reader's currency. */
  hint?: React.ReactNode;
  onMax?: () => void;
  maxLabel?: string;
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {onMax && (
          <button type="button" onClick={onMax} className="link-button" disabled={disabled}>
            {maxLabel}
          </button>
        )}
      </span>
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
