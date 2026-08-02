/**
 * Deletes every listing that belongs to a chain Folio no longer supports.
 *
 *   npm run token:prune-testnet -- --dry-run   # what would go
 *   npm run token:prune-testnet
 *   npm run token:prune-testnet -- --chain base-sepolia
 *
 * Folio rehearsed on testnets before it ran on Robinhood Chain — Base Sepolia,
 * and a Robinhood testnet before that — and the rows those launches wrote are
 * still in `tokens`. Their `chain` slug no longer resolves, so the site can say
 * almost nothing true about them: no explorer link, no RPC to read the curve
 * from, and a network label that falls back to "Unsupported network". They are
 * dead weight in the feed. This removes them.
 *
 * Retired *is* the definition of what gets deleted: the script reads
 * SUPPORTED_CHAINS out of lib/chains.ts and deletes every row whose chain is not
 * in it. Nothing is hardcoded, so restoring a chain to that list takes its rows
 * out of range on the next run — and a parse that finds no chains at all stops
 * the script rather than treating every row as retired.
 *
 * No tombstone is written, and that is the difference from delete-token.mjs.
 * A tombstone exists to stop /api/indexer putting a deleted row straight back,
 * and the indexer only scans chains with a deployments/<slug>.json record. A
 * retired chain has none — nothing is watching it, so nothing will relist it.
 * Use `npm run token:delete` for a live listing; this is for the ones whose
 * network is gone.
 *
 * The contracts themselves are untouched, as ever. They are on a testnet, so
 * there was nothing at stake in them to begin with.
 */
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import {
  AVATAR_BUCKET,
  date,
  fail,
  loadEnvFiles,
  removeAvatar,
  root,
  serviceClient,
} from "./lib/supabase.mjs";

loadEnvFiles();

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

const supported = readSupportedSlugs();
const db = serviceClient();

await prune();

/**
 * Find the retired rows, show them, and — once somebody has said so — delete
 * them along with their avatars.
 */
async function prune() {
  const { data, error } = await db
    .from("tokens")
    .select("contract_address, chain, name, symbol, article_title, avatar_url, created_at")
    .order("created_at", { ascending: false });

  if (error) fail(`Could not read listings: ${error.message}`);

  const rows = (data ?? []).filter((row) =>
    args.chain ? row.chain === args.chain : !supported.has(row.chain)
  );

  console.log(`Supported chains: ${[...supported].join(", ")}`);

  if (rows.length === 0) {
    console.log(
      args.chain
        ? `Nothing is listed on ${args.chain}.`
        : "Every listing is on a supported chain. Nothing to prune."
    );
    return;
  }

  // A row on a chain that *is* supported can only appear here via --chain, and
  // that is worth saying out loud rather than deleting quietly: it means the
  // caller is removing live listings, which is what token:delete is for.
  const live = rows.filter((row) => supported.has(row.chain));
  if (live.length > 0) {
    console.log(
      `\n${args.chain} is a supported chain. These ${live.length} listing(s) are live, and\n` +
        "deleting them here writes no tombstone — the indexer will relist them within\n" +
        "minutes. Use `npm run token:delete -- <address>` instead."
    );
    process.exit(1);
  }

  console.log(`\n${rows.length} listing(s) on retired chains:\n`);
  for (const row of rows) {
    console.log(`  ${row.contract_address}`);
    console.log(`    $${row.symbol} — ${row.article_title || row.name}`);
    console.log(`    ${row.chain} · ${date(row.created_at)}${row.avatar_url ? " · avatar" : ""}\n`);
  }

  const byChain = new Map();
  for (const row of rows) byChain.set(row.chain, (byChain.get(row.chain) ?? 0) + 1);
  console.log(
    `By chain: ${[...byChain].map(([chain, count]) => `${chain} ${count}`).join(", ")}`
  );

  if (args.dryRun) {
    console.log("\n--dry-run: stopping here.");
    return;
  }

  await confirm(rows.length);

  // In batches, because `in` on a few hundred addresses is a URL long enough
  // for PostgREST to refuse — and a refusal halfway through a prune is a
  // partial delete either way, so it may as well be one that reports itself.
  let deleted = 0;
  for (const batch of chunk(rows, 50)) {
    const { error: deleteError } = await db
      .from("tokens")
      .delete()
      .in("contract_address", batch.map((row) => row.contract_address));

    if (deleteError) {
      console.error(`Stopped after ${deleted} deletion(s): ${deleteError.message}`);
      process.exit(1);
    }
    deleted += batch.length;
  }

  console.log(`\nDeleted ${deleted} listing(s).`);

  if (args.keepAvatars) {
    console.log("Left the avatars in storage (--keep-avatars).");
    return;
  }

  // After the rows, not before: an avatar deleted for a row that then survives
  // is a listing rendering a broken image, which is worse than an orphaned
  // object in a bucket.
  let avatars = 0;
  for (const row of rows) {
    if (row.avatar_url && (await removeAvatar(db, row.avatar_url, { quiet: true }))) avatars++;
  }
  if (avatars > 0) console.log(`Deleted ${avatars} avatar(s) from ${AVATAR_BUCKET}.`);
}

/**
 * The chain slugs SUPPORTED_CHAINS names, read out of lib/chains.ts.
 *
 * Parsed rather than imported: that file is TypeScript, and this script is Node.
 * Only the array's own text is searched, so a slug mentioned in a comment
 * elsewhere in the file cannot widen what counts as supported. An empty result
 * is a parse failure, never an answer — treating it as one would make every row
 * in the table retired.
 */
function readSupportedSlugs() {
  const path = join(root, "lib", "chains.ts");
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    fail(`Could not read ${path}. Run this from a checkout of the repository.`);
  }

  const block = /export const SUPPORTED_CHAINS = \[([\s\S]*?)\] as const;/.exec(source);
  const slugs = block ? [...block[1].matchAll(/slug:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]) : [];

  if (slugs.length === 0) {
    fail(
      "Could not read SUPPORTED_CHAINS out of lib/chains.ts.\n" +
        "  Refusing to continue: with no supported chain every listing looks retired,\n" +
        "  and this script would delete the whole table."
    );
  }

  return new Set(slugs);
}

/**
 * Ask before doing it. A terminal gets a prompt; anything else — CI, a pipe —
 * has to have said `--yes` up front, because there is nobody there to ask.
 *
 * The count is what gets typed back, not a yes: it is the one number somebody
 * skim-reading the list above might not have taken in.
 */
async function confirm(count) {
  if (args.yes) return;

  if (!stdin.isTTY) {
    fail("Not a terminal, so there is nobody to confirm with. Re-run with --yes.");
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`\nType ${count} to delete these listings: `);
    if (answer.trim() !== String(count)) {
      console.log("Left them alone.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseArgs(argv) {
  const parsed = {
    chain: null,
    keepAvatars: false,
    dryRun: false,
    yes: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--keep-avatars":
        parsed.keepAvatars = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--yes":
      case "-y":
        parsed.yes = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--chain":
        parsed.chain = argv[++i] ?? null;
        break;
      default:
        if (arg.startsWith("--chain=")) parsed.chain = arg.slice("--chain=".length);
        else fail(`Unknown option ${arg}. This script takes no address — it works by chain.`);
    }
  }

  if (parsed.chain !== null && !/^[a-z0-9-]+$/.test(parsed.chain)) {
    fail(`${parsed.chain} is not a chain slug.`);
  }

  return parsed;
}

function usage() {
  console.log(`Delete every listing on a chain Folio no longer supports.

  npm run token:prune-testnet -- --dry-run
  npm run token:prune-testnet -- [--chain <slug>] [--keep-avatars] [--yes]

Retired means "not in SUPPORTED_CHAINS in lib/chains.ts" — today the testnet
rows, Base Sepolia and older. The contracts are never touched, and no tombstone
is written: no indexer watches a retired chain, so nothing relists them. For a
listing on a live chain, use \`npm run token:delete\` instead.

Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.`);
}
