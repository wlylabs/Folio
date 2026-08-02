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

-- Whether creator_wallet was proved rather than claimed.
--
-- True only for rows inserted through a Sign-In With Ethereum session: the
-- publisher signed a message naming this site and that address, and the policy
-- below checked the signed address against the row. Default false, which is
-- what every row written before verification existed honestly is — and what a
-- row inserted with the plain anon key stays, because the anon policy refuses
-- to store anything else.
alter table tokens add column if not exists creator_verified boolean not null default false;

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
-- There are two insert policies, and the difference between them is the whole
-- of Folio's wallet verification:
--
--   anon           the public key, which carries no wallet identity. It may
--                  still publish — a launch is a public act and a deployment
--                  with verification switched off must keep working — but the
--                  row it writes is stamped creator_verified = false and it
--                  cannot say otherwise.
--   authenticated  a JWT minted by app/api/auth/verify/route.ts after checking
--                  an EIP-4361 signature. It carries a `wallet` claim, the
--                  policy below insists the row's creator_wallet is that
--                  wallet, and only then may the row call itself verified.
--
-- So creator_wallet is a claim or a proof, and the row says which. Nothing has
-- to trust the client about it: the comparison happens in Postgres, where a
-- component cannot forget to make it.
--
-- Powers that move money are still not decided here. claimFees and the
-- migration prompt read creator() off the contract, because a database row —
-- verified or not — is the wrong authority for a payout.
-- ---------------------------------------------------------------------------
alter table tokens enable row level security;

drop policy if exists "tokens are publicly readable" on tokens;
create policy "tokens are publicly readable"
  on tokens for select
  using (true);

-- The shape checks both insert policies share.
--
-- A function rather than the same fifteen lines written twice: the two policies
-- differ over *who* may publish and whether the row may call itself verified,
-- and they must never differ over what a well-formed listing is. Two copies of
-- that list is two copies to keep in step, and the one that gets forgotten is
-- the one an attacker finds.
create or replace function public.folio_listing_is_well_formed(
  p_name text,
  p_symbol text,
  p_article_title text,
  p_article_body text,
  p_supply numeric,
  p_starting_price numeric,
  p_contract_address text,
  p_creator_wallet text,
  p_avatar_url text
) returns boolean
language sql
immutable
as $$
  select
    length(p_name) between 1 and 64
    and length(p_symbol) between 1 and 16
    and length(p_article_title) between 1 and 200
    and length(p_article_body) <= 100000
    and p_supply > 0
    and p_starting_price > 0
    and p_contract_address ~ '^0x[0-9a-f]{40}$'
    and p_creator_wallet ~ '^0x[0-9a-fA-F]{40}$'
    -- An avatar is a file this site uploaded to its own storage bucket, and a
    -- row is free to carry none. What it may not carry is a URL pointing
    -- anywhere else: the column is rendered into an <img src> on the front
    -- page, on every listing and in the og:image of both, so an arbitrary
    -- value is a way to make every reader's browser announce itself to a
    -- server of the author's choosing. Two other layers refuse the same thing
    -- — components/Mark.tsx and the img-src directive in
    -- lib/securityHeaders.js — and this is the one that stops it being stored.
    and (
      p_avatar_url is null
      or p_avatar_url ~ '^https://[a-z0-9.-]+/storage/v1/object/public/token-avatars/'
    )
$$;

drop policy if exists "anyone may publish a token" on tokens;
create policy "anyone may publish a token"
  on tokens for insert
  to anon
  with check (
    public.folio_listing_is_well_formed(
      name, symbol, article_title, article_body,
      supply, starting_price, contract_address, creator_wallet, avatar_url
    )
    -- The anon key proves nothing about who is holding it, so a row inserted
    -- with it may not claim its byline was proved. This is the clause that
    -- makes creator_verified worth reading.
    and creator_verified = false
  );

drop policy if exists "a proved wallet may publish under its own address" on tokens;
create policy "a proved wallet may publish under its own address"
  on tokens for insert
  to authenticated
  with check (
    public.folio_listing_is_well_formed(
      name, symbol, article_title, article_body,
      supply, starting_price, contract_address, creator_wallet, avatar_url
    )
    -- The claim minted by app/api/auth/verify/route.ts, which put it there only
    -- after checking a signature over a message naming this site, this address
    -- and a nonce it had issued minutes earlier.
    and lower(creator_wallet) = lower(coalesce(auth.jwt() ->> 'wallet', ''))
    and creator_verified = true
  );

-- ---------------------------------------------------------------------------
-- The trade log
--
-- Every `TokensBought` and `TokensSold` carries the marginal price the trade
-- left behind, so a launch's whole price history is already on chain and this
-- table stores nothing the chain is not the authority on. It is a *cache of the
-- log*, and the distinction matters twice over: nothing here is ever the source
-- of a price a trade settles at, and a row that disagrees with the chain is a
-- bug in the recorder rather than a second opinion.
--
-- What it buys is the history the chain will not hand back cheaply. Reading it
-- live means walking `eth_getLogs` backwards from the head, which is bounded by
-- how many round trips a page load can afford — about 108,000 blocks. On a
-- two-second chain that was six days. Robinhood Chain mines every 0.1s, so the
-- same walk reaches **three hours**, and a launch's chart forgot everything
-- older than one afternoon. Reaching a week would be some 600 `eth_getLogs`
-- calls per reader per page view, which is not a slower answer, it is no answer.
--
-- So the log is walked once, forward, and kept. `lib/tradeRecorder.ts` writes;
-- `lib/tradeHistory.ts` reads here first and tops up from the chain for the
-- blocks written since. The chart then costs one indexed query and shows the
-- whole life of a launch rather than its last three hours.
--
-- Writes are service-role only, and that is a security property rather than an
-- oversight. A public insert policy on this table would let anyone hold the
-- anon key write price history for a launch they do not own — invented rallies,
-- invented crashes, in the one panel a reader looks at to decide whether to
-- buy. There is no shape check that makes forged trades safe, so the policy
-- refuses everybody instead and the recorder runs on the server. A deployment
-- with no `SUPABASE_SERVICE_ROLE_KEY` records nothing and falls back to the
-- bounded live scan, which is exactly what it did before this table existed.
-- ---------------------------------------------------------------------------
create table if not exists trades (
  chain text not null,                  -- slug from SUPPORTED_CHAINS
  token_address text not null,          -- lowercased, like every address here
  block_number bigint not null,
  -- Position in the block. A transaction hash is not a unique key — a contract
  -- calling buy() twice emits two trades under one hash — so the key carries
  -- the log's own index and re-recording a block cannot double a trade.
  log_index integer not null,
  tx_hash text not null,
  side text not null check (side in ('buy', 'sell')),
  trader text not null,
  -- ETH into the curve on a buy, out of it on a sell. Gross of the fee.
  eth numeric not null,
  -- Whole tokens issued on a buy, burned on a sell.
  tokens numeric not null,
  -- The marginal price the trade left behind, in ETH per whole token. This is
  -- the number the chart plots, and it is emitted by the contract after the
  -- effects of the trade — a settlement, never a sample.
  price numeric not null,
  -- Null where the block header could not be read. The chart falls back to even
  -- spacing when that happens, which is visibly approximate; a guessed
  -- timestamp would not be.
  block_time timestamptz,
  primary key (chain, token_address, block_number, log_index)
);

-- The one query the chart makes: the last N trades of one launch, newest first.
create index if not exists trades_token_idx
  on trades (chain, token_address, block_number desc, log_index desc);

-- ---------------------------------------------------------------------------
-- How far the recorder has read, per launch
--
-- Without this every scan would start from the token's creation block and
-- re-read the whole log to find the handful of trades since the last one. With
-- it a scan covers the blocks written since it last ran, which on a chain
-- mining ten blocks a second is the difference between a bounded cost and one
-- that grows with the age of the launch.
--
-- `first_block` is the other end: the block the token was created in, found
-- once by bisecting on `eth_getCode` and then never looked for again. It is
-- kept so a later scan can tell "recorded from the beginning" apart from
-- "recorded from wherever the first reader happened to arrive", which is the
-- difference between a complete history and a chart that quietly starts late.
-- ---------------------------------------------------------------------------
create table if not exists trade_cursors (
  chain text not null,
  token_address text not null,
  first_block bigint not null,
  last_block bigint not null,
  updated_at timestamptz not null default now(),
  primary key (chain, token_address)
);

alter table trades enable row level security;
alter table trade_cursors enable row level security;

-- Readable by everyone: it is a copy of a public event log, and the chart is
-- drawn in the browser.
drop policy if exists "trades are publicly readable" on trades;
create policy "trades are publicly readable"
  on trades for select
  using (true);

drop policy if exists "trade cursors are publicly readable" on trade_cursors;
create policy "trade cursors are publicly readable"
  on trade_cursors for select
  using (true);

-- No insert, update or delete policy on either table, deliberately. A table
-- with RLS on and no policy for an action refuses that action to every role
-- except the service role, which bypasses RLS — and the service role is the
-- only thing that should be writing a price history.

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
