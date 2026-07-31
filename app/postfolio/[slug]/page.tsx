import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import SetupNotice from "@/components/SetupNotice";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { readingMinutes, sanitizeArticleHtml } from "@/lib/sanitize";
import {
  getPost,
  listPosts,
  postByline,
  postPath,
  postSources,
  postTags,
  topicLabel,
  type PostCard,
} from "@/lib/posts";
import { POSTFOLIO_NAME, POSTFOLIO_PATH } from "@/lib/postfolio";
import { isHttpUrl, pageTitle, postJsonLd, socialMetadata } from "@/lib/seo";
import { formatDate, formatDateShort } from "@/lib/types";

/**
 * A published article, in Postfolio.
 *
 * Everything a token feature does not need and a blog post does: a standfirst,
 * a cover, a reading time, the beat it was filed under, and three more pieces
 * at the foot so the page has somewhere to go that is not back. What it does
 * not have is a rail of figures — there is no curve to quote and no contract to
 * link, which is exactly why these articles stopped sharing a layout with the
 * launchpad's.
 *
 * The source list stays, and it is the one thing here that is not presentation:
 * it is what a machine-written page owes its reader.
 *
 * Statically rendered and revalidated rather than dynamic, unlike a token page.
 * A post never changes after it is published — the `posts` table has no update
 * policy at all — so the only thing revalidation is for is picking up a slug
 * that did not exist at build time, and the "read next" strip beneath it.
 */
export const revalidate = 300;

/** How many pieces the foot of an article offers next. */
const READ_NEXT = 3;

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const post = await getPost(params.slug);
  if (!post) {
    return { title: pageTitle("Article not found"), robots: { index: false, follow: true } };
  }

  const path = postPath(post);

  return {
    title: pageTitle(post.title),
    description: post.excerpt,
    alternates: { canonical: path },
    ...(postTags(post).length ? { keywords: postTags(post) } : {}),
    ...socialMetadata({
      title: post.title,
      description: post.excerpt,
      path,
      image: post.cover_url,
      imageAlt: post.title,
      article: {
        publishedTime: post.created_at,
        authors: [postByline(post)],
      },
    }),
  };
}

export default async function PostfolioArticlePage({ params }: { params: { slug: string } }) {
  if (!isSupabaseConfigured) return <SetupNotice />;

  const post = await getPost(params.slug);
  if (!post) return notFound();

  const sources = postSources(post);
  const tags = postTags(post);
  const minutes = readingMinutes(post.body);
  const next = await readNext(post.slug, post.topic);

  return (
    <main id="main" className="shell shell--measure page pf-article">
      <JsonLd data={postJsonLd(post, sources)} />

      <p className="pf-article__back">
        <Link href={POSTFOLIO_PATH}>← {POSTFOLIO_NAME}</Link>
      </p>

      <header className="pf-article__head">
        <p className="pf-article__kicker">
          <Link href={`${POSTFOLIO_PATH}?topic=${post.topic}`}>{topicLabel(post.topic)}</Link>
        </p>

        <h1 className="pf-article__title">{post.title}</h1>

        {/* The excerpt is written as the summary of the piece, which is what a
            standfirst is. Printing it here rather than only in the <head>
            means the reader sees the same sentence the search result promised. */}
        {post.excerpt && <p className="pf-article__deck">{post.excerpt}</p>}

        <div className="pf-article__byline">
          {/*
            The byline names the machine. An article a model wrote and a person
            approved is not a piece by that person, and a publication that lets
            the distinction blur has spent the only thing a byline is worth.
            The wallet that pressed publish is stored on the row and is
            deliberately not printed here — it is an editor, not an author.
          */}
          <span className="pf-article__author">{postByline(post)}</span>
          <span className="pf-article__dateline nums">
            <time dateTime={post.created_at}>{formatDate(post.created_at)}</time>
            <span aria-hidden="true"> · </span>
            {minutes} min read
          </span>
        </div>
      </header>

      {isHttpUrl(post.cover_url) && (
        <figure className="pf-article__cover">
          {/* Plain <img>: next/image is deliberately unused, see next.config.js.
              Empty alt on purpose — the cover illustrates the headline directly
              above it and has no caption of its own, so describing it again
              would only make a screen reader read the article twice. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={post.cover_url} alt="" />
        </figure>
      )}

      <article
        className="article__body prose pf-prose"
        // Sanitized on the way in as well (lib/ai/publish.ts). Doing it again
        // here costs nothing and means a row written by any other route — or by
        // hand in the SQL editor — still cannot put a script on the page.
        dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(post.body) }}
      />

      {tags.length > 0 && (
        <div className="chip-row" style={{ marginTop: "var(--sp-6)" }}>
          {tags.map((tag) => (
            <span key={tag} className="chip" style={{ cursor: "default" }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {sources.length > 0 && (
        <section className="factbox" style={{ marginTop: "var(--sp-6)" }}>
          <h2 className="factbox__head">
            <span>Sources</span>
            <span>{sources.length}</span>
          </h2>
          {/*
            Not a footnote. This article was written from these headlines and
            nothing else, so the list is the reader's only way to check it
            against what the outlets actually reported — which is the deal a
            machine-written page has to offer to be worth publishing.
          */}
          <ul className="sources">
            {sources.map((source) => (
              <li key={source.url} className="sources__item">
                <a href={source.url} target="_blank" rel="nofollow noopener noreferrer">
                  {source.title}
                </a>
                <span className="sources__publisher">{source.publisher}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {next.length > 0 && (
        <section className="pf-next" aria-labelledby="read-next">
          <div className="section-head">
            <h2 className="eyebrow" id="read-next">
              Read next
            </h2>
            <Link href={POSTFOLIO_PATH} className="eyebrow">
              All articles
            </Link>
          </div>

          <div className="pf-next__grid">
            {next.map((item) => (
              <Link key={item.id} href={postPath(item)} className="pf-next__item">
                <p className="pf-entry__meta">
                  <span className="pf-entry__topic">{topicLabel(item.topic)}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={item.created_at} className="nums">
                    {formatDateShort(item.created_at)}
                  </time>
                </p>
                <h3 className="pf-next__title">{item.title}</h3>
              </Link>
            ))}
          </div>
        </section>
      )}

      <p className="pf-article__foot">
        Written by Folio&apos;s article desk from syndicated headlines, and checked by whoever
        published it. Nothing here is financial advice.{" "}
        <Link href={POSTFOLIO_PATH}>More from {POSTFOLIO_NAME}</Link> ·{" "}
        <Link href="/create">Launch your own</Link>
      </p>
    </main>
  );
}

/**
 * What to read after this one: the same beat first, topped up with the newest
 * pieces from anywhere when a beat is too thin to fill the row.
 *
 * The second query only runs when the first came up short, which on a desk
 * covering three beats is the common case early and the rare case later.
 */
async function readNext(slug: string, topic: string): Promise<PostCard[]> {
  const sameBeat = await listPosts(READ_NEXT, { topic, excludeSlug: slug });
  if (sameBeat.length >= READ_NEXT) return sameBeat;

  const seen = new Set(sameBeat.map((post) => post.id));
  const latest = await listPosts(READ_NEXT + sameBeat.length + 1, { excludeSlug: slug });

  return [...sameBeat, ...latest.filter((post) => !seen.has(post.id))].slice(0, READ_NEXT);
}
