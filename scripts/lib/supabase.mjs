/**
 * What the operator scripts share: reaching Supabase with the service role, and
 * the small amount of housekeeping that goes with deleting a listing.
 *
 * These scripts run under plain Node, not Next, so none of lib/*.ts is
 * available to them — that is TypeScript the site compiles and Node does not.
 * This module is the Node-side equivalent of the two or three things they all
 * need, kept in one place so a fix to the env parser or the avatar path lands
 * in every script at once.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

/** The repository root, from this file's own location. */
export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const AVATAR_BUCKET = "token-avatars";

/**
 * Read .env.local, then .env, the way Next does — first file to name a variable
 * wins, and a variable already in the environment beats both.
 */
export function loadEnvFiles(names = [".env.local", ".env"]) {
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;

      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;

      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      } else {
        value = value.split(" #")[0].trim();
      }
      process.env[key] = value;
    }
  }
}

/**
 * A Supabase client holding the service role, or a stop with an explanation.
 *
 * Service role and not the anon key, because the public policies in
 * lib/schema.sql allow reads and inserts and nothing else, on purpose — a
 * delete the anon key could perform is a delete anyone on the internet could
 * perform.
 */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) fail("NEXT_PUBLIC_SUPABASE_URL is not set. Fill in .env.local first.");
  if (!serviceRoleKey) {
    fail(
      "SUPABASE_SERVICE_ROLE_KEY is not set.\n" +
        "  Supabase → Project Settings → API → service_role. Put it in .env.local,\n" +
        "  never in NEXT_PUBLIC_* and never in the browser bundle."
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Delete the avatar a listing uploaded, best effort.
 *
 * Best effort because the bucket is public and shared: a URL that doesn't parse
 * as one of ours, or an object that has already gone, is not a reason to leave
 * the deletion half done. Returns whether the object was removed, so a caller
 * deleting many rows can report a total.
 */
export async function removeAvatar(db, avatarUrl, { quiet = false } = {}) {
  const marker = `/storage/v1/object/public/${AVATAR_BUCKET}/`;
  const at = avatarUrl.indexOf(marker);

  if (at === -1) {
    if (!quiet) {
      console.log(`Left the avatar alone — ${avatarUrl} is not in the ${AVATAR_BUCKET} bucket.`);
    }
    return false;
  }

  const path = decodeURIComponent(avatarUrl.slice(at + marker.length).split("?")[0]);
  const { error } = await db.storage.from(AVATAR_BUCKET).remove([path]);

  if (error) {
    console.log(`Could not delete the avatar (${path}): ${error.message}`);
    return false;
  }

  if (!quiet) console.log(`Deleted the avatar ${path}.`);
  return true;
}

/** A timestamp as a plain date, or the word for not having one. */
export function date(value) {
  if (!value) return "undated";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "undated" : parsed.toISOString().slice(0, 10);
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}
