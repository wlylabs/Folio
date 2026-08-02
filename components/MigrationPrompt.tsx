"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConfig, useReadContracts } from "wagmi";
import { getAccount, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { zeroAddress } from "viem";
import ConnectCue from "@/components/ConnectCue";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { FOLIO_MIGRATOR_ABI } from "@/lib/contracts/folioMigrator";
import { chainBySlug, explorerAddressUrl, explorerTxUrl } from "@/lib/chains";
import { classifyTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
import { formatEth, shortAddress, type CurveStats, type Token } from "@/lib/types";

/**
 * The last step of a graduated launch, and the button that takes it.
 *
 * A curve that has graduated is closed to buys forever. Selling still works, so
 * nothing is stuck — but the only transaction left on the contract is a sell,
 * which means the price can only go one way and every holder can see that. The
 * contract emits `Graduated` and stops there on purpose: moving the reserve
 * into a pool is a decision, and the platform makes it once, per deployment, by
 * naming a `FolioMigrator` in the factory's config.
 *
 * Where a launch *has* one named, `migrate(token)` is the transaction that
 * takes the reserve, pairs it against newly minted tokens at exactly the price
 * the curve closed at, and locks the position — permanently, by having no code
 * that could remove it. Until now nothing in this app called it, so a graduated
 * launch on a deployment that had chosen migration sat there waiting for
 * somebody to find the contract on a block explorer. This is that call, on the
 * page where the reader already is.
 *
 * ## Why anyone may press it
 *
 * `migrate` is permissionless by design and this panel is too. The terms are
 * fixed by the curve's own state — the pool's opening price, its size, the fee
 * tier — so a caller chooses nothing except *when*, and the pool anybody gets
 * is the pool everybody gets. Deliberately not automatic on the graduating buy,
 * which would bill one unlucky buyer for a pool deployment; deliberately not
 * restricted to the creator, who may never come back.
 *
 * ## What it says before it is pressed
 *
 * Migration ends the sell-back guarantee, and that is a real cost to a holder
 * rather than an implementation detail. On the curve, selling every circulating
 * token back returns exactly the reserve. In a pool it does not — an AMM holds
 * both sides at every price, so some of the ETH is never reachable by sellers.
 * The panel says so in the sentence above the button, because a holder reading
 * this page is the person that trade is made on behalf of.
 */

/** How often the graduation state is re-read while the panel is open, in ms. */
const REFRESH_MS = 20_000;

type Status = { kind: "info" | "error" | "success" | "muted"; message: string; tx?: string };

export default function MigrationPrompt({
  token,
  stats,
}: {
  token: Token;
  stats: CurveStats;
}) {
  const { isConnected } = useAccount();
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

  /**
   * The three facts this panel turns on, read live.
   *
   * The server render already carries them in `stats`, and it is the read that
   * decides whether this component mounts at all. It is not the read that
   * should decide whether the button is pressable: graduation and migration
   * both happen in somebody else's transaction, and a page that has been open
   * for a minute can be a minute wrong. `allowFailure` because a launch cloned
   * from an implementation older than migration answers none of these, which is
   * a launch that never migrates rather than a panel that breaks.
   */
  const { data: live } = useReadContracts({
    contracts: [
      { ...contract, functionName: "graduated" },
      { ...contract, functionName: "migrated" },
      { ...contract, functionName: "migrator" },
    ],
    allowFailure: true,
    query: { enabled: Boolean(targetChainId), refetchInterval: REFRESH_MS },
  });

  const graduated =
    live?.[0]?.status === "success" ? live[0].result === true : stats.graduated;
  const migrated =
    live?.[1]?.status === "success" ? live[1].result === true : stats.migrated;
  const migratorAddress =
    live?.[2]?.status === "success"
      ? (live[2].result as `0x${string}`)
      : ((stats.migrator ?? undefined) as `0x${string}` | undefined);

  const hasMigrator = Boolean(migratorAddress) && migratorAddress !== zeroAddress;

  /*
   * Nothing to offer, in three different ways, all of which are ordinary:
   * a curve still trading, a launch already moved, and a deployment that chose
   * to keep the floor and never named a migrator at all. None of them is a
   * failure and none of them gets a panel — the page should be quiet about a
   * step that does not exist.
   */
  if (!graduated || migrated || !hasMigrator) return null;

  const handleMigrate = async () => {
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
      // The same preamble the trade bar and the fee panel use: wake a stored
      // session before asking it to sign, then point it at the token's chain.
      await ensureWalletReady(config);

      if (getAccount(config).chainId !== chainEntry.chain.id) {
        await switchChain(config, { chainId: chainEntry.chain.id }).catch(() => {
          throw new Error(`Switch your wallet to ${chainEntry.chain.name} to open the pool.`);
        });
      }

      const hash = await writeContract(config, {
        address: migratorAddress,
        abi: FOLIO_MIGRATOR_ABI,
        functionName: "migrate",
        args: [contract.address],
        chainId: chainEntry.chain.id,
      });

      setStatus({ kind: "info", message: "Migration sent, waiting for confirmation...", tx: hash });
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainEntry.chain.id,
      });

      if (receipt.status !== "success") {
        setStatus({
          kind: "error",
          message:
            "The migration reverted. The reserve is untouched and the curve is exactly as it was.",
          tx: hash,
        });
        return;
      }

      setStatus({
        kind: "success",
        message: "The pool is open. This page now prices the token off it.",
        tx: hash,
      });
      // Everything on this page is downstream of the migration — the price, the
      // reserve, both legs of the trade panel, the creator's fee source. A
      // refresh is the honest way to redraw all of it at once.
      router.refresh();
    } catch (err) {
      console.error("Migration failed:", err);
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
  const migratorUrl = migratorAddress ? explorerAddressUrl(token.chain, migratorAddress) : null;

  return (
    <section className="factbox" aria-label="Graduation">
      <h2 className="factbox__head">
        <span>Graduated</span>
        <span>Anyone may finish this</span>
      </h2>

      <div className="factbox__row">
        <span className="factbox__label">Reserve to move</span>
        <span className="factbox__value">{formatEth(stats.reserve)} ETH</span>
      </div>

      <div className="factbox__row">
        <span className="factbox__label">Opens at</span>
        {/* The curve's closing price, which is the pool's opening price. Saying
            it here is the plainest form of the continuity promise: the pool does
            not start below where the last buyer bought. */}
        <span className="factbox__value">{formatEth(stats.price)} ETH</span>
      </div>

      <div className="factbox__row">
        <span className="factbox__label">Migrator</span>
        <span className="factbox__value mono">
          {migratorUrl ? (
            <a href={migratorUrl} target="_blank" rel="noopener noreferrer">
              {shortAddress(migratorAddress!)}
            </a>
          ) : (
            shortAddress(migratorAddress!)
          )}
        </span>
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

        {isConnected ? (
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={handleMigrate}
            disabled={pending}
            data-busy={pending || undefined}
          >
            {pending ? "Confirming..." : "Open the Uniswap pool"}
          </button>
        ) : (
          // Same cue every other action on the site uses, so the reader is asked
          // for a wallet where they were stopped rather than sent to look for
          // the settings panel.
          <ConnectCue />
        )}

        <p className="field__hint" style={{ marginTop: "var(--sp-2)" }}>
          Buying closed when this launch hit its graduation threshold, and it
          does not reopen. Migrating pairs the reserve against newly minted
          tokens in a Uniswap v4 pool at the price the curve closed at, and
          locks that liquidity permanently — there is no function anywhere that
          can withdraw it. The trade it makes is worth knowing before you press
          it: the curve&rsquo;s sell-back guarantee ends here. On the curve,
          selling every circulating token back returns exactly the reserve; a
          pool holds both sides at every price, so some of that ETH stops being
          reachable by sellers. What replaces it is a market that trades in both
          directions again, with no ceiling. Anyone may send this transaction —
          the terms come from the curve, not from the caller — and the sender
          pays only its gas.
        </p>
      </div>
    </section>
  );
}
