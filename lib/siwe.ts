/**
 * Sign-In With Ethereum messages (EIP-4361), built and read back.
 *
 * This module is the shared half of Folio's wallet authentication: the browser
 * builds a message here and asks the wallet to sign it, and the server reads
 * the very same text back here before it will believe a word of it. Keeping
 * both directions in one file is the point — a signed message is only as
 * trustworthy as the parser that decides what it said, and two implementations
 * of one grammar is how a `Chain ID` line ends up meaning different things at
 * each end.
 *
 * ## Why any of this exists
 *
 * `tokens.creator_wallet` used to be a claim. The browser talks to Supabase
 * with the public anon key, which carries no wallet identity at all, so
 * anybody could insert a row attributing a launch to somebody else's address —
 * and the only reason it never mattered much is that everything which decides
 * what a creator may *do* reads `creator()` off the contract instead. That is
 * still the right rule for money. It is not a reason to keep publishing an
 * unverifiable byline.
 *
 * A signature fixes the byline. The reader signs a statement naming this site,
 * this address and a nonce this server issued; the server checks all three and
 * mints a short-lived Supabase JWT carrying the address as a claim; the insert
 * policy in `lib/schema.sql` then refuses any row whose `creator_wallet` is not
 * that address. The claim becomes a proof, and it becomes one in Postgres
 * rather than in a component that could be skipped.
 *
 * ## What a signature does *not* buy
 *
 * It proves control of a key at a moment in time. It does not prove the signer
 * is the person the name suggests, and it does not make the launch itself
 * honest — the contract is still the authority on the market, and
 * `creator_verified` on a listing says exactly this much and no more: the
 * address on the byline signed for it.
 *
 * ## Deliberately not a dependency
 *
 * `siwe` is a perfectly good package, and it pulls in an ethers v6 tree to
 * hash and recover with — which this app already does through viem, on both
 * sides. The grammar below is the subset Folio emits: the whole message is
 * generated here, so the parser never has to meet a field this file cannot
 * write. It refuses anything with a line it does not recognise rather than
 * ignoring it, which is the safe direction for a parser whose output decides
 * who somebody is.
 */

/** The fields Folio puts in a message, and the fields it will read back. */
export type SiweFields = {
  /** The site asking. Host and port, no scheme — EIP-4361 says so. */
  domain: string;
  /** The signer, EIP-55 checksummed in the message and compared case-insensitively. */
  address: string;
  /** The human sentence above the machine-readable block. */
  statement: string;
  /** Where the request came from, as a full origin-and-path URL. */
  uri: string;
  /** The chain the wallet was on. Recorded, not trusted — see below. */
  chainId: number;
  /** Server-issued, single-use. `lib/authToken.ts` mints and checks it. */
  nonce: string;
  /** ISO 8601, when the browser built the message. */
  issuedAt: string;
  /** ISO 8601, after which no signature of this message is accepted. */
  expirationTime: string;
};

/** EIP-4361's fixed first line, minus the domain. */
const PREAMBLE = " wants you to sign in with your Ethereum account:";

/** The version this speaks. The spec has had exactly one. */
const VERSION = "1";

/**
 * The sentence the reader actually reads.
 *
 * Wallets show this above the fields, and it is the only part of the message
 * most people will look at, so it says what signing does and — just as
 * important — what it does not. A signature that could be mistaken for
 * approving a transaction is the thing this whole standard exists to prevent,
 * and the sentence is where that promise is made in words rather than in
 * encoding.
 */
export const SIWE_STATEMENT =
  "Sign in to Folio to publish this launch under your address. " +
  "This is a signature, not a transaction: it costs no gas and moves nothing.";

/**
 * Build the exact text the wallet will be asked to sign.
 *
 * The layout is EIP-4361's, byte for byte — a blank line after the address, a
 * blank line around the statement, then one `Field: value` per line. Wallets
 * that render SIWE messages structurally are matching on this shape, and a
 * message that misses it degrades to a wall of raw text in the signing sheet.
 */
export function buildSiweMessage(fields: SiweFields): string {
  return [
    `${fields.domain}${PREAMBLE}`,
    fields.address,
    "",
    fields.statement,
    "",
    `URI: ${fields.uri}`,
    `Version: ${VERSION}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
    `Expiration Time: ${fields.expirationTime}`,
  ].join("\n");
}

/**
 * Read a message back, or return null if it is not one this file wrote.
 *
 * Strict on purpose. A lenient parser here is a parser that can be shown one
 * thing by the wallet and understood as another by the server, which is the
 * classic shape of a signature-confusion bug: the fields the server acts on
 * have to be the fields the human was shown, and the only way to be sure of
 * that is to refuse anything that does not match the grammar exactly.
 *
 * Note what is *not* validated here: whether the nonce was issued, whether the
 * domain is this one, whether the time has passed. Those are decisions, they
 * belong to the server, and they are made in `app/api/auth/verify/route.ts`.
 * This function only turns text into fields.
 */
export function parseSiweMessage(message: string): SiweFields | null {
  // Normalise the line ending and nothing else. A wallet that round-trips the
  // message through a text box can turn "\n" into "\r\n"; every other
  // difference is a different message and should read as one.
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  if (lines.length !== 11) return null;

  const [header, address, gap1, statement, gap2, ...rest] = lines;
  if (gap1 !== "" || gap2 !== "") return null;

  if (!header.endsWith(PREAMBLE)) return null;
  const domain = header.slice(0, -PREAMBLE.length);
  if (!domain) return null;

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (!statement) return null;

  const fields = new Map<string, string>();
  for (const line of rest) {
    const separator = line.indexOf(": ");
    if (separator <= 0) return null;
    const key = line.slice(0, separator);
    if (fields.has(key)) return null;
    fields.set(key, line.slice(separator + 2));
  }

  const uri = fields.get("URI");
  const version = fields.get("Version");
  const chainId = fields.get("Chain ID");
  const nonce = fields.get("Nonce");
  const issuedAt = fields.get("Issued At");
  const expirationTime = fields.get("Expiration Time");

  if (fields.size !== 6) return null;
  if (!uri || !nonce || !issuedAt || !expirationTime) return null;
  if (version !== VERSION) return null;

  // A nonce is the one field an attacker would most like to be creative with,
  // and the spec already constrains it: alphanumeric, at least eight of them.
  if (!/^[a-zA-Z0-9]{8,}$/.test(nonce)) return null;

  if (!chainId || !/^[0-9]{1,10}$/.test(chainId)) return null;

  if (!isIsoInstant(issuedAt) || !isIsoInstant(expirationTime)) return null;

  return {
    domain,
    address,
    statement,
    uri,
    chainId: Number(chainId),
    nonce,
    issuedAt,
    expirationTime,
  };
}

/**
 * Whether a timestamp is an ISO 8601 instant that re-serialises to itself.
 *
 * `Date.parse` accepts a great deal more than the spec's profile of ISO 8601,
 * and quietly reinterprets some of it — a string with no zone is read as local
 * time, which means the same message means two different moments on two
 * different servers. Round-tripping through `toISOString` is the cheap way to
 * insist on exactly one spelling of exactly one instant.
 */
function isIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

/** ISO 8601 with milliseconds, which is what `toISOString` produces. */
export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}
