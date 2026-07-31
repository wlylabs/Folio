/**
 * The beats the article desk covers.
 *
 * Its own module, with no imports, because both sides of the app need it: the
 * composer renders the beat picker in the browser, and lib/ai/news.ts maps each
 * beat to a set of feeds on the server. Keeping the list in news.ts would have
 * pulled the feed reader — and every environment variable it reads — into the
 * client bundle to render three buttons.
 */

export const TOPICS = ["ai", "technology", "crypto"] as const;

export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABEL: Record<Topic, string> = {
  ai: "AI",
  technology: "Technology",
  crypto: "Crypto",
};

export function isTopic(value: unknown): value is Topic {
  return typeof value === "string" && (TOPICS as readonly string[]).includes(value);
}

/** A stored topic's label, for a row whose value predates this list. */
export function topicLabel(topic: string): string {
  return isTopic(topic) ? TOPIC_LABEL[topic] : topic;
}
