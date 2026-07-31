import Link from "next/link";
import type { Metadata } from "next";
import SetupNotice from "@/components/SetupNotice";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { listPosts, postPath, topicLabel } from "@/lib/posts";
import { pageTitle, socialMetadata } from "@/lib/seo";
import { formatAmount, formatDateShort } from "@/lib/types";

/**
 * The article archive.
 *
 * The front page mixes articles with launches, because that is the edition. This
 * is the other view a publication needs: everything the desk has written, in
 * order, at one URL a reader can bookmark and a crawler can walk. It is also
 * where /read/<slug> sends anyone who wants more.
 */
export const revalidate = 300;

const TITLE = "Articles";

const DESCRIPTION =
  "Folio's coverage of AI, technology and crypto — written by the desk agent from what the outlets syndicated, attributed to the headlines it worked from.";

export const metadata: Metadata = {
  title: pageTitle(TITLE),
  description: DESCRIPTION,
  alternates: { canonical: "/read" },
  ...socialMetadata({ title: TITLE, description: DESCRIPTION, path: "/read" }),
};

export default async function ReadIndexPage() {
  if (!isSupabaseConfigured) return <SetupNotice />;

  const posts = await listPosts(60);

  return (
    <main id="main" className="shell page">
      <header style={{ marginBottom: "var(--sp-5)" }}>
        <p className="eyebrow">Article desk</p>
        <h1
          style={{ fontWeight: 900, fontSize: "var(--fs-h1)", margin: "var(--sp-2) 0 var(--sp-3)" }}
        >
          Articles
        </h1>
        <p style={{ color: "var(--ink-soft)", maxWidth: "var(--measure)" }}>
          Written by Folio&apos;s desk agent from headlines syndicated by AI, technology and crypto
          outlets, and published by a person who read the draft first. Every piece lists the
          headlines it was written from.
        </p>
      </header>

      <div className="section-head">
        <h2 className="eyebrow">Everything the desk has run</h2>
        {posts.length > 0 && (
          <span className="eyebrow nums">{formatAmount(posts.length)} published</span>
        )}
      </div>

      {posts.length === 0 ? (
        <div className="empty">
          <p style={{ marginBottom: "var(--sp-2)" }}>The desk hasn&apos;t run anything yet.</p>
          <p
            className="font-ui"
            style={{ fontSize: "var(--fs-small)", marginBottom: "var(--sp-5)" }}
          >
            An article takes one press and about a minute. No wallet, no gas.
          </p>
          <Link href="/create/article" className="btn btn--primary">
            Write the first one
          </Link>
        </div>
      ) : (
        <div className="feed">
          {posts.map((post, i) => (
            <Link
              key={post.id}
              href={postPath(post)}
              className={`card${i === 0 ? " card--lead" : ""}`}
            >
              <div className="card__meta">
                <span className="card__kicker">{topicLabel(post.topic)}</span>
              </div>
              <h3 className="card__title">{post.title}</h3>
              {post.excerpt && <p className="card__excerpt">{post.excerpt}</p>}
              <div className="card__foot">
                <span>Article</span>
                <span className="nums">{formatDateShort(post.created_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
