import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { formatDate, type Token } from "@/lib/types";

/**
 * How many people actually backed a launch, and how many are still behind it.
 *
 * Every blog prints a view counter and no blog's is worth reading: a view costs
 * a request to manufacture, so the number measures traffic at best and a script
 * at worst. A launch on a bonding curve has a better figure lying around unused
 * — the count of distinct addresses that have bought it. Forging that costs a
 * transaction per address on a network settling in real ETH, and every one of
 * them is in the contract's own event log where anybody can recount them. It is
 * the one readership statistic on the internet that is expensive to lie about.
 *
 * So this is what a Folio listing prints where a blog prints views.
 *
 * ## What it will not claim
 *
 * Not holders. Balances move by ERC20 `transfer` as well as through the curve,
 * and the trade log only knows the curve — so "still holding" would be a guess
 * wearing a count's clothes. `neverSold` is what the log can actually support,
 * and the page words it as exactly that: bought, and never sold back.
 *
 * ## Why it can be absent
 *
 * The count comes from the recorded trade log, which is written by
 * `lib/tradeRecorder.ts` and needs `SUPABASE_SERVICE_ROLE_KEY`. A deployment
 * without one records nothing, and a zero from it would say "nobody bought
 * this" when the truth is "this deployment is not counting". The SQL function
 * reports whether the launch has been walked at all, and this returns null when
 * it has not — the page then prints nothing, which is the honest amount to say.
 */

/** What the article page needs to print the line. Null stands for "unknown". */
export type Readership = {
  /** Distinct addresses that have bought from the curve. */
  buyers: number;
  /** How many of those have never sold any of it back. */
  neverSold: number;
  /** When the first of them bought, or null where no block header was read. */
  since: string | null;
};

/**
 * The sentence that explains why this number is worth more than a view count.
 *
 * On the page it hangs off a `title`, the same way the byline's proof mark does
 * — a footnote for the reader who wonders, not a paragraph in front of the one
 * who does not.
 */
export const READERSHIP_NOTE =
  "Counted from the curve's own trade log: distinct addresses that bought, " +
  "each of which paid gas on a network settling in real ETH. Unlike a view " +
  "counter, this one costs money to inflate.";

export async function fetchReadership(token: Token): Promise<Readership | null> {
  if (!isSupabaseConfigured) return null;

  const { data, error } = await supabase.rpc("folio_listing_readership", {
    p_chain: token.chain,
    p_token_address: token.contract_address.toLowerCase(),
  });

  if (error) {
    // A deployment that has not run the current lib/schema.sql has no function
    // to call, which is a listing with no readership line rather than a listing
    // that fails to render.
    console.error("Failed to read the launch's readership:", error.message);
    return null;
  }

  // `returns table` comes back as rows even when there is exactly one.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { recorded?: boolean; buyers?: number; never_sold?: number; first_buy?: string | null }
    | undefined;

  if (!row || !row.recorded) return null;

  return {
    buyers: Number(row.buyers ?? 0),
    neverSold: Number(row.never_sold ?? 0),
    since: row.first_buy ?? null,
  };
}

/**
 * The readership as a sentence.
 *
 * Written out rather than assembled from a template because the interesting
 * cases are the small ones: one buyer, nobody yet, and everybody still in. A
 * counter that reads "1 addresses have bought this, 1 of them have never sold"
 * is the sort of thing that makes a reader trust none of the other numbers on
 * the page.
 */
export function readershipLine(readership: Readership): string {
  const { buyers, neverSold, since } = readership;

  if (buyers <= 0) {
    return "Nobody has bought this yet.";
  }

  const count = buyers === 1 ? "One address has bought this" : `${buyers.toLocaleString("en-US")} addresses have bought this`;
  const when = since ? ` since ${formatDate(since)}` : "";

  if (neverSold <= 0) {
    return `${count}${when}. Every one of them has sold back to the curve.`;
  }

  if (neverSold >= buyers) {
    return buyers === 1
      ? `${count}${when}, and has never sold back to the curve.`
      : `${count}${when}, and none of them has sold back to the curve.`;
  }

  return `${count}${when}, and ${neverSold.toLocaleString("en-US")} of them ${
    neverSold === 1 ? "has" : "have"
  } never sold back to the curve.`;
}
