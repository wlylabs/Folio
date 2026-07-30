"use client";

import { useAccount, useBalance, useConfig, useReadContract } from "wagmi";
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { formatUnits, parseEther, parseUnits } from "viem";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FOLIO_SALE_ABI } from "@/lib/contracts/folioSale";
import { chainBySlug, explorerAddressUrl, explorerTxUrl } from "@/lib/chains";
import WalletButton from "@/components/WalletButton";
import { FaucetLinks, FaucetNotice } from "@/components/Faucet";
import { describeTxError } from "@/lib/txErrors";
import { formatEth, formatTokens, type SaleStats, type Token } from "@/lib/types";

type Status = { kind: "info" | "error" | "success"; message: string; tx?: string };
type Side = "buy" | "sell";

/** Matches FolioSale.decimals, a constant on the contract. */
const DECIMALS = 18;

/**
 * The sticky trade bar: buy on one tab, sell back on the other.
 *
 * Both legs read the wallet's live balances so the button can say why it is
 * disabled — no test ETH, no tokens to sell — before the user signs anything
 * and the wallet answers with a raw revert. After a confirmed trade it refreshes
 * the server component, so the sale figures above update in place instead of
 * asking the user to reload.
 */
export default function TradeBar({ token, stats }: { token: Token; stats: SaleStats }) {
  const { address, isConnected, chainId } = useAccount();
  const config = useConfig();
  const router = useRouter();

  const [side, setSide] = useState<Side>("buy");
  const [spendEth, setSpendEth] = useState(String(token.starting_price));
  const [sellTokens, setSellTokens] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [pending, setPending] = useState(false);

  const chainEntry = chainBySlug(token.chain);
  const targetChainId = chainEntry?.chain.id;
  const soldOut = stats.onChain && stats.sold >= stats.supply && stats.supply > 0;
  const buyback = stats.buyback;

  const { data: ethBalance, refetch: refetchEth } = useBalance({
    address,
    chainId: targetChainId,
    query: { enabled: Boolean(address && targetChainId) },
  });

  const { data: tokenBalanceRaw, refetch: refetchTokens } = useReadContract({
    address: token.contract_address as `0x${string}`,
    abi: FOLIO_SALE_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: targetChainId,
    query: { enabled: Boolean(address && targetChainId) },
  });

  const tokenBalance = tokenBalanceRaw === undefined ? null : Number(formatUnits(tokenBalanceRaw, DECIMALS));
  const noGas = ethBalance !== undefined && ethBalance.value === 0n;

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

  /** Common preamble: a supported chain, and the wallet pointed at it. */
  async function prepare() {
    if (!chainEntry) {
      throw new Error(`This token is on an unsupported network ("${token.chain}").`);
    }
    if (chainId !== chainEntry.chain.id) {
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
      console.error("Buy failed:", err);
      setStatus({ kind: "error", message: describeTxError(err) });
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
      console.error("Sell failed:", err);
      setStatus({ kind: "error", message: describeTxError(err) });
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
    <div
      style={{
        position: "sticky",
        bottom: 0,
        padding: "10px 20px calc(12px + env(safe-area-inset-bottom))",
        background: "var(--paper)",
        borderTop: "3px double var(--ink)",
      }}
    >
      <div style={{ display: "flex", gap: 0, marginBottom: 10, borderBottom: "1px solid var(--rule)" }}>
        <Tab active={side === "buy"} onClick={() => setSide("buy")}>
          Buy
        </Tab>
        <Tab active={side === "sell"} onClick={() => setSide("sell")}>
          Sell
        </Tab>
        <div
          className="font-ui"
          style={{
            marginLeft: "auto",
            alignSelf: "center",
            fontSize: 10,
            color: "var(--ink-soft)",
            textAlign: "right",
          }}
        >
          {tokenBalance !== null && <>you hold {formatTokens(tokenBalance)} ${token.symbol}</>}
          {ethBalance && <> · {formatEth(Number(formatUnits(ethBalance.value, 18)))} ETH</>}
        </div>
      </div>

      {status && (
        <div
          className="font-ui"
          role="status"
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            marginBottom: 8,
            color: status.kind === "error" ? "#b00020" : "var(--ink-soft)",
            wordBreak: "break-word",
          }}
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
        </div>
      )}

      {!stats.onChain && (
        <div className="font-ui" style={{ fontSize: 10.5, color: "var(--ink-soft)", marginBottom: 8 }}>
          Live sale data unavailable — this listing may predate on-chain deployment
          {explorer && (
            <>
              {" · "}
              <a href={explorer} target="_blank" rel="noopener noreferrer">
                view contract
              </a>
            </>
          )}
        </div>
      )}

      {isConnected && noGas && (
        <div style={{ marginBottom: 8 }}>
          <FaucetNotice
            chain={token.chain}
            heading={`No ${chainEntry?.chain.nativeCurrency.symbol ?? "test ETH"} in this wallet`}
          />
        </div>
      )}

      {side === "buy" ? (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <Amount
              label="SPEND (ETH)"
              value={spendEth}
              onChange={setSpendEth}
              disabled={pending || soldOut}
              step="0.0001"
            />

            {isConnected ? (
              <Action onClick={handleBuy} disabled={buyDisabled}>
                {soldOut ? "Sold out" : pending ? "Confirming..." : `Buy $${token.symbol}`}
              </Action>
            ) : (
              <div style={{ flex: 1 }}>
                <WalletButton variant="block" />
              </div>
            )}
          </div>

          <Foot>
            {token.starting_price} ETH per token
            {tokensOut !== null && tokensOut > 0 && (
              <> · you receive ≈ {formatTokens(tokensOut)} ${token.symbol}</>
            )}
          </Foot>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <Amount
              label={`SELL ($${token.symbol})`}
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

            {isConnected ? (
              <Action onClick={handleSell} disabled={sellDisabled}>
                {pending
                  ? "Confirming..."
                  : !buyback
                    ? "No buyback"
                    : tokenBalance === 0
                      ? `No $${token.symbol} held`
                      : `Sell $${token.symbol}`}
              </Action>
            ) : (
              <div style={{ flex: 1 }}>
                <WalletButton variant="block" />
              </div>
            )}
          </div>

          <Foot>
            {buyback ? (
              <>
                {formatEth(buyback.sellPrice)} ETH per token back
                {ethOut !== null && ethOut > 0 && <> · you receive ≈ {formatEth(ethOut)} ETH</>}
                {overSells && <> · more than you hold</>}
              </>
            ) : (
              <>
                This launch was deployed before the buyback existed, so its tokens can only be
                bought — there is nothing on the contract to sell them back to.
              </>
            )}
          </Foot>
        </>
      )}

      {isConnected && !noGas && (
        <div className="font-ui" style={{ fontSize: 10, color: "var(--ink-soft)", marginTop: 4 }}>
          Out of test ETH? <FaucetLinks chain={token.chain} />
        </div>
      )}
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-ui"
      style={{
        padding: "6px 14px",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--ink)" : "2px solid transparent",
        color: active ? "var(--ink)" : "var(--ink-soft)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

function Amount({
  label,
  value,
  onChange,
  disabled,
  step,
  placeholder,
  onMax,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  step: string;
  placeholder?: string;
  onMax?: () => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        className="font-ui"
        style={{
          fontSize: 9,
          letterSpacing: 1,
          color: "var(--ink-soft)",
          display: "flex",
          gap: 6,
          alignItems: "baseline",
        }}
      >
        {label}
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            className="font-ui"
            style={{
              padding: 0,
              border: "none",
              background: "none",
              color: "var(--ink)",
              fontSize: 9,
              letterSpacing: 1,
              textDecoration: "underline",
              cursor: "pointer",
            }}
          >
            MAX
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
        style={{
          width: 108,
          padding: "9px 8px",
          border: "1px solid var(--rule)",
          fontFamily: "PT Serif, serif",
          fontSize: 14,
        }}
      />
    </label>
  );
}

function Action({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="font-ui"
      style={{
        flex: 1,
        padding: "14px 0",
        background: "var(--ink)",
        color: "var(--paper)",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 1,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Foot({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-ui" style={{ fontSize: 10.5, color: "var(--ink-soft)", marginTop: 6, lineHeight: 1.5 }}>
      {children}
    </div>
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
