import { chainBySlug, faucetsFor } from "@/lib/chains";

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
 */
export function FaucetNotice({
  chain,
  heading,
  onRecheck,
  checking = false,
}: {
  chain: string;
  heading: string;
  onRecheck?: () => void;
  checking?: boolean;
}) {
  if (faucetsFor(chain).length === 0) return null;

  const network = chainBySlug(chain)?.chain.name;

  return (
    <div className="notice">
      <p className="notice__title">{heading}</p>
      <p>
        Claim free test ETH{network ? ` on ${network}` : ""}, then come back — it usually lands in
        under a minute, and this updates on its own.
      </p>
      <p style={{ marginTop: "var(--sp-2)" }}>
        <FaucetLinks chain={chain} />
      </p>
      {onRecheck && (
        <p style={{ marginTop: "var(--sp-3)" }}>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={onRecheck}
            disabled={checking}
          >
            {checking ? "Checking..." : "Check balance again"}
          </button>
        </p>
      )}
    </div>
  );
}
