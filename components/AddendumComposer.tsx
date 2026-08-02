"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConfig } from "wagmi";
import { chainBySlug, SUPPORTED_CHAINS } from "@/lib/chains";
import { ensureWalletReady } from "@/lib/walletReady";
import { ensureCreatorSession, SignInRefused } from "@/lib/walletAuth";
import { ADDENDUM_MAX_LENGTH, addendumProblem, publishAddendum } from "@/lib/addenda";
import type { Token } from "@/lib/types";

/**
 * The author's way of changing their mind in public.
 *
 * It renders for the address on the byline and for nobody else, and it writes
 * to `token_addenda` rather than to the article — because the article cannot be
 * written to twice. That is enforced in Postgres (`lib/schema.sql` grants no
 * update policy on `tokens` to any client) rather than decided here, which is
 * what makes "this is what they published" a fact about the site instead of a
 * habit of one component.
 *
 * ## Why this asks for a signature
 *
 * Publishing a listing may happen with the public anon key — an honestly
 * unverified byline is still a byline, and a deployment without
 * `SUPABASE_JWT_SECRET` has to keep working. An addition is different in kind:
 * it changes what an article says after people have traded on it, so it is
 * worth nothing at all unless the address on the byline signed for it. There is
 * no anonymous path into the table, and where verification is not configured
 * this says so plainly rather than offering a box that fails on submit.
 *
 * The signature is free — no transaction, no gas — and one session covers a
 * sitting, so a second addition usually costs no prompt at all.
 *
 * ## What it deliberately does not offer
 *
 * A rich text editor. The launch form has one because an article is a document;
 * an addition is a paragraph or two, and plain text is both easier to write in
 * a hurry and impossible to get wrong on the way in — `paragraphsToHtml`
 * escapes every bracket rather than trying to guess which ones were markup.
 */
export default function AddendumComposer({ token }: { token: Token }) {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; message: string } | null>(null);

  /*
   * The byline, not `creator()` from the contract.
   *
   * Those are two different authorities and this is deliberately the softer
   * one: `creator()` decides who is paid, `creator_wallet` decides who is
   * writing. A launch whose fees were transferred to another address has not
   * changed who wrote the piece.
   *
   * This check only decides whether to draw the box. The insert policy makes
   * the same comparison against a signed claim, in the database, where it
   * cannot be skipped.
   */
  const isAuthor =
    isConnected && address?.toLowerCase() === token.creator_wallet.toLowerCase();

  if (!isAuthor) return null;

  const problem = text.trim() ? addendumProblem(text) : null;
  const remaining = ADDENDUM_MAX_LENGTH - text.trim().length;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setStatus(null);

    const found = addendumProblem(text);
    if (found) {
      setStatus({ error: true, message: found });
      return;
    }

    setPending(true);
    try {
      // A stored connection can look awake while its connector is not, and a
      // signature request into a sleeping connector simply never resolves.
      await ensureWalletReady(config);

      const session = await ensureCreatorSession(config, {
        address: address!,
        /*
         * The listing's own chain where Folio still supports it, and the first
         * supported chain otherwise. The id is recorded in the signed message
         * and checked against SUPPORTED_CHAINS by /api/auth/verify — a row from
         * the retired testnet would otherwise be unable to sign for anything,
         * and signing is not a chain operation: no transaction is sent and the
         * wallet does not have to be on that network.
         */
        chainId: chainBySlug(token.chain)?.chain.id ?? SUPPORTED_CHAINS[0].chain.id,
      });

      if (!session.configured) {
        setStatus({
          error: true,
          message:
            "This deployment cannot verify wallets, so it does not accept additions. " +
            "An addition is only worth reading if the byline signed for it — see DEPLOYMENT.md " +
            "for the one environment variable that turns signing on.",
        });
        return;
      }

      await publishAddendum({ listing: token, sessionToken: session.token, text });

      setText("");
      setOpen(false);
      setStatus({
        error: false,
        message: "Added. It is signed, dated and now part of the article for good.",
      });
      // The list is server-rendered, so the new addition arrives with the page
      // rather than being pushed into a copy of it held here.
      router.refresh();
    } catch (err) {
      console.error("Publishing an addition failed:", err);

      const declined = err instanceof SignInRefused && err.declined;
      setStatus({
        error: !declined,
        message: declined
          ? "The signature was declined, so nothing was added. It costs no gas — trying again costs nothing either."
          : err instanceof Error
            ? err.message
            : "The addition could not be saved.",
      });
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <div className="addenda__compose">
        <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>
          Add to this article
        </button>
        {status && (
          <p className={`status${status.error ? " status--error" : ""}`} role="status">
            {status.message}
          </p>
        )}
        <p className="field__hint">
          You cannot edit what you published — Folio does not allow it, of anyone.
          What you can do is add to it, signed and dated, where every reader will
          see it above the trade panel.
        </p>
      </div>
    );
  }

  return (
    <form className="addenda__compose" onSubmit={handleSubmit}>
      <label className="field">
        <span className="field__label">Add to this article</span>
        <textarea
          className="input"
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What changed, and when you knew it."
          disabled={pending}
          maxLength={ADDENDUM_MAX_LENGTH}
        />
        <span className={remaining < 0 || problem ? "field__error" : "field__hint"}>
          {problem ??
            `Signed by ${
              address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "your wallet"
            } and permanent once added — additions cannot be edited or removed. ${remaining.toLocaleString(
              "en-US"
            )} characters left.`}
        </span>
      </label>

      {status && (
        <p className={`status${status.error ? " status--error" : ""}`} role="status">
          {status.message}
        </p>
      )}

      <div className="addenda__actions">
        <button
          type="submit"
          className="btn btn--primary btn--sm"
          disabled={pending || Boolean(problem) || !text.trim()}
          data-busy={pending || undefined}
        >
          {pending ? "Signing..." : "Sign and add"}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            setOpen(false);
            setStatus(null);
          }}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
