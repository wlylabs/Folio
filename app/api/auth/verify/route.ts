import { NextResponse } from "next/server";
import { isAddress, verifyMessage } from "viem";
import { SUPPORTED_CHAINS, publicClientFor } from "@/lib/chains";
import { claimNonce, mintSession, siweConfigured } from "@/lib/authToken";
import { SIWE_STATEMENT, parseSiweMessage } from "@/lib/siwe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The second half of a wallet sign-in: a signature in, a Supabase session out.
 *
 * `POST /api/auth/verify` takes `{ message, signature }`, checks every claim the
 * message makes against something this server already knew, and — only if all
 * of them hold — mints a short-lived JWT carrying the address. The create page
 * then inserts its listing with that token instead of the bare anon key, and
 * the policy in `lib/schema.sql` refuses any row whose `creator_wallet` is not
 * the address in it.
 *
 * ## Every check, and why it is here
 *
 * A signature over an attacker-chosen message proves nothing useful, so the
 * text is validated before the cryptography is:
 *
 *  - **Shape.** `parseSiweMessage` refuses anything that is not exactly the
 *    grammar this app emits. A field the parser does not recognise is a field
 *    the human was shown and the server would have ignored.
 *  - **Statement.** Byte-identical to `SIWE_STATEMENT`. This is the sentence
 *    the wallet actually renders, and it is the only part of the message a
 *    reader is likely to read — so it is the part an attacker would most like
 *    to rewrite while keeping the rest intact.
 *  - **Domain and URI.** Both must name the host this request arrived on. A
 *    signature collected by another site for its own domain is not a sign-in
 *    here, which is the whole reason EIP-4361 puts the domain in the text.
 *  - **Nonce.** Issued by `/api/auth/nonce`, unexpired, and unspent. Burned on
 *    the way through, so the same signature is not a second session.
 *  - **Clock.** Not expired, and not issued far enough in the future to be
 *    somebody stretching a window.
 *  - **Chain.** One Folio supports, because that is the chain whose RPC will be
 *    asked whether a smart-contract wallet stands behind this signature.
 *  - **Signature.** Last, because it is the expensive one — and through viem's
 *    `verifyMessage` with a client attached, which falls through to EIP-1271
 *    and ERC-6492 so a Safe or a not-yet-deployed smart account can sign in
 *    like anything else.
 *
 * ## What a session is not
 *
 * It is proof of one address at one moment, and nothing downstream treats it as
 * more. Creator powers that move money — `claimFees`, the migration prompt —
 * still read `creator()` off the contract, because a database claim, verified
 * or not, is the wrong authority for a payout. What this buys is a byline that
 * cannot be forged and a `creator_verified` flag a reader can rely on.
 */

/** How far ahead of this server's clock a message may claim to be issued. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** Bodies larger than this are refused unread. A message is under a kilobyte. */
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: Request) {
  if (!siweConfigured) {
    return refuse(
      "Wallet verification is not configured on this deployment.",
      501
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return refuse("That sign-in request is too large.", 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("Body is not JSON.", 400);
  }

  const { message, signature } = (body ?? {}) as {
    message?: unknown;
    signature?: unknown;
  };

  if (typeof message !== "string" || message.length > MAX_BODY_BYTES) {
    return refuse("A sign-in needs the message that was signed.", 400);
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return refuse("A sign-in needs a signature.", 400);
  }

  const fields = parseSiweMessage(message);
  if (!fields) {
    return refuse("That is not a Folio sign-in message.", 400);
  }

  if (fields.statement !== SIWE_STATEMENT) {
    return refuse("That sign-in message is not the one this site asks for.", 400);
  }

  const host = request.headers.get("host");
  if (!host || fields.domain !== host) {
    return refuse("That sign-in message was written for a different site.", 400);
  }

  if (!uriMatchesHost(fields.uri, host)) {
    return refuse("That sign-in message points somewhere else.", 400);
  }

  if (!isAddress(fields.address)) {
    return refuse("That sign-in message carries no usable address.", 400);
  }

  const chain = SUPPORTED_CHAINS.find((c) => c.chain.id === fields.chainId);
  if (!chain) {
    return refuse("That sign-in message names a network Folio does not support.", 400);
  }

  const now = Date.now();
  const issuedAt = Date.parse(fields.issuedAt);
  const expiresAt = Date.parse(fields.expirationTime);

  if (issuedAt > now + CLOCK_SKEW_MS) {
    return refuse("That sign-in message is dated in the future.", 400);
  }
  if (now > expiresAt) {
    return refuse("That sign-in message expired. Try signing in again.", 400);
  }

  const nonce = claimNonce(fields.nonce, now);
  if (!nonce.ok) {
    return refuse(nonce.reason, 400);
  }

  const claim = {
    address: fields.address as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  };

  /*
   * Plain ECDSA recovery first, and usually last.
   *
   * Every ordinary wallet signs with the key behind the address, so recovering
   * that key and comparing settles it — arithmetic, no network, no dependency
   * on an RPC being up for somebody to publish. Ordering it first is what keeps
   * a sign-in from inheriting the chain's latency and the chain's outages for
   * a question the chain was never needed to answer.
   */
  let valid = await verifyMessage(claim).catch(() => false);

  if (!valid) {
    /*
     * A smart-contract wallet has no key to recover. A Safe, or one of the
     * account-abstraction wallets, answers `isValidSignature` instead
     * (EIP-1271), and one that has not been deployed yet answers through its
     * factory (ERC-6492) — both of which are reads against the chain, and both
     * of which viem does through the client.
     *
     * So this branch is not a retry of the same question: it is the second
     * question, asked only of the signatures the first one could not settle.
     * An RPC that will not answer it leaves the signature refused, which is
     * the honest outcome — "we could not check" is not "it checked out".
     */
    const client = publicClientFor(chain.slug);
    if (client) {
      valid = await client
        .verifyMessage(claim)
        .catch((err: unknown) => {
          console.error("SIWE contract-wallet check could not reach the chain:", err);
          return false;
        });
    }
  }

  if (!valid) {
    return refuse("That signature does not match the address.", 401);
  }

  const session = mintSession(fields.address, now);

  return NextResponse.json(
    {
      address: fields.address.toLowerCase(),
      token: session.token,
      expiresAt: session.expiresAt,
    },
    { headers: { "cache-control": "no-store, private" } }
  );
}

/**
 * Whether the message's `URI` is a page on this host.
 *
 * The domain line already pins the site; this pins the *page*, which is what
 * stops a signature gathered on one Folio route being presented as one gathered
 * on another. Only the host is compared — the path is whatever the reader was
 * looking at, and pinning that would break the moment the create form moved.
 */
function uriMatchesHost(uri: string, host: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * A refusal, with a reason a person can act on and nothing a prober can learn
 * from. Every message here describes the caller's own request; none of them
 * reports an internal failure, which is what the logs are for.
 */
function refuse(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}
