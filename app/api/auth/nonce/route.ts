import { NextResponse } from "next/server";
import { NONCE_TTL_MS, mintNonce, siweConfigured } from "@/lib/authToken";
import { SIWE_STATEMENT } from "@/lib/siwe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The first half of a wallet sign-in: a nonce, and the sentence to sign it with.
 *
 * `GET /api/auth/nonce` hands back a single-use nonce this server will
 * recognise for the next ten minutes, plus the domain and statement the browser
 * must put in the message. Those two travel with the nonce rather than being
 * hardcoded in the client for one reason: the server is the thing that checks
 * them, so the server is the thing that should say what they are. A client that
 * guesses its own domain and guesses wrong produces a signature the verify
 * route refuses, with nothing in the failure to explain why.
 *
 * ## Unconfigured is an answer, not an error
 *
 * With no `SUPABASE_JWT_SECRET`, this answers 501 with `configured: false`, and
 * the create page reads that and publishes with the anon key as it always did.
 * That is why the flag is discovered here rather than through a
 * `NEXT_PUBLIC_` variable: one source of truth, on the side that holds the
 * secret, with no second setting to drift out of step with it.
 *
 * Nothing here is rate limited, and it does not need to be: a nonce is sixty
 * hex characters computed from an HMAC, it is not stored until it is spent, and
 * handing one to somebody who cannot produce a signature costs this server
 * nothing at all.
 */
export async function GET(request: Request) {
  if (!siweConfigured) {
    return NextResponse.json(
      {
        configured: false,
        error:
          "Wallet verification is not configured on this deployment. " +
          "Set SUPABASE_JWT_SECRET to turn it on.",
      },
      { status: 501, headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(
    {
      configured: true,
      nonce: mintNonce(),
      // The host this request arrived on, which is the host the verify route
      // will compare the signed message against. Taken from the request rather
      // than from a configured site URL so preview deploys and localhost work
      // without either of them being named anywhere.
      domain: request.headers.get("host") ?? "",
      statement: SIWE_STATEMENT,
      expiresIn: NONCE_TTL_MS,
    },
    // Never cached, anywhere. A shared nonce is not a nonce.
    { headers: { "cache-control": "no-store, private" } }
  );
}
