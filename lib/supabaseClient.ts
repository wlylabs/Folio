import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ---- Schema reference (create this table in Supabase SQL editor) ----
// create table tokens (
//   id uuid primary key default gen_random_uuid(),
//   contract_address text unique not null,
//   chain text not null,               -- 'base-sepolia' | 'sepolia'
//   name text not null,
//   symbol text not null,
//   supply numeric not null,
//   starting_price numeric not null,
//   creator_wallet text not null,
//   article_title text not null,
//   article_body text not null,        -- HTML from Tiptap
//   avatar_url text,
//   created_at timestamp default now()
// );
