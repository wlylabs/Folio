import { serverSupabase } from "@/lib/supabaseAdmin";
import { urlKey } from "./news";

/**
 * What the desk has already written about.
 *
 * A feed is a rolling window, not a queue: a story published this morning is
 * still in the feed this evening and still in it tomorrow. Nothing stopped the
 * agent being handed the same twelve headlines twice and writing the same
 * article twice — the second one would arrive with a different headline, a
 * `-2` on its slug and the same sources at its foot, which is the exact shape
 * of the thing this project's README says it is not.
 *
 * So the stories behind every recently published post are pulled out and
 * subtracted from the feed before the model ever sees it. The comparison is on
 * {urlKey}, the same normalisation the feed merge and the citation matcher use:
 * "is this the same story" has to be answered the same way in all three places
 * or a tracking parameter defeats it.
 *
 * ## The window
 *
 * Fourteen days, not forever. A beat genuinely returns to a story — a lawsuit
 * filed in March is reported again when it is decided in June — and the second
 * piece is a different article about a real development, not a duplicate. What
 * this has to stop is the same week's feed producing the same piece twice, and
 * a fortnight covers that with room to spare.
 */

const WINDOW_DAYS = 14;

/** Twelve items a run, a few runs a day: this is a fortnight with headroom. */
const MAX_POSTS = 200;

/**
 * Below this the beat has nothing new to say. Two, because the writer's whole
 * instruction is to find the thread running through two or more items — handed
 * one fresh headline it would either pad or reach for what it remembers, and
 * both are worse than not publishing today.
 */
export const MIN_FRESH_ITEMS = 2;

/**
 * Thrown when everything in a topic's feed has already been covered.
 *
 * Its own class because it is not a failure in the way the other errors here
 * are: nothing broke, there is simply nothing new. The scheduled runner reports
 * a quiet day rather than paging whoever watches it.
 */
export class NoFreshNewsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoFreshNewsError";
  }
}

type SourceRow = { sources: { url?: unknown }[] | null };

/**
 * The {urlKey} of every source cited by a post published in the last
 * {WINDOW_DAYS} days.
 *
 * Returns an empty set when Supabase is not configured or the read fails.
 * Deduplication is an improvement on the draft, not a gate on it: a database
 * hiccup should cost a slightly repetitive article, never the article.
 */
export async function coveredSourceKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const client = serverSupabase();
  if (!client) return keys;

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await client
    .from("posts")
    .select("sources")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_POSTS);

  if (error) {
    console.error("Could not read what the desk already covered:", error.message);
    return keys;
  }

  for (const row of (data as SourceRow[] | null) ?? []) {
    for (const source of row.sources ?? []) {
      if (typeof source?.url === "string") keys.add(urlKey(source.url));
    }
  }

  return keys;
}
