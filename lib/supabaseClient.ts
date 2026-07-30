import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * False when the env vars are absent. Pages check this and render a setup
 * notice instead of throwing, so a fresh clone builds and boots before
 * .env.local exists.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Supabase is not configured. Copy .env.example to .env.local and set " +
        "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }
  if (!client) {
    client = createClient(supabaseUrl!, supabaseAnonKey!);
  }
  return client;
}

/**
 * Instantiated on first use rather than at import time — importing this module
 * with no env set must not crash the build.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});

// The table and storage bucket live in lib/schema.sql — run it in the
// Supabase SQL editor.
