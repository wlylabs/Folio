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
    <div
      className="font-ui"
      style={{
        border: "1px solid var(--ink)",
        padding: "10px 12px",
        fontSize: 11,
        lineHeight: 1.6,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{heading}</div>
      <div style={{ color: "var(--ink-soft)" }}>
        Claim free test ETH, then come back — it usually lands in under a minute.
      </div>
      <div style={{ marginTop: 6 }}>
        <FaucetLinks chain={chain} />
      </div>
    </div>
  );
}
