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

/**
 * A client that speaks as a proved wallet rather than as the anonymous public.
 *
 * The token comes from `/api/auth/verify` (see `lib/walletAuth.ts`) and carries
 * the address the reader signed for. PostgREST validates it against the
 * project's JWT secret and exposes its claims to the policies, which is what
 * lets `lib/schema.sql` insist that a row's `creator_wallet` is the wallet that
 * signed — a check no component can skip, because it is not in a component.
 *
 * Deliberately not the shared instance, and deliberately not cached: this
 * client exists for the length of one publish, and a module-level client
 * holding a credential is a client that outlives the reason it had one.
 *
 * The anon key is still sent alongside. Supabase uses it to route the request
 * to the project; the `Authorization` header is what decides who is asking.
 */
export function supabaseAs(token: string): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase is not configured.");
  }

  return createClient(supabaseUrl!, supabaseAnonKey!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    // There is no Supabase-managed session here — the JWT was minted by
    // Folio's own route — so there is nothing to persist and nothing to
    // refresh. Leaving these on makes the client write a session it did not
    // create into storage and then try to renew it against an endpoint that
    // never issued it.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The table and storage bucket live in lib/schema.sql — run it in the
// Supabase SQL editor.
