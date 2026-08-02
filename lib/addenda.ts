import { supabase, supabaseAs, isSupabaseConfigured } from "@/lib/supabaseClient";
import { paragraphsToHtml } from "@/lib/sanitize";
import type { Token } from "@/lib/types";

/**
 * Additions to a published article: the correction that cannot be a silent edit.
 *
 * A blog changes its mind by rewriting the paragraph. The date at the top stays
 * where it was, the old wording is gone, and a reader arriving afterwards has
 * no way to tell that the piece in front of them is not the piece anybody acted
 * on. Folio cannot afford that, because here somebody bought on the strength of
 * the words — so the article stays exactly as it was published (the policies in
 * `lib/schema.sql` refuse updates and deletes from every client) and second
 * thoughts are appended instead.
 *
 * Two things make an addition worth more than an edit would be:
 *
 *  - **It is signed.** There is no anonymous path into this table at all, which
 *    is the one place Folio is stricter than it is about bylines. A listing
 *    published with the public key is honestly labelled unverified and left
 *    alone; a *change of story* is worth nothing unless the address on the
 *    article signed for it, so an addition needs the same EIP-4361 session that
 *    a verified byline needs. A deployment with no `SUPABASE_JWT_SECRET` has no
 *    additions, and the page says so rather than offering a box that fails.
 *  - **It is permanent.** No update policy, no delete policy — not even for the
 *    author. An author who retracts cannot later retract the retraction, which
 *    is the property that makes reading one mean anything.
 *
 * The trade log is on the same page, so the two together answer the question a
 * reader of any launch actually has: the author changed their mind here, and
 * this is what the price was doing at the time.
 */

/**
 * The ceiling the composer enforces, matching the one in the insert policy.
 *
 * Long enough for a retraction and the reason for it, short of a second
 * article. Something that needs more than this is a new launch, not a footnote
 * to an old one.
 */
export const ADDENDUM_MAX_LENGTH = 5_000;

/** One addition, as the article page reads it back. */
export type Addendum = {
  id: string;
  /** HTML, sanitised again on render exactly like `article_body`. */
  body: string;
  /** The address that signed for it. Equal to the listing's byline, by policy. */
  author_wallet: string;
  created_at: string;
};

/**
 * Every addition to a listing, oldest first.
 *
 * Failure is empty rather than thrown. An article whose additions could not be
 * loaded should still be an article — and the alternative, a listing page that
 * 500s because a follow-up paragraph is unavailable, would be a worse answer to
 * a worse problem. A deployment that has not run the current `lib/schema.sql`
 * has no table here at all, and lands in the same place.
 */
export async function fetchAddenda(token: Token): Promise<Addendum[]> {
  if (!isSupabaseConfigured) return [];

  const { data, error } = await supabase
    .from("token_addenda")
    .select("id, body, author_wallet, created_at")
    .eq("contract_address", token.contract_address.toLowerCase())
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to load additions:", error.message);
    return [];
  }

  return (data as Addendum[] | null) ?? [];
}

/**
 * Why this text cannot be published, or null when it can.
 *
 * Shared by the composer and the tests so that the message a reader sees and
 * the rule that is actually applied are the same sentence. The database applies
 * its own version of both bounds; this one exists to say so before a signature
 * is asked for rather than after.
 */
export function addendumProblem(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "An addition needs something in it.";
  if (trimmed.length > ADDENDUM_MAX_LENGTH) {
    return `An addition runs to ${ADDENDUM_MAX_LENGTH.toLocaleString(
      "en-US"
    )} characters at most. This one is ${trimmed.length.toLocaleString("en-US")}.`;
  }
  return null;
}

/**
 * Append an addition, as the wallet that signed `sessionToken`.
 *
 * The session is passed in rather than minted here for the same reason the
 * launch form asks for one before it sends a transaction: signing is a step the
 * reader can decline, and the component that owns the button is the one that
 * should be explaining what the signature is for.
 *
 * Nothing here checks that the signer is the author — `supabaseAs` sends the
 * JWT and the policy in `lib/schema.sql` does the comparison in Postgres, where
 * it cannot be skipped by a component that forgot.
 */
export async function publishAddendum({
  listing,
  sessionToken,
  text,
}: {
  listing: Token;
  sessionToken: string;
  text: string;
}): Promise<void> {
  const problem = addendumProblem(text);
  if (problem) throw new Error(problem);

  const { error } = await supabaseAs(sessionToken).from("token_addenda").insert({
    contract_address: listing.contract_address.toLowerCase(),
    chain: listing.chain,
    body: paragraphsToHtml(text.trim()),
    author_wallet: listing.creator_wallet.toLowerCase(),
  });

  if (error) throw new Error(error.message);
}
