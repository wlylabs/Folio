/**
 * Takes a published listing off the site.
 *
 *   npm run token:list                       # what is published
 *   npm run token:delete -- 0xabc… --reason "test launch"
 *   npm run token:delete -- 0xabc… --restore # undo, before the next index run
 *
 * A launch is two things: a contract on chain and a listing in Postgres. This
 * removes the listing. Nothing here touches the chain — the token keeps
 * existing, its curve keeps quoting, and anyone holding it can still sell back
 * through the contract. What goes away is the article and the token's presence
 * in the feed, the staff page and the /token/<address> route.
 *
 * Deleting the row is not enough by itself. The indexer rebuilds listings from
 * the factory's TokenCreated log (lib/indexer.ts), and that log is permanent, so
 * a plain delete comes back on the next run. Every deletion therefore writes a
 * tombstone into `delisted_tokens`, which the indexer reads and skips.
 *
 * Needs SUPABASE_SERVICE_ROLE_KEY. The public policies in lib/schema.sql allow
 * reads and inserts and nothing else, on purpose — a delete that the anon key
 * could perform is a delete anyone on the internet could perform.
 *
 * This deletes one listing on a chain the site still runs. For the rows left
 * behind by a chain that has been retired — the testnets — see
 * scripts/prune-testnet.mjs, which works by chain and writes no tombstones.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { date, fail, loadEnvFiles, removeAvatar, serviceClient } from "./lib/supabase.mjs";

loadEnvFiles();

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

const db = serviceClient();

if (args.list) {
  await list();
} else if (args.restore) {
  await restore(requireAddress());
} else {
  await remove(requireAddress());
}

/** Everything currently published, newest first, with its delisting history. */
async function list() {
  const { data, error } = await db
    .from("tokens")
    .select("contract_address, chain, name, symbol, article_title, created_at")
    .order("created_at", { ascending: false });

  if (error) fail(`Could not read listings: ${error.message}`);

  if (!data || data.length === 0) {
    console.log("Nothing is published.");
  } else {
    console.log(`${data.length} published listing(s), newest first:\n`);
    for (const row of data) {
      console.log(`  ${row.contract_address}`);
      console.log(`    $${row.symbol} — ${row.article_title || row.name}`);
      console.log(`    ${row.chain} · ${date(row.created_at)}\n`);
    }
  }

  const { data: tombstones, error: tombstoneError } = await db
    .from("delisted_tokens")
    .select("contract_address, reason, delisted_at")
    .order("delisted_at", { ascending: false });

  if (tombstoneError) {
    // A database that never ran the delisting part of schema.sql is not broken,
    // it just cannot delete anything yet. Say which it is.
    console.log(
      tombstoneError.code === "42P01"
        ? "\nNo delisted_tokens table yet — run lib/schema.sql before deleting anything."
        : `\nCould not read delistings: ${tombstoneError.message}`
    );
    return;
  }

  if (tombstones && tombstones.length > 0) {
    console.log(`${tombstones.length} delisted:\n`);
    for (const row of tombstones) {
      console.log(
        `  ${row.contract_address}  ${date(row.delisted_at)}${row.reason ? ` — ${row.reason}` : ""}`
      );
    }
  }
}

/** Delete one listing, and leave the tombstone that keeps it deleted. */
async function remove(address) {
  const { data: token, error } = await db
    .from("tokens")
    .select("*")
    .eq("contract_address", address)
    .maybeSingle();

  if (error) fail(`Could not read the listing: ${error.message}`);

  if (!token) {
    // Worth separating: an address that was already deleted is a no-op, an
    // address that was never here is probably a typo.
    const { data: tombstone } = await db
      .from("delisted_tokens")
      .select("delisted_at")
      .eq("contract_address", address)
      .maybeSingle();

    if (tombstone) {
      console.log(`Already delisted on ${date(tombstone.delisted_at)}. Nothing to do.`);
      return;
    }
    fail(`No listing for ${address}. Run \`npm run token:list\` to see what is published.`);
  }

  console.log("About to delete this listing:\n");
  console.log(`  title    ${token.article_title || token.name}`);
  console.log(`  token    ${token.name} ($${token.symbol})`);
  console.log(`  address  ${token.contract_address}`);
  console.log(`  chain    ${token.chain}`);
  console.log(`  creator  ${token.creator_wallet}`);
  console.log(`  written  ${date(token.created_at)}`);
  console.log(`  article  ${token.article_body?.length ?? 0} characters, deleted with the row`);
  console.log(
    "\nThe contract stays live on chain. Holders can still sell back to the curve.\n"
  );

  if (args.dryRun) {
    console.log("--dry-run: stopping here.");
    return;
  }

  await confirm(token.symbol);

  // Tombstone first. If the delete succeeds and the tombstone write fails, the
  // next indexer run puts the listing back and the deletion looks haunted;
  // this order can only fail the other way, leaving a tombstone for a row that
  // is still there — which suppresses nothing, because the row exists.
  const { error: tombstoneError } = await db.from("delisted_tokens").upsert(
    {
      contract_address: token.contract_address,
      chain: token.chain,
      reason: args.reason ?? null,
      delisted_at: new Date().toISOString(),
    },
    { onConflict: "contract_address" }
  );

  if (tombstoneError) {
    fail(
      tombstoneError.code === "42P01"
        ? "There is no delisted_tokens table. Run lib/schema.sql in the Supabase SQL editor first —\n" +
            "  without it the indexer would republish this listing within minutes."
        : `Could not record the delisting: ${tombstoneError.message}`
    );
  }

  const { error: deleteError } = await db
    .from("tokens")
    .delete()
    .eq("contract_address", token.contract_address);

  if (deleteError) fail(`Could not delete the listing: ${deleteError.message}`);

  console.log(`Deleted ${token.contract_address}.`);

  if (token.avatar_url && !args.keepAvatar) await removeAvatar(db, token.avatar_url);

  console.log("The indexer will skip this address from now on.");
}

/** Drop the tombstone, so the indexer may list the launch again. */
async function restore(address) {
  const { error } = await db.from("delisted_tokens").delete().eq("contract_address", address);

  if (error) fail(`Could not remove the delisting: ${error.message}`);

  console.log(`${address} is no longer delisted.`);
  console.log(
    "The row itself is gone for good — the article was deleted with it. The next\n" +
      "indexer run relists the launch from its TokenCreated log, with a placeholder\n" +
      "article: curl the site's /api/indexer, or run `npm run watch:launches`."
  );
}

/**
 * Ask before doing it. A terminal gets a prompt; anything else — CI, a pipe —
 * has to have said `--yes` up front, because there is nobody there to ask.
 */
async function confirm(symbol) {
  if (args.yes) return;

  if (!stdin.isTTY) {
    fail("Not a terminal, so there is nobody to confirm with. Re-run with --yes.");
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Type the symbol (${symbol}) to confirm: `);
    if (answer.trim().toLowerCase() !== String(symbol).toLowerCase()) {
      console.log("Left it alone.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

function requireAddress() {
  const address = args.address?.toLowerCase();
  if (!address) {
    usage();
    process.exit(1);
  }
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    fail(`${args.address} is not a contract address.`);
  }
  return address;
}

function parseArgs(argv) {
  const parsed = {
    address: null,
    reason: null,
    list: false,
    restore: false,
    keepAvatar: false,
    dryRun: false,
    yes: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--list":
        parsed.list = true;
        break;
      case "--restore":
        parsed.restore = true;
        break;
      case "--keep-avatar":
        parsed.keepAvatar = true;
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
      case "--reason":
        parsed.reason = argv[++i] ?? null;
        break;
      default:
        if (arg.startsWith("--reason=")) parsed.reason = arg.slice("--reason=".length);
        else if (arg.startsWith("-")) fail(`Unknown option ${arg}.`);
        else if (parsed.address) fail("One address at a time.");
        else parsed.address = arg;
    }
  }

  return parsed;
}

function usage() {
  console.log(`Remove a published listing.

  npm run token:list
  npm run token:delete -- <address> [--reason "..."] [--keep-avatar] [--dry-run] [--yes]
  npm run token:delete -- <address> --restore

The contract is never touched — this deletes the article and the listing only.
Requires SUPABASE_SERVICE_ROLE_KEY in .env.local.`);
}
