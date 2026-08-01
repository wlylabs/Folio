"use client";

import { useAccount, useConfig, useReadContract } from "wagmi";
import { getAccount, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { formatUnits, parseEther, parseUnits } from "viem";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FOLIO_SALE_ABI } from "@/lib/contracts/folioSale";
import { chainBySlug, explorerAddressUrl, explorerTxUrl } from "@/lib/chains";
import WalletButton from "@/components/WalletButton";
import FiatValue from "@/components/FiatValue";
import { FaucetLinks, FaucetNotice, fixedChainWayOut } from "@/components/Faucet";
import { useDockHeight } from "@/components/useDockHeight";
import { useGasBalance } from "@/components/useGasBalance";
import { classifyTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
import {
  formatEth,
  formatTokens,
  type LegacyStats,
  type OfflineStats,
  type Token,
} from "@/lib/types";

type Status = { kind: "info" | "error" | "success" | "muted"; message: string; tx?: string };
type Side = "buy" | "sell";

/** Matches FolioSale.decimals, a constant on the contract. */
const DECIMALS = 18;

/**
 * The trade panel for a listing from the retired one-contract-per-launch
 * design: fixed price, fixed buyback, no curve.
 *
 * It is kept verbatim rather than folded into the curve panel because those
 * contracts are still deployed and still hold people's ETH. A launch made under
 * the old design has no `getBuyPrice`, no slippage floor and no reserve cap to
 * show, and pretending otherwise would misdescribe what its holders own.
 */
export default function LegacySaleBar({
  token,
  stats,
}: {
  token: Token;
  stats: LegacyStats | OfflineStats;
}) {
  const { address, isConnected, status: walletStatus } = useAccount();
  const config = useConfig();
  const router = useRouter();

  // `isConnected` is already true while wagmi is reviving a stored session, and
  // the connector it hands out until that finishes cannot sign — so a buy
  // offered here fails on signature. Only "connected" is a wallet that answers.
  const walletWaking = isConnected && walletStatus !== "connected";

  const [side, setSide] = useState<Side>("buy");
  const [spendEth, setSpendEth] = useState(String(token.starting_price));
  const [sellTokens, setSellTokens] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [pending, setPending] = useState(false);

  const dockRef = useDockHeight();

  const chainEntry = chainBySlug(token.chain);
  const targetChainId = chainEntry?.chain.id;
  const soldOut = stats.onChain && stats.sold >= stats.supply && stats.supply > 0;
  const buyback = stats.kind === "legacy" ? stats.buyback : null;

  // Polls itself, so test ETH claimed from a faucet in another tab shows up
  // here without a reload. See useGasBalance.
  const {
    balance: ethBalance,
    noGas,
    unreadable: gasUnreadable,
    elsewhere: gasElsewhere,
    checking: checkingGas,
    refetch: refetchEth,
  } = useGasBalance({ address, chainId: targetChainId });

  const { data: tokenBalanceRaw, refetch: refetchTokens } = useReadContract({
    address: token.contract_address as `0x${string}`,
    abi: FOLIO_SALE_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: targetChainId,
    query: { enabled: Boolean(address && targetChainId) },
  });

  const tokenBalance = tokenBalanceRaw === undefined ? null : Number(formatUnits(tokenBalanceRaw, DECIMALS));

  const spendWei = useMemo(() => toWei(spendEth), [spendEth]);
  const sellUnits = useMemo(() => toUnits(sellTokens), [sellTokens]);

  // Mirrors the contract: tokens = value * 1e18 / price, capped at what's left.
  const tokensOut = useMemo(() => {
    if (spendWei === null) return null;
    const price = Number(token.starting_price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const wanted = Number(formatUnits(spendWei, DECIMALS)) / price;
    const available = stats.onChain ? Math.max(0, stats.supply - stats.sold) : Infinity;
    return Math.min(wanted, available);
  }, [spendWei, token.starting_price, stats]);

  /** Mirrors sell(): amount * sellPrice / 1e18. */
  const ethOut = useMemo(() => {
    if (sellUnits === null || !buyback) return null;
    return Number(formatUnits(sellUnits, DECIMALS)) * buyback.sellPrice;
  }, [sellUnits, buyback]);

  const overSells = sellUnits !== null && tokenBalanceRaw !== undefined && sellUnits > tokenBalanceRaw;

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
    await Promise.all([refetchEth(), refetchTokens()]);
    router.refresh();
  }

  function report(err: unknown, label: string) {
    console.error(`${label} failed:`, err);
    const failure = classifyTxError(err);
    setStatus({
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

    setPending(true);
    try {
      const id = await prepare();
      const hash = await writeContract(config, {
        address: token.contract_address as `0x${string}`,
        abi: FOLIO_SALE_ABI,
        functionName: "buy",
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

    setPending(true);
    try {
      const id = await prepare();
      const hash = await writeContract(config, {
        address: token.contract_address as `0x${string}`,
        abi: FOLIO_SALE_ABI,
        functionName: "sell",
        args: [sellUnits],
        chainId: id,
      });
      await settle(hash, id, `Sold $${token.symbol} back to the sale.`);
      setSellTokens("");
    } catch (err) {
      report(err, "Sell");
    } finally {
      setPending(false);
    }
  };

  const explorer = explorerAddressUrl(token.chain, token.contract_address);
  const statusTx = status?.tx ? explorerTxUrl(token.chain, status.tx) : null;

  const canSell = Boolean(buyback) && (tokenBalance === null || tokenBalance > 0) && !overSells;
  const buyDisabled = pending || soldOut || spendWei === null || noGas;
  const sellDisabled = pending || sellUnits === null || !canSell || noGas;

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
            // Keyed on the message so each step of a trade mounts as its own
            // line and plays the entry animation, rather than the text being
            // swapped inside one node and the panel appearing to flicker.
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

        {!stats.onChain && (
          <p className="status">
            Live sale data unavailable — this listing may predate on-chain deployment
            {explorer && (
              <>
                {" · "}
                <a href={explorer} target="_blank" rel="noopener noreferrer">
                  view contract
                </a>
              </>
            )}
          </p>
        )}

        {isConnected && (noGas || gasUnreadable) && (
          <FaucetNotice
            chain={token.chain}
            heading={`No ${chainEntry?.chain.nativeCurrency.symbol ?? "test ETH"} in this wallet`}
            address={address}
            elsewhere={gasElsewhere}
            wayOut={fixedChainWayOut(gasElsewhere, chainEntry?.chain.name)}
            unreadable={gasUnreadable}
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
                disabled={pending || soldOut}
                step="0.0001"
                // What the typed amount is worth, following every keystroke.
                hint={<FiatValue eth={spendWei === null ? null : Number(formatUnits(spendWei, DECIMALS))} />}
              />

              <div className="trade-row__action">
                {walletWaking ? (
                  <button type="button" className="btn btn--primary btn--block" disabled data-busy>
                    Reconnecting wallet...
                  </button>
                ) : isConnected ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    onClick={handleBuy}
                    disabled={buyDisabled}
                    // Separates "waiting on your wallet" from the other reasons
                    // this button is disabled. Drives the sweep in globals.css.
                    data-busy={pending || undefined}
                  >
                    {soldOut ? "Sold out" : pending ? "Confirming..." : `Buy $${token.symbol}`}
                  </button>
                ) : (
                  <WalletButton variant="block" />
                )}
              </div>
            </div>

            <p className="trade-foot">
              {token.starting_price} ETH <FiatValue eth={Number(token.starting_price)} /> per token
              {tokensOut !== null && tokensOut > 0 && (
                <> · you receive ≈ {formatTokens(tokensOut)} ${token.symbol}</>
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
                disabled={pending || !buyback}
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
                  <button type="button" className="btn btn--primary btn--block" disabled data-busy>
                    Reconnecting wallet...
                  </button>
                ) : isConnected ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    onClick={handleSell}
                    disabled={sellDisabled}
                    data-busy={pending || undefined}
                  >
                    {pending
                      ? "Confirming..."
                      : !buyback
                        ? "No buyback"
                        : tokenBalance === 0
                          ? `No $${token.symbol} held`
                          : `Sell $${token.symbol}`}
                  </button>
                ) : (
                  <WalletButton variant="block" />
                )}
              </div>
            </div>

            <p className="trade-foot">
              {buyback ? (
                <>
                  {formatEth(buyback.sellPrice)} ETH <FiatValue eth={buyback.sellPrice} /> per token
                  back
                  {ethOut !== null && ethOut > 0 && (
                    <>
                      {" · "}you receive ≈ {formatEth(ethOut)} ETH <FiatValue eth={ethOut} parens />
                    </>
                  )}
                  {overSells && <> · more than you hold</>}
                </>
              ) : (
                <>
                  This launch was deployed before the buyback existed, so its tokens can only be
                  bought — there is nothing on the contract to sell them back to.
                </>
              )}
            </p>
          </>
        )}

        {isConnected && !noGas && (
          <p className="trade-foot">
            Out of test ETH? <FaucetLinks chain={token.chain} />
          </p>
        )}
      </div>
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
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {onMax && (
          <button type="button" onClick={onMax} className="link-button">
            Max
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
