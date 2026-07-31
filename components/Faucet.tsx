import { formatUnits } from "viem";
import { chainBySlug, explorerAddressUrl, faucetsFor } from "@/lib/chains";
import { formatEth, shortAddress } from "@/lib/types";
import type { FundsElsewhere } from "@/components/useGasBalance";

/**
 * Where to get test ETH.
 *
 * Every action on Folio costs gas, and a fresh wallet has none, so this is the
 * first wall a new user hits. Both the launch form and the trade bar watch the
 * connected balance and print these links the moment it is empty, rather than
 * letting the wallet fail with "insufficient funds" and leaving the user to
 * find a faucet themselves.
 */
export function FaucetLinks({ chain }: { chain: string }) {
  const faucets = faucetsFor(chain);
  if (faucets.length === 0) return null;

  return (
    <>
      {faucets.map((faucet, i) => (
        <span key={faucet.url}>
          {i > 0 && " · "}
          <a href={faucet.url} target="_blank" rel="noopener noreferrer">
            {faucet.label}
          </a>
        </span>
      ))}
    </>
  );
}

/**
 * The same links, boxed, for when an empty wallet is blocking the next step.
 *
 * It names the network, because a faucet claim on the wrong testnet looks
 * exactly like a claim that never arrived: confirmed on an explorer, invisible
 * here. And it carries a re-check button — the balance polls itself, but
 * someone staring at a confirmed transaction wants to press something rather
 * than wait out an interval they cannot see.
 *
 * That naming was not enough. A reader who has a confirmed transaction in one
 * tab and a zero in this one does not re-read the network name and conclude
 * they picked the wrong faucet; they conclude Folio is broken, because from
 * where they sit both stories fit. So the box now takes the two facts that
 * separate those stories — `elsewhere`, the wallet's balance on the chains
 * this page is *not* spending on, and `unreadable`, an RPC that failed rather
 * than answered — and leads with whichever one applies. Underneath, always,
 * the address and chain the zero actually came from, linked to the explorer
 * that can confirm or contradict it. A number the reader can check beats a
 * number they have to trust.
 */
export function FaucetNotice({
  chain,
  heading,
  address,
  elsewhere = null,
  unreadable = false,
  onRecheck,
  checking = false,
}: {
  chain: string;
  heading: string;
  /** The wallet the balance was read for, shown so a wrong account is visible. */
  address?: `0x${string}`;
  /** Funds found on another supported chain, when the sweep located them. */
  elsewhere?: FundsElsewhere | null;
  /** True when the balance read failed, as opposed to returning zero. */
  unreadable?: boolean;
  onRecheck?: () => void;
  checking?: boolean;
}) {
  const faucets = faucetsFor(chain);
  // The faucet links are the usual reason to render, but not the only one: a
  // failed read and a mis-aimed claim both need saying even on a chain that
  // lists no faucet at all.
  if (faucets.length === 0 && !elsewhere && !unreadable) return null;

  const entry = chainBySlug(chain);
  const network = entry?.chain.name;
  const symbol = entry?.chain.nativeCurrency.symbol ?? "ETH";
  const addressUrl = address ? explorerAddressUrl(chain, address) : null;

  return (
    <div className={`notice${unreadable ? " notice--alert" : ""}`}>
      {unreadable ? (
        <>
          <p className="notice__title">Couldn&apos;t read this wallet&apos;s balance</p>
          <p>
            {network ? `${network}'s` : "The"} RPC didn&apos;t answer, so the figure above is
            missing rather than zero — your {symbol} is wherever it was. Try the re-check below;
            if it keeps failing, the network is having a moment.
          </p>
        </>
      ) : elsewhere ? (
        <>
          <p className="notice__title">
            Your {elsewhere.symbol} is on {elsewhere.name}, not{" "}
            {network ?? "this network"}
          </p>
          <p>
            This wallet holds{" "}
            <span className="nums">
              {formatEth(Number(formatUnits(elsewhere.value, elsewhere.decimals)))}{" "}
              {elsewhere.symbol}
            </span>{" "}
            on {elsewhere.name} and nothing{network ? ` on ${network}` : " here"} — which is what
            a confirmed faucet claim on the wrong testnet looks like. Gas for this page has to be
            claimed{network ? ` on ${network}` : " on this network"}; the faucet below is the one
            for it.
          </p>
        </>
      ) : (
        <>
          <p className="notice__title">{heading}</p>
          <p>
            Claim free test ETH{network ? ` on ${network}` : ""}, then come back — it usually
            lands in under a minute, and this updates on its own.
          </p>
        </>
      )}

      {faucets.length > 0 && (
        <p style={{ marginTop: "var(--sp-2)" }}>
          <FaucetLinks chain={chain} />
        </p>
      )}

      {address && (
        <p style={{ marginTop: "var(--sp-2)" }}>
          Reading <span className="mono">{shortAddress(address)}</span>
          {network ? ` on ${network}` : ""}
          {entry ? ` (chain ${entry.chain.id})` : ""}
          {addressUrl && (
            <>
              {" · "}
              <a href={addressUrl} target="_blank" rel="noopener noreferrer">
                check on explorer
              </a>
            </>
          )}
        </p>
      )}

      {onRecheck && (
        <p style={{ marginTop: "var(--sp-3)" }}>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={onRecheck}
            disabled={checking}
            data-busy={checking || undefined}
          >
            {checking ? "Checking..." : "Check balance again"}
          </button>
        </p>
      )}
    </div>
  );
}
