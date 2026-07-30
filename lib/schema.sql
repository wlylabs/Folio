-- Folio schema. Run this in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- Safe to re-run: every statement is guarded.

create table if not exists tokens (
  id uuid primary key default gen_random_uuid(),
  contract_address text unique not null,
  chain text not null,                 -- 'base-sepolia' | 'sepolia'
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
