import { shortAddress } from "@/lib/types";

/**
 * The byline's address, and whether anybody proved it.
 *
 * Folio stores `creator_wallet` from the browser that published a launch, and
 * for most of this project's life that column was a claim: the anon key carries
 * no wallet identity, so a row could name any address at all. It still can —
 * the anon insert policy is still there, because a deployment with wallet
 * verification switched off has to keep publishing — which is exactly why the
 * page has to say which kind of byline it is looking at.
 *
 * So there are two states and they are drawn differently on purpose:
 *
 *  - **Verified.** The publisher signed an EIP-4361 message naming this site
 *    and this address, minutes before the insert, and the policy in
 *    `lib/schema.sql` checked the signed address against the row. Postgres
 *    enforced it; no component could have skipped it.
 *  - **Unverified.** Everything else — a listing published before verification
 *    existed, one written by `/api/indexer` from the factory's event log, or
 *    one from a deployment that does not have it configured.
 *
 * The unverified state is a quiet word rather than a warning sign. An indexed
 * listing is not suspicious, it simply had nobody at a keyboard to sign for it,
 * and a red mark on every launch older than this feature would be alarm without
 * information. What both states share is that they are stated at all.
 *
 * Neither one decides anything. Creator powers that move money — `claimFees`,
 * the migration prompt — read `creator()` off the contract, which is a fact
 * about the chain rather than about a row.
 */
export default function CreatorMark({
  wallet,
  verified,
  href,
}: {
  wallet: string;
  verified?: boolean | null;
  /** The explorer, when the chain publishes one. */
  href?: string | null;
}) {
  const address = (
    <b className="mono" style={{ color: "var(--ink)" }}>
      {shortAddress(wallet)}
    </b>
  );

  return (
    <span className="byline__creator">
      by{" "}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {address}
        </a>
      ) : (
        address
      )}
      {verified ? (
        <span
          className="byline__proof byline__proof--verified"
          title="This address signed for the listing when it was published. The signature was checked against a nonce this site issued."
        >
          {/* Marked as decorative, with the word beside it doing the work: a
              tick alone is a claim in a glyph, and a screen reader would read
              it as nothing at all. */}
          <span aria-hidden="true">✓</span> Verified
        </span>
      ) : (
        <span
          className="byline__proof"
          title="Nobody signed for this byline. The address is recorded as published — or, for an indexed launch, taken from the factory's own event log — but it was not proved here."
        >
          Unverified byline
        </span>
      )}
    </span>
  );
}
