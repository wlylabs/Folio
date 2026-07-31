import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import SetupNotice from "@/components/SetupNotice";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { getPost, postByline, postSources, postTags, topicLabel } from "@/lib/posts";
import { pageTitle, postJsonLd, socialMetadata } from "@/lib/seo";
import { formatDate } from "@/lib/types";

/**
 * A published article.
 *
 * The same reading column and the same serif body as a token feature, because
 * it is the same kind of object — a piece of writing with a date and a byline.
 * What it does not have is a rail: there is no curve to quote, no contract to
 * link, nothing to trade. What it has instead is a source list, which is the
 * thing a machine-written article owes its reader.
 *
 * Statically rendered and revalidated rather than dynamic, unlike a token page.
 * A post never changes after it is published — the `posts` table has no update
 * policy at all — so the only thing revalidation is for is picking up a slug
 * that did not exist at build time.
 */
export const revalidate = 300;

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const post = await getPost(params.slug);
  if (!post) {
    return { title: pageTitle("Article not found"), robots: { index: false, follow: true } };
  }

  const path = `/read/${post.slug}`;

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

export default async function ReadPage({ params }: { params: { slug: string } }) {
  if (!isSupabaseConfigured) return <SetupNotice />;

  const post = await getPost(params.slug);
  if (!post) return notFound();

  const sources = postSources(post);
  const tags = postTags(post);

  return (
    <main id="main" className="shell shell--measure page">
      <JsonLd data={postJsonLd(post, sources)} />

      <div className="article__head">
        <p className="eyebrow">{topicLabel(post.topic)} · Article</p>

        <h1 className="article__title">{post.title}</h1>

        <div className="article__byline">
          {/*
            The byline names the machine. An article a model wrote and a person
            approved is not a piece by that person, and a publication that lets
            the distinction blur has spent the only thing a byline is worth.
            The wallet that pressed publish is stored on the row and is
            deliberately not printed here — it is an editor, not an author.
          */}
          <span>{postByline(post)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatDate(post.created_at)}</span>
        </div>
      </div>

      <article
        className="article__body prose"
        // Sanitized on the way in as well (lib/ai/publish.ts). Doing it again
        // here costs nothing and means a row written by any other route — or by
        // hand in the SQL editor — still cannot put a script on the page.
        dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(post.body) }}
      />

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

      {tags.length > 0 && (
        <div className="chip-row" style={{ marginTop: "var(--sp-5) " }}>
          {tags.map((tag) => (
            <span key={tag} className="chip" style={{ cursor: "default" }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      <p className="field__hint" style={{ marginTop: "var(--sp-6)" }}>
        Written by Folio&apos;s article desk from syndicated headlines, and checked by whoever
        published it. Nothing here is financial advice. <Link href="/read">More articles</Link> ·{" "}
        <Link href="/create/article">Write one</Link>
      </p>
    </main>
  );
}
