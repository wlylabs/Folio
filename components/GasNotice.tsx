import { formatUnits } from "viem";
import { chainBySlug, explorerAddressUrl } from "@/lib/chains";
import { formatEth, shortAddress } from "@/lib/types";
import type { FundsElsewhere } from "@/components/useGasBalance";

/**
 * What a page can offer a reader whose gas turned out to be on another chain.
 *
 * `note` is always worth saying: even "there is no way to spend it here" ends
 * the search. `action` is for the pages where the money is usable after one
 * press — it is absent, not disabled, when there is nothing to press.
 */
export type ElsewhereWayOut = {
  /** One sentence on what that balance can and cannot do for this page. */
  note: string;
  /** The press that puts the reader on the funded chain, when one exists. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
};

/**
 * The way-out line for a page whose chain is decided by a token, not a choice.
 *
 * A trade has no equivalent of the launch form's network picker: the token was
 * deployed on one chain and cannot leave it, so a balance on another one is not
 * a switch away from being useful — it is simply unusable here.
 */
export function fixedChainWayOut(
  elsewhere: FundsElsewhere | null | undefined,
  network: string | undefined
): ElsewhereWayOut | null {
  if (!elsewhere) return null;
  return {
    note: `Nothing can move it to ${network ?? "this network"} — gas here has to be held here.`,
  };
}

/**
 * The wallet has no gas, said as briefly as the situation allows.
 *
 * It names the network, because funding the wrong one looks exactly like a
 * transfer that never arrived: confirmed on an explorer, invisible here. And it
 * carries a re-check button — the balance polls itself, but
 * someone staring at a confirmed transaction wants to press something rather
 * than wait out an interval they cannot see.
 *
 * Three states, one line of explanation each. `unreadable` is an RPC that
 * failed rather than answered, which is not the same as a zero and must not be
 * reported as one. `elsewhere` is the wallet's balance on a supported chain
 * this page is *not* spending on — see useGasBalance, which finds nothing while
 * Robinhood Chain is the only supported network. Otherwise it is an ordinary
 * empty wallet, and gas on a mainnet is bought rather than claimed.
 */
export function GasNotice({
  chain,
  heading,
  address,
  elsewhere = null,
  wayOut = null,
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
  /** What this page can offer about those funds. Ignored without `elsewhere`. */
  wayOut?: ElsewhereWayOut | null;
  /** True when the balance read failed, as opposed to returning zero. */
  unreadable?: boolean;
  onRecheck?: () => void;
  checking?: boolean;
}) {
  const entry = chainBySlug(chain);
  const network = entry?.chain.name;
  const symbol = entry?.chain.nativeCurrency.symbol ?? "ETH";
  const addressUrl = address ? explorerAddressUrl(chain, address) : null;

  return (
    <div className={`notice${unreadable ? " notice--alert" : ""}`}>
      {unreadable ? (
        <>
          <p className="notice__title">Balance unavailable</p>
          <p>
            {network ? `${network}'s` : "The"} RPC didn&apos;t answer, so this is missing rather
            than zero — your {symbol} is wherever it was.
          </p>
        </>
      ) : elsewhere ? (
        <>
          <p className="notice__title">
            Your {elsewhere.symbol} is on {elsewhere.name}, not {network ?? "this network"}
          </p>
          <p>
            <span className="nums">
              {formatEth(Number(formatUnits(elsewhere.value, elsewhere.decimals)))}{" "}
              {elsewhere.symbol}
            </span>{" "}
            there, nothing here — funding the wrong network looks exactly like this.
            {wayOut ? ` ${wayOut.note}` : ""}
          </p>
          {wayOut?.action && (
            <p style={{ marginTop: "var(--sp-3)" }}>
              <button
                type="button"
                className="btn btn--outline btn--sm"
                onClick={wayOut.action.onClick}
                disabled={wayOut.action.disabled}
              >
                {wayOut.action.label}
              </button>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="notice__title">{heading}</p>
          {/*
            Folio is on a mainnet and nowhere else, so there is no faucet to
            point at — and the things that answer a search for one on a mainnet
            are not faucets. What is left to say is the network the {symbol}
            has to be on, which is the part a reader gets wrong.
          */}
          <p>
            {symbol} on {network ?? "this network"} has to be bridged or bought — there is no
            faucet for it. Fund this wallet{network ? ` on ${network}` : ""} and come back; this
            updates on its own.
          </p>
        </>
      )}

      {address && (
        <p className="notice__aside">
          <span className="mono">{shortAddress(address)}</span>
          {network ? ` on ${network}` : ""}
          {addressUrl && (
            <>
              {" · "}
              <a href={addressUrl} target="_blank" rel="noopener noreferrer">
                explorer
              </a>
            </>
          )}
          {onRecheck && (
            <>
              {" · "}
              <button
                type="button"
                className="link-button link-button--inline"
                onClick={onRecheck}
                disabled={checking}
              >
                {checking ? "checking..." : "re-check"}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
