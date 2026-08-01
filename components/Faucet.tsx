import { formatUnits } from "viem";
import { chainBySlug, explorerAddressUrl, faucetDirectory, faucetsFor } from "@/lib/chains";
import { formatEth, shortAddress } from "@/lib/types";
import type { FundsElsewhere } from "@/components/useGasBalance";

/**
 * Where to get test ETH — now in exactly one place.
 *
 * These links used to be printed wherever an empty wallet was noticed: a boxed
 * paragraph in the trade panel, a second copy under the launch button, a third
 * under the amount field. On a phone the panel is most of a screen already, and
 * three faucet links plus their explanation pushed everything else out of view
 * to say something the reader only needs once. They live in Settings
 * now. What is left at the point of failure is the diagnosis — which wallet,
 * which network, and whether the zero is real — and a pointer to the panel.
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
 * Every faucet Folio knows about, grouped by network. For the settings panel.
 *
 * Grouped rather than filtered to the current page's chain, because a reader
 * who opens Settings has not said which network they are short on — and the
 * commonest way to end up with no gas is to have claimed on the other one.
 */
export function FaucetDirectory() {
  const networks = faucetDirectory();
  if (networks.length === 0) return null;

  return (
    <>
      {networks.map((network) => (
        <p key={network.slug} className="settings__note">
          <span className="settings__faucet-chain">{network.name}</span>
          <FaucetLinks chain={network.slug} />
        </p>
      ))}
    </>
  );
}

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
    note: `Nothing can move it to ${network ?? "this network"} — gas here has to be claimed here.`,
  };
}

/**
 * The wallet has no gas, said as briefly as the situation allows.
 *
 * It names the network, because a faucet claim on the wrong testnet looks
 * exactly like a claim that never arrived: confirmed on an explorer, invisible
 * here. And it carries a re-check button — the balance polls itself, but
 * someone staring at a confirmed transaction wants to press something rather
 * than wait out an interval they cannot see.
 *
 * Three states, one line of explanation each. `unreadable` is an RPC that
 * failed rather than answered, which is not the same as a zero and must not be
 * reported as one. `elsewhere` is the wallet's balance on a chain this page is
 * *not* spending on — the wrong-testnet claim, made visible. Otherwise it is an
 * ordinary empty wallet, and the answer is the faucet list in Settings.
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
            there, nothing here — a claim on the wrong testnet looks exactly like this.
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
          <p>
            Faucets are in Settings, under Test ETH. Claim{network ? ` on ${network}` : ""} and come
            back — this updates on its own.
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
