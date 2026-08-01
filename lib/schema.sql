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
                                       -- e.g. 'robinhood-mainnet'
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
    and creator_wallet ~ '^0x[0-9a-fA-F]{40}$'
    -- An avatar is a file this site uploaded to its own storage bucket, and a
    -- row is free to carry none. What it may not carry is a URL pointing
    -- anywhere else: the column is rendered into an <img src> on the front
    -- page, on every listing and in the og:image of both, so an arbitrary
    -- value is a way to make every reader's browser announce itself to a
    -- server of the author's choosing. Two other layers refuse the same thing
    -- — components/Mark.tsx and the img-src directive in
    -- lib/securityHeaders.js — and this is the one that stops it being stored.
    and (
      avatar_url is null
      or avatar_url ~ '^https://[a-z0-9.-]+/storage/v1/object/public/token-avatars/'
    )
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
-- Storage bucket for token avatars.
--
-- Uploads are open — publishing a launch is a public act and there is no
-- account to attach one to — which makes the bucket's own limits the only thing
-- standing between "anyone may upload an avatar" and "anyone may host anything
-- here". So they are set rather than left at the default of no limit at all:
--
--   file_size_limit      2 MB, the same ceiling app/create/LaunchForm.tsx shows
--                        the reader. The client's check is a courtesy; this one
--                        is the rule, because a browser is not where a limit
--                        can be enforced.
--   allowed_mime_types   raster images only. Without it the bucket accepts an
--                        HTML file and serves it back with its own content
--                        type, which is a stored cross-site scripting page
--                        hosted on the project's domain — the one place a
--                        reader has been told is Folio's. SVG is left out for
--                        the same reason and not by oversight: an SVG is a
--                        document that may carry script, harmless inside the
--                        <img> the page draws it in and not harmless at all
--                        when the link to it is opened directly.
--
-- `do update` rather than `do nothing`: a project created before this file
-- carried the limits has a bucket row with neither, and it should pick them up
-- on the next run.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'token-avatars',
  'token-avatars',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatars are publicly readable" on storage.objects;
create policy "avatars are publicly readable"
  on storage.objects for select
  using (bucket_id = 'token-avatars');

drop policy if exists "anyone may upload an avatar" on storage.objects;
create policy "anyone may upload an avatar"
  on storage.objects for insert
  with check (
    bucket_id = 'token-avatars'
    -- The extension the object is stored under, checked as well as the MIME
    -- type above: the two are declared separately on the way in, and a file
    -- claiming image/png while landing at avatar.html is exactly the case
    -- worth refusing.
    and storage.extension(name) in ('png', 'jpg', 'jpeg', 'gif', 'webp', 'avif')
  );
