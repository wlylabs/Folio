import { getAddress } from "viem";
import { signMessage } from "wagmi/actions";
import type { Config } from "wagmi";
import { SIWE_STATEMENT, buildSiweMessage, isoAt } from "@/lib/siwe";

/**
 * Signing in with a wallet, from the browser's side.
 *
 * One export does the work: {@link ensureCreatorSession} hands back a Supabase
 * token proving the connected address, asking the wallet for a signature only
 * when it has to. Everything else here is the bookkeeping that makes "only when
 * it has to" true — a reader who publishes two launches in one sitting should
 * be asked once.
 *
 * ## Three answers, not two
 *
 * A caller gets `configured: false` when this deployment has no
 * `SUPABASE_JWT_SECRET` and cannot verify anybody; a token when the wallet
 * signed; and a thrown {@link SignInRefused} when the reader declined or the
 * server would not accept what they signed. The first is not a failure and must
 * not be reported as one — a deployment without verification publishes exactly
 * as it did before, with an honestly unverified byline.
 *
 * ## Where the token lives
 *
 * `sessionStorage`, keyed to the address it proves. That is a deliberate step
 * down from `localStorage`, which is where the theme and the currency live: a
 * palette surviving a closed tab is a courtesy, and a credential surviving one
 * is a credential left behind on a shared machine. It is dropped when the
 * address changes, because a token minted for one wallet is meaningless — and
 * misleading — for the next.
 */

/** Where a minted session is kept between page loads within one tab. */
const STORAGE_KEY = "folio:siwe";

/**
 * How much of a session's life must be left for it to be reused.
 *
 * A token with thirty seconds on it will expire in the middle of the insert
 * that needed it, which surfaces as a row that did not save after a launch that
 * did — the one failure in this flow that costs real money to recover from. So
 * anything inside this margin is treated as already expired and re-signed.
 */
const REFRESH_MARGIN_MS = 2 * 60_000;

export type CreatorSession =
  | { configured: false; token: null; address: null }
  | { configured: true; token: string; address: string };

/**
 * Thrown when a sign-in could have happened and did not.
 *
 * Carries `declined` separately because the two cases read differently to a
 * reader: declining is a choice they made and can simply make again, and
 * anything else is this site failing to accept a signature they gave.
 */
export class SignInRefused extends Error {
  readonly declined: boolean;

  constructor(message: string, declined = false) {
    super(message);
    this.name = "SignInRefused";
    this.declined = declined;
  }
}

/**
 * A Supabase session proving `address`, minting one if there isn't a live one.
 *
 * `chainId` is recorded in the signed message rather than trusted from it: the
 * server checks it names a network Folio supports, because that is the network
 * whose RPC it will ask about a smart-contract wallet's signature.
 */
export async function ensureCreatorSession(
  config: Config,
  { address, chainId }: { address: string; chainId: number }
): Promise<CreatorSession> {
  const wallet = address.toLowerCase();

  const cached = readStored(wallet);
  if (cached) return { configured: true, token: cached, address: wallet };

  const challenge = await requestNonce();
  if (!challenge) return { configured: false, token: null, address: null };

  const issuedAt = Date.now();
  const message = buildSiweMessage({
    // Checksummed, which is what EIP-4361 asks for and what a wallet's signing
    // sheet will show. The server compares case-insensitively either way.
    address: getAddress(address),
    domain: challenge.domain || window.location.host,
    statement: SIWE_STATEMENT,
    uri: `${window.location.origin}${window.location.pathname}`,
    chainId,
    nonce: challenge.nonce,
    issuedAt: isoAt(issuedAt),
    expirationTime: isoAt(issuedAt + challenge.expiresIn),
  });

  let signature: string;
  try {
    signature = await signMessage(config, {
      account: address as `0x${string}`,
      message,
    });
  } catch (err) {
    throw new SignInRefused(
      "The signature was declined in the wallet.",
      isDecline(err)
    );
  }

  const verified = await verify(message, signature);
  store(wallet, verified.token, verified.expiresAt);

  return { configured: true, token: verified.token, address: wallet };
}

/** Forget the stored session — on disconnect, or when the address changes. */
export function forgetCreatorSession() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // A browser with storage switched off has nothing to forget.
  }
}

type Challenge = { nonce: string; domain: string; expiresIn: number };

/**
 * A nonce from the server, or null when this deployment cannot verify wallets.
 *
 * The 501 is the configured/not-configured answer and is the one status that is
 * not an error. Anything else genuinely failed, and failing loudly here is
 * better than falling through to an unverified publish the reader was never
 * told about.
 */
async function requestNonce(): Promise<Challenge | null> {
  let response: Response;
  try {
    response = await fetch("/api/auth/nonce", { cache: "no-store" });
  } catch {
    throw new SignInRefused("Folio could not be reached to start the sign-in.");
  }

  if (response.status === 501) return null;

  if (!response.ok) {
    throw new SignInRefused("Folio could not start the sign-in just now.");
  }

  const body = (await response.json()) as Partial<Challenge> & { configured?: boolean };
  if (body.configured === false) return null;
  if (typeof body.nonce !== "string" || typeof body.expiresIn !== "number") {
    throw new SignInRefused("Folio could not start the sign-in just now.");
  }

  return {
    nonce: body.nonce,
    domain: typeof body.domain === "string" ? body.domain : "",
    expiresIn: body.expiresIn,
  };
}

async function verify(
  message: string,
  signature: string
): Promise<{ token: string; expiresAt: number }> {
  let response: Response;
  try {
    response = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
  } catch {
    throw new SignInRefused("Folio could not be reached to finish the sign-in.");
  }

  const body = (await response.json().catch(() => null)) as {
    token?: unknown;
    expiresAt?: unknown;
    error?: unknown;
  } | null;

  if (!response.ok || typeof body?.token !== "string") {
    const reason = typeof body?.error === "string" ? body.error : "The signature was not accepted.";
    throw new SignInRefused(reason);
  }

  return {
    token: body.token,
    expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : Date.now(),
  };
}

type Stored = { address: string; token: string; expiresAt: number };

function readStored(wallet: string): string | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: Stored;
  try {
    parsed = JSON.parse(raw) as Stored;
  } catch {
    return null;
  }

  if (parsed?.address !== wallet) return null;
  if (typeof parsed.token !== "string") return null;
  if (typeof parsed.expiresAt !== "number") return null;
  if (parsed.expiresAt - REFRESH_MARGIN_MS <= Date.now()) return null;

  return parsed.token;
}

function store(wallet: string, token: string, expiresAt: number) {
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ address: wallet, token, expiresAt } satisfies Stored)
    );
  } catch {
    // Storage being unavailable costs one extra signature per page, which is
    // a far better outcome than refusing to publish over it.
  }
}

/**
 * Whether a wallet error is the reader saying no.
 *
 * EIP-1193 gives user rejection code 4001, and most wallets send it. The ones
 * that do not say so in the message instead, which is why the text is checked
 * as well — `lib/txErrors.ts` makes the same distinction for transactions and
 * for the same reason: "you declined" and "something broke" want different
 * words in front of them.
 */
function isDecline(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 4001) return true;

  const message = err instanceof Error ? err.message.toLowerCase() : "";
  return (
    message.includes("user rejected") ||
    message.includes("user denied") ||
    message.includes("rejected the request")
  );
}
