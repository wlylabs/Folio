-- Folio schema. Run this in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- Safe to re-run: every statement is guarded.
--
-- ---------------------------------------------------------------------------
-- What this table is for, now that launches run on a bonding curve
--
-- It stores the article, and nothing that the chain is the authority on. The
-- factory migration deliberately added no columns: curve terms, reserve, price,
-- supply issued and pause state are all read from the token contract on each
-- request (lib/tokenStats.ts), because a copy in Postgres could only ever be
-- stale — nothing on chain writes back here.
--
-- Two columns are therefore worth reading carefully:
--
--   starting_price  the curve's *opening* marginal price, virtualEthReserve
--                   divided by supply. It is a record of where the launch
--                   began, not a price anything trades at. Every live price
--                   comes from getBuyQuote/getSellPrice.
--   sold_amount     only a fallback for rows whose contract can't be reached.
--
-- Rows written by /api/indexer (a launch created outside the site) carry a
-- placeholder article and a real address, supply and creator from the
-- TokenCreated event.
-- ---------------------------------------------------------------------------

create table if not exists tokens (
  id uuid primary key default gen_random_uuid(),
  contract_address text unique not null,
  chain text not null,                 -- a slug from SUPPORTED_CHAINS in lib/chains.ts,
                                       -- e.g. 'base-sepolia' | 'robinhood-testnet'
  name text not null,
  symbol text not null,
  supply numeric not null,
  starting_price numeric not null,
  creator_wallet text not null,
  article_title text not null,
  article_body text not null,          -- HTML from Tiptap, sanitized again on render
  avatar_url text,
  sold_amount numeric not null default 0,
  deploy_tx text,
  created_at timestamptz not null default now()
);

-- Older deployments of this project predate these columns.
alter table tokens add column if not exists avatar_url text;
alter table tokens add column if not exists sold_amount numeric not null default 0;
alter table tokens add column if not exists deploy_tx text;

-- Addresses are stored lowercased so URL lookups are case-insensitive.
create index if not exists tokens_creator_wallet_idx on tokens (lower(creator_wallet));
create index if not exists tokens_created_at_idx on tokens (created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The browser talks to Supabase with the anon key, which is public by design.
-- Without RLS anyone holding it can rewrite or delete every listing. These
-- policies allow public reads and inserts (a launch is a public act) but no
-- updates and no deletes from the client.
--
-- Note this cannot prove the inserted creator_wallet belongs to the caller —
-- the anon key carries no wallet identity. Treat creator_wallet as a claim,
-- not an authenticated fact. Verifying it needs signature-based auth
-- (Sign-In With Ethereum) issuing a Supabase JWT, which this scaffold does
-- not implement.
-- ---------------------------------------------------------------------------
alter table tokens enable row level security;

drop policy if exists "tokens are publicly readable" on tokens;
create policy "tokens are publicly readable"
  on tokens for select
  using (true);

drop policy if exists "anyone may publish a token" on tokens;
create policy "anyone may publish a token"
  on tokens for insert
  with check (
    length(name) between 1 and 64
    and length(symbol) between 1 and 16
    and length(article_title) between 1 and 200
    and length(article_body) <= 100000
    and supply > 0
    and starting_price > 0
    and contract_address ~ '^0x[0-9a-f]{40}$'
  );

-- ---------------------------------------------------------------------------
-- Delisted launches
--
-- Deleting a listing is not enough on its own to make it stay gone. The token
-- still exists on chain, so the next indexer run reads its TokenCreated log and
-- writes the row straight back (lib/indexer.ts). This table is the tombstone
-- that makes a deletion stick: the indexer skips every address in it.
--
-- It is deliberately separate from `tokens` rather than a `delisted_at` column,
-- because a delisted launch should leave nothing behind — the article, the
-- title and the creator's address all go with the row. What stays is an
-- address and a reason.
--
-- Reads are public and writes are not. Public reads look generous for an
-- operator's list, but the indexer falls back to the anon key when no service
-- role is configured (lib/supabaseAdmin.ts), and a tombstone it cannot read is
-- a tombstone that silently stops working — the deleted listing would reappear
-- on the next run. The addresses are on chain already; `reason` is the only
-- thing here that isn't, so keep it a short note rather than an accusation.
-- ---------------------------------------------------------------------------
create table if not exists delisted_tokens (
  contract_address text primary key,
  chain text,
  reason text,
  delisted_at timestamptz not null default now()
);

alter table delisted_tokens enable row level security;

drop policy if exists "delistings are publicly readable" on delisted_tokens;
create policy "delistings are publicly readable"
  on delisted_tokens for select
  using (true);

-- ---------------------------------------------------------------------------
-- Articles that are not launches
--
-- Folio publishes two things. A launch writes to `tokens`: an article with a
-- contract behind it, written by whoever pays the gas. The staff article desk
-- writes here: a piece of writing with nothing behind it but its sources — no
-- contract, no curve, no transaction, no gas. The two share a front page and a
-- house style and nothing else, which is why this is a separate table rather
-- than a nullable contract_address on `tokens`. Every column over there
-- describes a token; none of them would ever be filled in for a post.
--
-- The rows are written by the article agent (lib/ai/writer.ts) from headlines
-- it reads off public RSS feeds, so two columns carry the provenance that makes
-- that publishable rather than laundered:
--
--   sources  the feed items the draft was written from — title, url, publisher.
--            Rendered at the foot of every post as a real list of links. A
--            draft that cannot say where it came from is rejected before it
--            reaches this table (app/api/articles/publish/route.ts).
--   model    which model wrote it, e.g. 'groq:llama-3.3-70b-versatile'. The
--            byline says a machine wrote the piece and this says which one.
--
-- ---------------------------------------------------------------------------
-- Writes are server-side only
--
-- Unlike a launch, publishing here costs nothing — no gas, no signature, no
-- transaction to wait on. That is the whole point of the desk and also its only
-- real risk: anyone holding the public anon key could fill the feed at no cost.
-- So there is no insert policy for the anon role. Posts are written by the
-- route handlers in app/api/articles/ using SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS, and a deployment without that key can read posts but cannot
-- publish one. /api/articles/publish says so plainly rather than failing with a
-- policy error.
--
-- The same reasoning runs one layer up: the route itself is behind the desk
-- password (lib/desk.ts), because a rate limit decided how fast a stranger
-- could fill the feed and never whether they could. The public way onto Folio
-- is the launchpad, where the chain does the pricing.
-- ---------------------------------------------------------------------------
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,           -- kebab-case, the /postfolio/<slug> URL
  title text not null,
  excerpt text not null,               -- the meta description, written not derived
  body text not null,                  -- HTML from markdown, sanitized before insert
                                       -- and again on render
  topic text not null,                 -- 'ai' | 'technology' | 'crypto', see lib/ai/news.ts
  tags text[] not null default '{}',
  sources jsonb not null default '[]', -- [{ title, url, publisher, published_at }]
  model text,                          -- provider:model that produced the draft
  author_wallet text,                  -- the wallet that pressed publish. A claim,
                                       -- not a proof — same caveat as tokens.
  cover_url text,
  created_at timestamptz not null default now()
);

create index if not exists posts_created_at_idx on posts (created_at desc);
create index if not exists posts_topic_idx on posts (topic);

alter table posts enable row level security;

drop policy if exists "posts are publicly readable" on posts;
create policy "posts are publicly readable"
  on posts for select
  using (true);

-- Deliberately no insert, update or delete policy. See the note above: the
-- service role is the only writer.

-- ---------------------------------------------------------------------------
-- Storage bucket for token avatars.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('token-avatars', 'token-avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars are publicly readable" on storage.objects;
create policy "avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'token-avatars');

drop policy if exists "anyone may upload an avatar" on storage.objects;
create policy "anyone may upload an avatar"
  on storage.objects for insert
  with check (bucket_id = 'token-avatars');
