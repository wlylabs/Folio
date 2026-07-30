"use client";

import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAccount, useConfig } from "wagmi";
import { deployContract, switchChain, waitForTransactionReceipt } from "wagmi/actions";
import { parseEther } from "viem";
import { useRouter } from "next/navigation";
import WalletButton from "@/components/WalletButton";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { FOLIO_SALE_ABI, FOLIO_SALE_BYTECODE } from "@/lib/contracts/folioSale";
import { DEFAULT_CHAIN_SLUG, chainBySlug } from "@/lib/chains";

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
  const { address, isConnected, chainId } = useAccount();
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

      // The wallet must be on the chain we're deploying to, or the contract
      // lands on whatever network happens to be selected.
      setStage("deploying");
      if (chainId !== chainEntry.chain.id) {
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
      setErrors({
        form: err instanceof Error ? err.message : "Something went wrong. Check the console.",
      });
      console.error("Launch failed:", err);
      setStage("idle");
    }
  };

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "20px 20px 60px" }}>
      <h1 className="font-display" style={{ fontWeight: 900, fontSize: 28, marginBottom: 6 }}>
        Launch a Token
      </h1>
      <p className="font-ui" style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 20 }}>
        Deploys a real ERC20 sale contract to {chainEntry?.chain.name ?? DEFAULT_CHAIN_SLUG}.
        You pay only gas.
      </p>

      {!isConnected && (
        <div style={{ border: "1px solid var(--ink)", padding: 12 }}>
          <p
            className="font-ui"
            style={{ fontSize: 11, color: "var(--ink-soft)", margin: "0 0 10px" }}
          >
            Connect a wallet to sign the deployment.
          </p>
          <WalletButton variant="block" />
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        <Field label="Token name" error={errors.name}>
          <input
            placeholder="e.g. Midnight Kettle"
            value={form.name}
            onChange={(e) => set("name")(e.target.value)}
            disabled={busy}
            maxLength={64}
            style={inputStyle}
          />
        </Field>

        <Field label="Symbol" error={errors.symbol}>
          <input
            placeholder="e.g. KETL"
            value={form.symbol}
            onChange={(e) => set("symbol")(e.target.value.toUpperCase())}
            disabled={busy}
            maxLength={16}
            style={inputStyle}
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
            style={inputStyle}
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
            style={inputStyle}
          />
        </Field>

        <Field label="Article headline" error={errors.articleTitle}>
          <input
            placeholder="The story of your launch"
            value={form.articleTitle}
            onChange={(e) => set("articleTitle")(e.target.value)}
            disabled={busy}
            maxLength={200}
            style={inputStyle}
          />
        </Field>

        <Field label="Token avatar (optional, max 2 MB)" error={errors.avatar}>
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              setAvatar(e.target.files?.[0] ?? null);
              setErrors((prev) => ({ ...prev, avatar: undefined }));
            }}
            className="font-ui"
            style={{ fontSize: 12 }}
          />
        </Field>

        <Field label="Article body">
          <div style={{ border: "1px solid var(--rule)", padding: 12, minHeight: 160 }}>
            <EditorContent editor={editor} />
          </div>
        </Field>

        {errors.form && (
          <div
            className="font-ui"
            role="alert"
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              padding: "10px 12px",
              border: "1px solid var(--ink)",
              background: "#fff",
              wordBreak: "break-word",
            }}
          >
            {errors.form}
          </div>
        )}

        {busy && (
          <div className="font-ui" style={{ fontSize: 11, color: "var(--ink-soft)" }}>
            {STAGE_LABEL[stage as Exclude<Stage, "idle">]}
            {txHash && (
              <div style={{ wordBreak: "break-all", marginTop: 4 }}>tx {txHash}</div>
            )}
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={!isConnected || busy}
          className="font-ui"
          style={{
            padding: "14px 0",
            background: "var(--ink)",
            color: "var(--paper)",
            fontWeight: 600,
            letterSpacing: 1,
            border: "none",
            cursor: !isConnected || busy ? "not-allowed" : "pointer",
            opacity: !isConnected || busy ? 0.6 : 1,
          }}
        >
          {busy ? "Working..." : "Publish & Launch"}
        </button>
      </div>
    </main>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        className="font-ui"
        style={{ fontSize: 9.5, letterSpacing: 1.5, color: "var(--ink-soft)" }}
      >
        {label.toUpperCase()}
      </span>
      {children}
      {error && (
        <span className="font-ui" style={{ fontSize: 11, color: "#b00020" }}>
          {error}
        </span>
      )}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "12px",
  border: "1px solid var(--rule)",
  fontFamily: "PT Serif, serif",
  fontSize: 14,
  width: "100%",
};
