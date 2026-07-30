"use client";

import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAccount, useBalance, useConfig } from "wagmi";
import { deployContract, getAccount, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits, parseEther } from "viem";
import { useRouter } from "next/navigation";
import WalletButton from "@/components/WalletButton";
import { FaucetLinks, FaucetNotice } from "@/components/Faucet";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { FOLIO_SALE_ABI, FOLIO_SALE_BYTECODE } from "@/lib/contracts/folioSale";
import { DEFAULT_CHAIN_SLUG, chainBySlug, explorerTxUrl } from "@/lib/chains";
import { describeTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
import { formatEth } from "@/lib/types";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

type Stage = "idle" | "uploading" | "deploying" | "confirming" | "saving";

const STAGE_LABEL: Record<Exclude<Stage, "idle">, string> = {
  uploading: "Uploading avatar...",
  deploying: "Confirm the deploy in your wallet...",
  confirming: "Deploying on chain...",
  saving: "Publishing article...",
};

type FormState = {
  name: string;
  symbol: string;
  supply: string;
  startingPrice: string;
  articleTitle: string;
};

type Errors = Partial<Record<keyof FormState | "avatar" | "form", string>>;

function validate(form: FormState, avatar: File | null): Errors {
  const errors: Errors = {};

  const name = form.name.trim();
  if (!name) errors.name = "Give your token a name.";
  else if (name.length > 64) errors.name = "Keep the name under 64 characters.";

  const symbol = form.symbol.trim();
  if (!symbol) errors.symbol = "A symbol is required.";
  else if (!/^[A-Z0-9]{1,16}$/.test(symbol))
    errors.symbol = "Use 1–16 letters or digits, no spaces.";

  // Digits only: BigInt() throws on "1000000.0" and "1e6", both of which a
  // number input accepts and Number.isInteger() considers whole.
  const supplyRaw = form.supply.trim();
  const supply = Number(supplyRaw);
  if (!supplyRaw) errors.supply = "Enter a total supply.";
  else if (!/^\d+$/.test(supplyRaw))
    errors.supply = "Supply must be a whole number of tokens, digits only.";
  else if (supply <= 0) errors.supply = "Supply must be greater than zero.";
  else if (supply > 1e15) errors.supply = "That supply is unrealistically large.";

  // Likewise plain decimals only — parseEther cannot read "1e-5".
  const priceRaw = form.startingPrice.trim();
  const price = Number(priceRaw);
  if (!priceRaw) errors.startingPrice = "Enter a starting price.";
  else if (!/^\d*\.?\d+$/.test(priceRaw))
    errors.startingPrice = "Use a plain decimal number, e.g. 0.0002.";
  else if (priceRaw.split(".")[1] && priceRaw.split(".")[1].length > 18)
    errors.startingPrice = "At most 18 decimal places.";
  else if (!Number.isFinite(price) || price <= 0)
    errors.startingPrice = "Price must be greater than zero.";

  const title = form.articleTitle.trim();
  if (!title) errors.articleTitle = "Your launch needs a headline.";
  else if (title.length > 200) errors.articleTitle = "Keep the headline under 200 characters.";

  if (avatar) {
    if (!avatar.type.startsWith("image/")) errors.avatar = "Avatar must be an image.";
    else if (avatar.size > MAX_AVATAR_BYTES) errors.avatar = "Avatar must be under 2 MB.";
  }

  return errors;
}

export default function CreatePage() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const router = useRouter();

  const [form, setForm] = useState<FormState>({
    name: "",
    symbol: "",
    supply: "1000000",
    startingPrice: "0.0002",
    articleTitle: "",
  });
  const [avatar, setAvatar] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [stage, setStage] = useState<Stage>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: "<p>Tell the story behind your token...</p>",
    // Required in the App Router: rendering the editor during SSR causes a
    // hydration mismatch.
    immediatelyRender: false,
  });

  const busy = stage !== "idle";
  const chainEntry = chainBySlug(DEFAULT_CHAIN_SLUG);

  // Deploying costs gas, and a wallet that has never touched this testnet has
  // none. Read the balance up front so the form can point at a faucet instead
  // of letting the wallet reject the signature.
  const { data: balance } = useBalance({
    address,
    chainId: chainEntry?.chain.id,
    query: { enabled: Boolean(address && chainEntry) },
  });
  const noGas = balance !== undefined && balance.value === 0n;

  const set = (key: keyof FormState) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined, form: undefined }));
  };

  async function uploadAvatar(file: File, owner: string): Promise<string> {
    const ext = (file.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const path = `${owner.toLowerCase()}/${Date.now()}.${ext || "png"}`;

    const { error } = await supabase.storage
      .from("token-avatars")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw new Error(`Avatar upload failed: ${error.message}`);

    return supabase.storage.from("token-avatars").getPublicUrl(path).data.publicUrl;
  }

  const handleSubmit = async () => {
    if (!isConnected || !address) return;

    if (!isSupabaseConfigured) {
      setErrors({ form: "Supabase isn't configured. See .env.example." });
      return;
    }
    if (!chainEntry) {
      setErrors({ form: `Unsupported chain "${DEFAULT_CHAIN_SLUG}". Check NEXT_PUBLIC_DEFAULT_CHAIN.` });
      return;
    }
    if (noGas) {
      setErrors({
        form: `This wallet has no ${chainEntry.chain.nativeCurrency.symbol} on ${chainEntry.chain.name}, and deploying costs gas. Claim some from a faucet below, then try again.`,
      });
      return;
    }

    const found = validate(form, avatar);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    setTxHash(null);

    try {
      let avatarUrl: string | null = null;
      if (avatar) {
        setStage("uploading");
        avatarUrl = await uploadAvatar(avatar, address);
      }

      // A stored session can look connected while its connector is still
      // asleep, so wake it before the deploy rather than failing on signature.
      setStage("deploying");
      await ensureWalletReady(config);

      // The wallet must be on the chain we're deploying to, or the contract
      // lands on whatever network happens to be selected.
      if (getAccount(config).chainId !== chainEntry.chain.id) {
        await switchChain(config, { chainId: chainEntry.chain.id }).catch((err) => {
          throw new Error(
            `Switch your wallet to ${chainEntry.chain.name} to launch. (${
              err instanceof Error ? err.message : String(err)
            })`
          );
        });
      }

      const hash = await deployContract(config, {
        abi: FOLIO_SALE_ABI,
        bytecode: FOLIO_SALE_BYTECODE,
        args: [
          form.name.trim(),
          form.symbol.trim(),
          BigInt(form.supply.trim()),
          parseEther(form.startingPrice.trim()),
          address,
        ],
        chainId: chainEntry.chain.id,
      });
      setTxHash(hash);

      setStage("confirming");
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainEntry.chain.id,
      });
      if (receipt.status !== "success" || !receipt.contractAddress) {
        throw new Error("The deploy transaction reverted. Nothing was published.");
      }

      // Lowercased so token page lookups by URL are case-insensitive.
      const contractAddress = receipt.contractAddress.toLowerCase();

      setStage("saving");
      const { error } = await supabase.from("tokens").insert({
        contract_address: contractAddress,
        chain: chainEntry.slug,
        name: form.name.trim(),
        symbol: form.symbol.trim(),
        supply: Number(form.supply),
        starting_price: Number(form.startingPrice),
        creator_wallet: address.toLowerCase(),
        article_title: form.articleTitle.trim(),
        article_body: editor?.getHTML() || "",
        avatar_url: avatarUrl,
        deploy_tx: hash,
      });

      if (error) {
        // The contract is live even though the article didn't save, so surface
        // the address rather than losing it.
        throw new Error(
          `Contract deployed at ${contractAddress}, but saving the article failed: ${error.message}`
        );
      }

      router.push(`/token/${contractAddress}`);
    } catch (err) {
      console.error("Launch failed:", err);
      // Messages thrown above are already written for a person; only wallet and
      // RPC failures need translating.
      setErrors({
        form: err instanceof Error && /^(Avatar upload failed|Switch your wallet|Contract deployed at|The deploy transaction)/.test(err.message)
          ? err.message
          : describeTxError(err),
      });
      setStage("idle");
    }
  };

  return (
    <main id="main" className="shell shell--form page">
      <header style={{ marginBottom: "var(--sp-5)" }}>
        <p className="eyebrow">New listing</p>
        <h1
          style={{
            fontWeight: 900,
            fontSize: "var(--fs-h1)",
            margin: "var(--sp-2) 0 var(--sp-3)",
          }}
        >
          Launch a token
        </h1>
        <p style={{ color: "var(--ink-soft)", maxWidth: "var(--measure)" }}>
          Deploys a real ERC20 sale contract to {chainEntry?.chain.name ?? DEFAULT_CHAIN_SLUG}.
          You pay only gas. Buyers can also sell back at 5% under your price, and that
          spread is yours to withdraw — the rest stays in the contract to cover them.
        </p>
      </header>

      {!isConnected && (
        <div className="notice" style={{ marginBottom: "var(--sp-5)" }}>
          <p className="notice__title">Connect a wallet to sign the deployment</p>
          <p style={{ marginBottom: "var(--sp-4)" }}>
            Nothing is published until you approve the transaction.
          </p>
          <WalletButton variant="block" />
        </div>
      )}

      {isConnected && chainEntry && (
        <div
          className="font-ui"
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: "var(--sp-3)",
            padding: "var(--sp-3) 0",
            borderTop: "1px solid var(--ink)",
            borderBottom: "1px solid var(--rule)",
            fontSize: "var(--fs-micro)",
            color: "var(--ink-soft)",
          }}
        >
          <span>{chainEntry.chain.name}</span>
          <span className="nums" style={{ fontWeight: 600, color: "var(--ink)" }}>
            {balance
              ? `${formatEth(Number(formatUnits(balance.value, balance.decimals)))} ${balance.symbol}`
              : "checking balance..."}
          </span>
        </div>
      )}

      {isConnected && noGas && (
        <div style={{ marginTop: "var(--sp-4)" }}>
          <FaucetNotice
            chain={DEFAULT_CHAIN_SLUG}
            heading={`No ${chainEntry?.chain.nativeCurrency.symbol ?? "test ETH"} to pay gas with`}
          />
        </div>
      )}

      <div className="stack" style={{ marginTop: "var(--sp-5)", gap: "var(--sp-5)" }}>
        <div className="form-grid">
          <Field label="Token name" error={errors.name}>
            <input
              placeholder="e.g. Midnight Kettle"
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
              disabled={busy}
              maxLength={64}
              className="input"
            />
          </Field>

          <Field label="Symbol" error={errors.symbol}>
            <input
              placeholder="e.g. KETL"
              value={form.symbol}
              onChange={(e) => set("symbol")(e.target.value.toUpperCase())}
              disabled={busy}
              maxLength={16}
              className="input"
            />
          </Field>

          <Field label="Total supply" error={errors.supply}>
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              placeholder="1000000"
              value={form.supply}
              onChange={(e) => set("supply")(e.target.value)}
              disabled={busy}
              className="input"
            />
          </Field>

          <Field label="Price per token (ETH)" error={errors.startingPrice}>
            <input
              type="number"
              min="0"
              step="0.0001"
              inputMode="decimal"
              placeholder="0.0002"
              value={form.startingPrice}
              onChange={(e) => set("startingPrice")(e.target.value)}
              disabled={busy}
              className="input"
            />
          </Field>

          <Field label="Article headline" error={errors.articleTitle} wide>
            <input
              placeholder="The story of your launch"
              value={form.articleTitle}
              onChange={(e) => set("articleTitle")(e.target.value)}
              disabled={busy}
              maxLength={200}
              className="input"
            />
          </Field>

          <Field label="Token avatar" hint="Optional, max 2 MB" error={errors.avatar} wide>
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(e) => {
                setAvatar(e.target.files?.[0] ?? null);
                setErrors((prev) => ({ ...prev, avatar: undefined }));
              }}
              className="file-input"
            />
          </Field>

          <Field label="Article body" hint="This is what readers see on the listing" wide>
            <div className="editor">
              <EditorContent editor={editor} />
            </div>
          </Field>
        </div>

        {errors.form && (
          <div className="notice notice--alert" role="alert">
            {errors.form}
          </div>
        )}

        {busy && (
          <p className="status" role="status">
            {STAGE_LABEL[stage as Exclude<Stage, "idle">]}
            {txHash && (
              <>
                {" "}
                {explorerTxUrl(DEFAULT_CHAIN_SLUG, txHash) ? (
                  <a
                    href={explorerTxUrl(DEFAULT_CHAIN_SLUG, txHash) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    follow it on the explorer
                  </a>
                ) : (
                  <span>tx {txHash}</span>
                )}
              </>
            )}
          </p>
        )}

        <div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isConnected || busy}
            className="btn btn--primary btn--block"
          >
            {busy ? "Working..." : "Publish & launch"}
          </button>

          <p className="field__hint" style={{ marginTop: "var(--sp-3)" }}>
            Need test ETH? <FaucetLinks chain={DEFAULT_CHAIN_SLUG} />
          </p>
        </div>
      </div>
    </main>
  );
}

function Field({
  label,
  hint,
  error,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`field${wide ? " field--wide" : ""}`}>
      <span className="field__label">{label}</span>
      {children}
      {hint && !error && <span className="field__hint">{hint}</span>}
      {error && <span className="field__error">{error}</span>}
    </label>
  );
}
