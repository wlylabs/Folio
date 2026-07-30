import { faucetsFor } from "@/lib/chains";

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

/** The same links, boxed, for when an empty wallet is blocking the next step. */
export function FaucetNotice({ chain, heading }: { chain: string; heading: string }) {
  if (faucetsFor(chain).length === 0) return null;

  return (
    <div className="notice">
      <p className="notice__title">{heading}</p>
      <p>Claim free test ETH, then come back — it usually lands in under a minute.</p>
      <p style={{ marginTop: "var(--sp-2)" }}>
        <FaucetLinks chain={chain} />
      </p>
    </div>
  );
}
