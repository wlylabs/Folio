import Link from "next/link";
import type { Metadata } from "next";
import JsonLd from "@/components/JsonLd";
import SetupNotice from "@/components/SetupNotice";
import { isSupabaseConfigured } from "@/lib/supabaseClient";
import { isTopic, listPosts, postPath, topicLabel, type PostCard } from "@/lib/posts";
import {
  POSTFOLIO_DESCRIPTION,
  POSTFOLIO_NAME,
  POSTFOLIO_PATH,
  POSTFOLIO_TAGLINE,
} from "@/lib/postfolio";
import { TOPICS } from "@/lib/topics";
import { blogJsonLd, isHttpUrl, pageTitle, socialMetadata } from "@/lib/seo";
import { formatAmount, formatDateShort } from "@/lib/types";

/**
 * Postfolio — the front page of the reading view.
 *
 * The launchpad's front page is a grid, because a grid is what a feed of
 * tradeable listings wants: every card carries the same four figures and the
 * reader scans down a column comparing them. Nothing on this page is
 * comparable in that sense — there is no supply, no ticker and no curve — so
 * it is laid out the way a blog is instead: one lead piece with its cover, a
 * dated column of everything else, and a rail beside it saying who writes
 * these and where the other half of the site is.
 *
 * Rendered per request rather than revalidated on a timer: the beat filter
 * reads searchParams, which opts the route out of static rendering anyway, and
 * a filter that answered from a five-minute cache would show a reader the beat
 * they asked for minus whatever the desk published since.
 */
export const dynamic = "force-dynamic";

const LIMIT = 60;

type Params = { searchParams: { topic?: string | string[] } };

/** The beat asked for in the query string, or null for the whole publication. */
function selectedTopic(searchParams: Params["searchParams"]): string | null {
  const raw = Array.isArray(searchParams.topic) ? searchParams.topic[0] : searchParams.topic;
  return isTopic(raw) ? raw : null;
}

export function generateMetadata({ searchParams }: Params): Metadata {
  const topic = selectedTopic(searchParams);
  const title = topic ? `${topicLabel(topic)} — ${POSTFOLIO_NAME}` : POSTFOLIO_NAME;
  const description = topic
    ? `Everything ${POSTFOLIO_NAME} has published on ${topicLabel(topic)}, newest first.`
    : POSTFOLIO_DESCRIPTION;

  return {
    title: pageTitle(title),
    description,
    // A filtered view is the same articles in a shorter list, so it points its
    // canonical at the unfiltered page and asks not to be indexed itself.
    // Three near-identical index pages competing with each other is the
    // classic way a small archive spends its crawl budget on nothing.
    alternates: { canonical: POSTFOLIO_PATH },
    ...(topic ? { robots: { index: false, follow: true } } : {}),
    ...socialMetadata({ title, description, path: POSTFOLIO_PATH }),
  };
}

export default async function PostfolioPage({ searchParams }: Params) {
  if (!isSupabaseConfigured) return <SetupNotice />;

  const topic = selectedTopic(searchParams);
  const posts = await listPosts(LIMIT, { topic });
  const [lead, ...rest] = posts;

  return (
    <main id="main" className="shell page">
      {/* Only on the unfiltered page: the Blog node describes the publication,
          and a beat is a view of it rather than a second publication. */}
      {!topic && <JsonLd data={blogJsonLd(posts)} />}

      <header className="pf-mast">
        <p className="pf-mast__eyebrow">A Folio publication</p>
        <h1 className="pf-mast__name">{POSTFOLIO_NAME}</h1>
        <p className="pf-mast__tagline">{POSTFOLIO_TAGLINE}</p>
        <p className="pf-mast__lede">
          Articles on AI, technology and crypto, written by Folio&apos;s desk agent from
          headlines the outlets syndicated and published by a person who read the draft first.
          Every piece lists what it was written from. Nothing here has a token behind it — for
          that, the <Link href="/">launchpad</Link> is the other half of the site.
        </p>
      </header>

      <nav className="pf-topics" aria-label="Beats">
        <Link
          href={POSTFOLIO_PATH}
          className="pf-topic"
          data-on={topic ? undefined : "true"}
          aria-current={topic ? undefined : "page"}
        >
          All
        </Link>
        {TOPICS.map((slug) => (
          <Link
            key={slug}
            href={`${POSTFOLIO_PATH}?topic=${slug}`}
            className="pf-topic"
            data-on={topic === slug ? "true" : undefined}
            aria-current={topic === slug ? "page" : undefined}
          >
            {topicLabel(slug)}
          </Link>
        ))}
      </nav>

      {posts.length === 0 ? (
        <div className="empty">
          <p style={{ marginBottom: "var(--sp-2)" }}>
            {topic
              ? `Nothing on ${topicLabel(topic)} yet.`
              : "The desk hasn't run anything yet."}
          </p>
          <p
            className="font-ui"
            style={{ fontSize: "var(--fs-small)", marginBottom: "var(--sp-5)" }}
          >
            {/*
              No "write the first one" here. The desk is staff, and this page is
              read by everyone — offering a button that answers "not you" is
              worse than offering nothing. The offer a visitor can actually take
              is the launchpad, so that is the one made.
            */}
            Articles here are written by Folio&apos;s agent and published by the desk. To publish
            one of your own, launch it with a token.
          </p>
          <Link href="/create" className="btn btn--primary">
            Launch a token
          </Link>
        </div>
      ) : (
        <>
          {lead && <LeadEntry post={lead} />}

          <div className="pf-layout">
            <div>
              <div className="section-head">
                <h2 className="eyebrow">
                  {topic ? `More on ${topicLabel(topic)}` : "Everything the desk has run"}
                </h2>
                <span className="eyebrow nums">{formatAmount(posts.length)} published</span>
              </div>

              {rest.length > 0 ? (
                <div className="pf-list">
                  {rest.map((post) => (
                    <Entry key={post.id} post={post} />
                  ))}
                </div>
              ) : (
                <p className="pf-list__end">
                  That is the whole archive so far — one piece.{" "}
                  {topic && <Link href={POSTFOLIO_PATH}>Read the other beats</Link>}
                </p>
              )}
            </div>

            <Rail />
          </div>
        </>
      )}
    </main>
  );
}

/**
 * The lead piece: cover, headline, standfirst, date.
 *
 * A blog leads with one article at full width rather than with the newest cell
 * of a grid, and the difference is not decoration — it is the page saying which
 * piece it thinks you should read.
 */
function LeadEntry({ post }: { post: PostCard }) {
  // The two-column arrangement is the cover's, not the lead's: without one
  // there is no second column to fill, and a headline set across half a
  // 70rem shell with nothing beside it reads as a layout that failed to load.
  const cover = isHttpUrl(post.cover_url) ? post.cover_url : null;

  return (
    <Link href={postPath(post)} className={`pf-lead${cover ? " pf-lead--figure" : ""}`}>
      {cover && (
        <div className="pf-lead__cover">
          {/* Plain <img>: next/image is deliberately unused, see next.config.js. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cover} alt="" loading="eager" />
        </div>
      )}

      <div className="pf-lead__text">
        <p className="pf-entry__meta">
          <span className="pf-entry__topic">{topicLabel(post.topic)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={post.created_at} className="nums">
            {formatDateShort(post.created_at)}
          </time>
        </p>
        <h2 className="pf-lead__title">{post.title}</h2>
        {post.excerpt && <p className="pf-lead__excerpt">{post.excerpt}</p>}
        <span className="pf-lead__more">Read the article →</span>
      </div>
    </Link>
  );
}

/** One row of the archive. Thumbnail if the piece has one, hairline if not. */
function Entry({ post }: { post: PostCard }) {
  return (
    <Link href={postPath(post)} className="pf-entry">
      <div className="pf-entry__text">
        <p className="pf-entry__meta">
          <span className="pf-entry__topic">{topicLabel(post.topic)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={post.created_at} className="nums">
            {formatDateShort(post.created_at)}
          </time>
        </p>
        <h3 className="pf-entry__title">{post.title}</h3>
        {post.excerpt && <p className="pf-entry__excerpt">{post.excerpt}</p>}
      </div>

      {isHttpUrl(post.cover_url) && (
        <div className="pf-entry__thumb">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={post.cover_url} alt="" loading="lazy" />
        </div>
      )}
    </Link>
  );
}

/**
 * The rail. A blog's sidebar, carrying the two things this one owes a reader:
 * who wrote what they are about to read, and where the rest of the site is.
 */
function Rail() {
  return (
    <aside className="pf-rail" aria-label="About Postfolio">
      <section className="pf-rail__block">
        <h2 className="pf-rail__head">Who writes this</h2>
        <p>
          Every article is drafted by Folio&apos;s desk agent from headlines syndicated by AI,
          technology and crypto outlets, then published by a person at the desk who read it
          first. The byline names the model, never the editor — a piece a machine wrote and a
          person approved is not a piece by that person.
        </p>
      </section>

      <section className="pf-rail__block">
        <h2 className="pf-rail__head">Beats</h2>
        <ul className="pf-rail__list">
          {TOPICS.map((slug) => (
            <li key={slug}>
              <Link href={`${POSTFOLIO_PATH}?topic=${slug}`}>{topicLabel(slug)}</Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="pf-rail__block">
        <h2 className="pf-rail__head">The other half</h2>
        <p>
          Folio&apos;s launchpad is the same publication with a market attached: there, the
          article is a listing and the token it describes trades from the page it is written on.
        </p>
        <div className="pf-rail__actions">
          <Link href="/" className="btn btn--outline btn--sm">
            Open the launchpad
          </Link>
        </div>
      </section>
    </aside>
  );
}
