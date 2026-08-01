"use client";

import {
  useAccount,
  useConfig,
  useReadContract,
  useReadContracts,
  useSimulateContract,
} from "wagmi";
import { getAccount, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { formatEther, formatUnits, zeroAddress } from "viem";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import FiatValue from "@/components/FiatValue";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { FOLIO_MIGRATOR_ABI } from "@/lib/contracts/folioMigrator";
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

  /**
   * Whether this launch has moved to a pool, and which contract holds it.
   *
   * Read with `allowFailure`: a token cloned from an implementation older than
   * migration answers neither call, and that is a launch which simply never
   * migrates rather than a panel that should break.
   */
  const { data: migrationState } = useReadContracts({
    contracts: [
      { ...contract, functionName: "migrated" },
      { ...contract, functionName: "migrator" },
    ],
    allowFailure: true,
    query: { enabled: isCreator && Boolean(targetChainId), refetchInterval: REFRESH_MS },
  });

  const migrated =
    migrationState?.[0]?.status === "success" && migrationState[0].result === true;
  const migratorAddress =
    migrationState?.[1]?.status === "success"
      ? (migrationState[1].result as `0x${string}`)
      : undefined;
  const hasMigrator = Boolean(migratorAddress) && migratorAddress !== zeroAddress;

  /**
   * What the pool owes this creator right now.
   *
   * There is no view for it: fees live in the position and only become a number
   * when `modifyLiquidity` realises them, which is a write. So the amount is read
   * by simulating the collect — `eth_call` runs the same code and hands back the
   * return values without sending anything.
   *
   * The simulation reverts with `NothingToCollect` when the position has earned
   * nothing since the last collection, which is the ordinary state most of the
   * time. That is why `retry` is off and why a failure here reads as zero rather
   * than as an error worth showing anybody.
   */
  const { data: poolFeeSim, refetch: refetchPoolFees } = useSimulateContract({
    address: migratorAddress,
    abi: FOLIO_MIGRATOR_ABI,
    functionName: "collectFees",
    args: [contract.address],
    account: address,
    chainId: targetChainId,
    query: {
      enabled: isCreator && migrated && hasMigrator && Boolean(targetChainId),
      refetchInterval: REFRESH_MS,
      retry: false,
    },
  });

  const [poolEthWei, poolTokenUnits] = (poolFeeSim?.result as
    | readonly [bigint, bigint]
    | undefined) ?? [0n, 0n];

  /**
   * The pool's swap fee, which is not the curve's fee.
   *
   * `stats.feeBps` is what the curve charged per leg; this is what the migrated
   * pool charges per swap, and it is set on the migrator rather than the token.
   * They happen to both be 1% at the shipped defaults, which is exactly why the
   * wrong one would never look wrong.
   *
   * v4 states fees in hundredths of a bip, so 10_000 here is 100 bps.
   */
  const { data: poolFeeRaw } = useReadContract({
    address: migratorAddress,
    abi: FOLIO_MIGRATOR_ABI,
    functionName: "poolFee",
    chainId: targetChainId,
    query: { enabled: migrated && hasMigrator && Boolean(targetChainId) },
  });
  const poolFeeBps =
    poolFeeRaw === undefined ? null : Number(poolFeeRaw as number | bigint) / 100;

  // A trade in the panel below is what moves this number, so it re-reads when
  // one settles instead of waiting out the timer.
  useEffect(() => {
    if (!isCreator) return;
    const onSettled = () => {
      void refetch();
      void refetchPoolFees();
    };
    window.addEventListener(TRADE_SETTLED_EVENT, onSettled);
    return () => window.removeEventListener(TRADE_SETTLED_EVENT, onSettled);
  }, [isCreator, refetch, refetchPoolFees]);

  // Nothing to show a reader who isn't the creator, and nothing to show while
  // wagmi is still reviving a stored session — the address it reports then is
  // real, but rendering a payout panel on a half-woken wallet invites a click
  // that cannot be signed.
  if (!isConnected || walletStatus !== "connected" || !isCreator) return null;

  const accruedWei = (accrued as bigint | undefined) ?? 0n;
  const accruedEth = Number(formatEther(accruedWei));
  const nothingToClaim = accruedWei === 0n;

  const poolEth = Number(formatEther(poolEthWei));
  const poolTokens = Number(formatUnits(poolTokenUnits, 18));
  const nothingToCollect = poolEthWei === 0n && poolTokenUnits === 0n;

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

  /**
   * The same shape as the claim above, pointed at the migrator instead.
   *
   * Anyone may call this — the recipient is read off the token, not off the
   * caller — but the creator is the one with a reason to, so this is where the
   * button lives.
   */
  const handleCollect = async () => {
    setStatus(null);

    if (!chainEntry || !migratorAddress) {
      setStatus({
        kind: "error",
        message: `This token is on an unsupported network ("${token.chain}").`,
      });
      return;
    }

    setPending(true);
    try {
      await ensureWalletReady(config);

      if (getAccount(config).chainId !== chainEntry.chain.id) {
        await switchChain(config, { chainId: chainEntry.chain.id }).catch(() => {
          throw new Error(`Switch your wallet to ${chainEntry.chain.name} to collect.`);
        });
      }

      const hash = await writeContract(config, {
        address: migratorAddress,
        abi: FOLIO_MIGRATOR_ABI,
        functionName: "collectFees",
        args: [contract.address],
        chainId: chainEntry.chain.id,
      });

      setStatus({ kind: "info", message: "Collect sent, waiting for confirmation...", tx: hash });
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainEntry.chain.id,
      });

      if (receipt.status !== "success") {
        setStatus({ kind: "error", message: "The collect reverted. Nothing changed.", tx: hash });
        return;
      }

      setStatus({
        kind: "success",
        message: `Collected ${formatEth(poolEth)} ETH and ${formatEth(poolTokens)} ${token.symbol}.`,
        tx: hash,
      });
      await refetchPoolFees();
      router.refresh();
    } catch (err) {
      console.error("Pool fee collection failed:", err);
      const failure = classifyTxError(err);
      setStatus({
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
        <span className="factbox__value">
          {migrated ? `${formatBps(stats.feeBps)} of every leg, until migration` : `${formatBps(stats.feeBps)} of every leg`}
        </span>
      </div>

      {migrated && hasMigrator && (
        <div className="factbox__row">
          <span className="factbox__label">Pool fees</span>
          <span className="factbox__value">
            {formatEth(poolEth)} ETH
            {poolTokenUnits > 0n && ` + ${formatEth(poolTokens)} ${token.symbol}`}
            <FiatValue eth={poolEth} block />
          </span>
        </div>
      )}

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

        {/* The curve's own fees. Still claimable after migration, since whatever
            had accrued when the curve closed is still owed. */}
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={handleClaim}
          disabled={pending || nothingToClaim}
          data-busy={pending || undefined}
        >
          {pending ? "Confirming..." : nothingToClaim ? "Nothing to claim yet" : "Claim curve fees"}
        </button>

        {migrated && hasMigrator && (
          <button
            type="button"
            className="btn btn--block"
            onClick={handleCollect}
            disabled={pending || nothingToCollect}
            data-busy={pending || undefined}
            style={{ marginTop: "var(--sp-2)" }}
          >
            {pending
              ? "Confirming..."
              : nothingToCollect
                ? "No pool fees yet"
                : "Collect pool fees"}
          </button>
        )}

        <p className="field__hint" style={{ marginTop: "var(--sp-2)" }}>
          {migrated
            ? `This launch has moved to a Uniswap pool. The curve's fees are still yours to claim, and the pool keeps earning you ${
                poolFeeBps === null ? "a share" : formatBps(poolFeeBps)
              } of its volume for as long as it trades — anyone can trigger a payout, but it always goes to you.`
            : `Fees sit outside the curve's reserve, so claiming them never touches the ETH backing your holders' ability to sell${
                stats.paused
                  ? " — and the platform's emergency stop halts trading, not this."
                  : "."
              }`}
        </p>
      </div>
    </section>
  );
}
