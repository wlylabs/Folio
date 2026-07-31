import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";

/**
 * Reads of the `posts` table — the articles Folio publishes that are not
 * launches. See the note in lib/schema.sql for why they are a separate table.
 *
 * Reads only. Every write goes through app/api/articles/, which holds the
 * service-role client; the anon key this module uses has select and nothing
 * else on `posts`.
 */

/** A row of the `posts` table. */
export type Post = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  topic: string;
  tags: string[] | null;
  sources: PostSource[] | null;
  model: string | null;
  author_wallet: string | null;
  cover_url: string | null;
  created_at: string;
};

export type PostSource = {
  title: string;
  url: string;
  publisher: string;
  published_at: string | null;
};

/** The columns a feed card needs — the body is the expensive one to skip. */
export const POST_CARD_COLUMNS = "id, slug, title, excerpt, topic, tags, created_at, cover_url";

export type PostCard = Pick<
  Post,
  "id" | "slug" | "title" | "excerpt" | "topic" | "tags" | "created_at" | "cover_url"
>;

export function postPath(post: Pick<Post, "slug">): string {
  return `/read/${post.slug}`;
}

/**
 * Published articles, newest first.
 *
 * Returns nothing on failure rather than throwing: an article feed that is
 * briefly empty is a worse page, while a throw here would take the front page
 * down with it — and the front page's other half is the launch feed, which has
 * no reason to fail at the same time.
 */
export async function listPosts(limit = 40): Promise<PostCard[]> {
  if (!isSupabaseConfigured) return [];

  const { data, error } = await supabase
    .from("posts")
    .select(POST_CARD_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    // A deployment that has not run the `posts` half of lib/schema.sql lands
    // here on every request. Say which migration is missing rather than
    // logging a bare PostgREST code.
    console.error(
      "Failed to load articles (has the `posts` table from lib/schema.sql been created?):",
      error.message
    );
    return [];
  }
  return (data as PostCard[]) ?? [];
}

export async function getPost(slug: string): Promise<Post | null> {
  if (!isSupabaseConfigured) return null;

  const { data, error } = await supabase
    .from("posts")
    .select("*")
    .eq("slug", slug.toLowerCase())
    .maybeSingle();

  if (error) {
    console.error("Failed to load article:", error.message);
    return null;
  }
  return (data as Post | null) ?? null;
}

/** Sources, defended against a row whose jsonb is not the shape we expect. */
export function postSources(post: Pick<Post, "sources">): PostSource[] {
  if (!Array.isArray(post.sources)) return [];
  return post.sources.filter(
    (source): source is PostSource =>
      Boolean(source) &&
      typeof source === "object" &&
      typeof (source as PostSource).url === "string" &&
      /^https?:\/\//i.test((source as PostSource).url)
  );
}

export function postTags(post: Pick<Post, "tags">): string[] {
  return Array.isArray(post.tags) ? post.tags.filter((tag) => typeof tag === "string") : [];
}

/**
 * The byline for a post.
 *
 * Always names the machine. An article written by a model and bylined like a
 * person is the one thing a publication cannot do, so the model string is the
 * byline and the wallet that pressed publish is the editor beside it.
 */
export function postByline(post: Pick<Post, "model">): string {
  const model = post.model?.trim();
  if (!model) return "Folio article desk";
  const [provider, ...rest] = model.split(":");
  const name = rest.join(":") || provider;
  return `Folio article desk · ${name}`;
}

export { topicLabel } from "@/lib/topics";
