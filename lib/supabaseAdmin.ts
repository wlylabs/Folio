import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * A Supabase client for server-only code — currently the launch indexer.
 *
 * It prefers `SUPABASE_SERVICE_ROLE_KEY` and falls back to the anon key, which
 * both work: the row-level security policy in lib/schema.sql lets anyone insert
 * a listing that passes its checks, and an indexed launch does. The service role
 * is still worth setting, because it is what lets the indexer *update* a row
 * later without loosening the public policy to allow updates from browsers.
 *
 * This module must never be imported from a client component. The service role
 * key bypasses row-level security entirely, and anything imported into the
 * browser bundle is public.
 */
export function serverSupabase(): SupabaseClient | null {
  const key = serviceRoleKey || anonKey;
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** True when the indexer is writing with the service role rather than the
 *  public anon key. Reported by the indexer endpoint so a misconfiguration is
 *  visible rather than silent. */
export const hasServiceRole = Boolean(serviceRoleKey);
