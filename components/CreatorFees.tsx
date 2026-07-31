"use client";

import { useAccount, useConfig, useReadContract } from "wagmi";
import { getAccount, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { formatEther } from "viem";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import FiatValue from "@/components/FiatValue";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { chainBySlug, explorerTxUrl } from "@/lib/chains";
import { classifyTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
import { TRADE_SETTLED_EVENT } from "@/lib/tradeEvents";
import { formatBps, formatEth, type CurveStats, type Token } from "@/lib/types";

/**
 * The creator's fee balance, and the button that pays it out.
 *
 * `claimFees()` has been live on every FolioToken since the factory shipped;
 * until now the only way to call it was Basescan, which is a strange place to
 * send someone to collect money they are owed.
 *
 * Two things about it are worth saying on the page rather than leaving to the
 * contract source:
 *
 * **Fees are not the reserve.** They accrue outside `ethReserve`, so claiming
 * them cannot touch the ETH backing anyone's ability to sell. That is the whole
 * reason the fee is taken outside the curve, and it is what makes this button
 * safe to press at any time.
 *
 * **The emergency stop does not block it.** `claimFees` is deliberately not
 * gated by the platform pause — a halt freezes trading, not the creator's
 * balance. The trade panel already tells holders that; this tells the creator.
 *
 * It renders for the creator and nobody else. The address it compares against
 * is `creator()` read off the contract (via CurveStats), not `creator_wallet`
 * from the database — that column is a claim, not a proof, and this is a
 * payout.
 */

/** How often the accrued balance is re-read while the panel is open, in ms. */
const REFRESH_MS = 20_000;

type Status = { kind: "info" | "error" | "success" | "muted"; message: string; tx?: string };

export default function CreatorFees({ token, stats }: { token: Token; stats: CurveStats }) {
  const { address, isConnected, status: walletStatus } = useAccount();
  const config = useConfig();
  const router = useRouter();

  const [status, setStatus] = useState<Status | null>(null);
  const [pending, setPending] = useState(false);

  const chainEntry = chainBySlug(token.chain);
  const targetChainId = chainEntry?.chain.id;
  const contract = {
    address: token.contract_address as `0x${string}`,
    abi: FOLIO_TOKEN_ABI,
  } as const;

  const isCreator =
    Boolean(address) && address?.toLowerCase() === stats.creator.toLowerCase();

  const { data: accrued, refetch } = useReadContract({
    ...contract,
    functionName: "feesAccrued",
    chainId: targetChainId,
    query: { enabled: isCreator && Boolean(targetChainId), refetchInterval: REFRESH_MS },
  });

  // A trade in the panel below is what moves this number, so it re-reads when
  // one settles instead of waiting out the timer.
  useEffect(() => {
    if (!isCreator) return;
    const onSettled = () => void refetch();
    window.addEventListener(TRADE_SETTLED_EVENT, onSettled);
    return () => window.removeEventListener(TRADE_SETTLED_EVENT, onSettled);
  }, [isCreator, refetch]);

  // Nothing to show a reader who isn't the creator, and nothing to show while
  // wagmi is still reviving a stored session — the address it reports then is
  // real, but rendering a payout panel on a half-woken wallet invites a click
  // that cannot be signed.
  if (!isConnected || walletStatus !== "connected" || !isCreator) return null;

  const accruedWei = (accrued as bigint | undefined) ?? 0n;
  const accruedEth = Number(formatEther(accruedWei));
  const nothingToClaim = accruedWei === 0n;

  const handleClaim = async () => {
    setStatus(null);

    if (!chainEntry) {
      setStatus({
        kind: "error",
        message: `This token is on an unsupported network ("${token.chain}").`,
      });
      return;
    }

    setPending(true);
    try {
      // Same preamble the trade bar uses: prove the wallet can sign before
      // asking it to, then make sure it is pointed at the token's chain.
      await ensureWalletReady(config);

      if (getAccount(config).chainId !== chainEntry.chain.id) {
        await switchChain(config, { chainId: chainEntry.chain.id }).catch(() => {
          throw new Error(`Switch your wallet to ${chainEntry.chain.name} to claim.`);
        });
      }

      const hash = await writeContract(config, {
        ...contract,
        functionName: "claimFees",
        chainId: chainEntry.chain.id,
      });

      setStatus({ kind: "info", message: "Claim sent, waiting for confirmation...", tx: hash });
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainEntry.chain.id,
      });

      if (receipt.status !== "success") {
        setStatus({ kind: "error", message: "The claim reverted. Nothing changed.", tx: hash });
        return;
      }

      setStatus({
        kind: "success",
        message: `Claimed ${formatEth(accruedEth)} ETH.`,
        tx: hash,
      });
      await refetch();
      router.refresh();
    } catch (err) {
      console.error("Fee claim failed:", err);
      const failure = classifyTxError(err);
      setStatus({
        // Declining in the wallet is a decision, not a fault.
        kind: failure.kind === "cancelled" ? "muted" : "error",
        message: failure.message,
      });
    } finally {
      setPending(false);
    }
  };

  const statusTx = status?.tx ? explorerTxUrl(token.chain, status.tx) : null;

  return (
    <section className="factbox" aria-label="Creator fees">
      <h2 className="factbox__head">
        <span>Your fees</span>
        <span>Creator</span>
      </h2>

      <div className="factbox__row">
        <span className="factbox__label">Unclaimed</span>
        <span className="factbox__value">
          {formatEth(accruedEth)} ETH
          <FiatValue eth={accruedEth} block />
        </span>
      </div>

      <div className="factbox__row">
        <span className="factbox__label">Rate</span>
        <span className="factbox__value">{formatBps(stats.feeBps)} of every leg</span>
      </div>

      <div style={{ padding: "var(--sp-3) 0.875rem" }}>
        {status && (
          <p
            className={`status${status.kind === "error" ? " status--error" : ""}`}
            role="status"
            style={{ marginBottom: "var(--sp-3)" }}
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

        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={handleClaim}
          disabled={pending || nothingToClaim}
        >
          {pending ? "Confirming..." : nothingToClaim ? "Nothing to claim yet" : "Claim fees"}
        </button>

        <p className="field__hint" style={{ marginTop: "var(--sp-2)" }}>
          Fees sit outside the curve&apos;s reserve, so claiming them never touches the ETH
          backing your holders&apos; ability to sell
          {stats.paused
            ? " — and the platform's emergency stop halts trading, not this."
            : "."}
        </p>
      </div>
    </section>
  );
}
