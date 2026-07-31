"use client";

import { useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAccount, useConfig } from "wagmi";
import { getAccount, switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { formatEther, formatUnits, parseEther, parseEventLogs } from "viem";
import { useRouter } from "next/navigation";
import WalletButton from "@/components/WalletButton";
import FiatValue from "@/components/FiatValue";
import { FaucetLinks, FaucetNotice } from "@/components/Faucet";
import { useGasBalance } from "@/components/useGasBalance";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { FOLIO_FACTORY_ABI } from "@/lib/contracts/folioFactory";
import {
  FACTORY_DEPLOYMENT,
  FACTORY_DEPLOYMENTS,
  deploymentFor,
  hasMultipleLaunchChains,
  openingPriceEth,
  type CurveConfig,
} from "@/lib/contracts/deployment";
import { DEFAULT_CHAIN_SLUG, chainBySlug, explorerTxUrl } from "@/lib/chains";
import { classifyTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
import { formatBps, formatEth } from "@/lib/types";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * A billion tokens, the memecoin convention. It is only a default — the field
 * takes anything the factory will accept, and the curve prices whatever supply
 * you choose against the same starting reserve, so a bigger supply is a smaller
 * opening price and nothing else.
 */
const DEFAULT_SUPPLY = "1000000000";

type Stage = "idle" | "uploading" | "launching" | "confirming" | "saving";

const STAGE_LABEL: Record<Exclude<Stage, "idle">, string> = {
  uploading: "Uploading avatar...",
  launching: "Confirm the launch in your wallet...",
  confirming: "Creating the token on chain...",
  saving: "Publishing article...",
};

type FormState = {
  name: string;
  symbol: string;
  supply: string;
  /** Optional per-launch ETH ceiling, in ETH. Empty means "platform default". */
  maxReserveCap: string;
  articleTitle: string;
};

type Errors = Partial<Record<keyof FormState | "avatar" | "form", string>>;

/**
 * @param config the curve terms of the chain being launched on. Passed in
 *        rather than read from a module constant: the caps differ per factory,
 *        and validating a Robinhood launch against Base Sepolia's ceiling would
 *        reject a legal supply or accept an illegal one.
 */
function validate(form: FormState, avatar: File | null, config: CurveConfig | undefined): Errors {
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
  else if (BigInt(supplyRaw) > 1_000_000_000_000_000n)
    errors.supply = "The factory caps supply at 1e15 whole tokens.";
  else if (config && BigInt(supplyRaw) > config.virtualEthReserve) {
    // FolioFactory.SupplyTooLargeForCurve: the opening price is
    // virtualEthReserve / wholeSupply, and below one wei it floors to zero.
    errors.supply = "That supply is too large for the platform's curve to price.";
  }

  const capRaw = form.maxReserveCap.trim();
  if (capRaw) {
    if (!/^\d*\.?\d+$/.test(capRaw)) {
      errors.maxReserveCap = "Use a plain decimal number, e.g. 1.5.";
    } else if ((capRaw.split(".")[1]?.length ?? 0) > 18) {
      errors.maxReserveCap = "At most 18 decimal places.";
    } else {
      const cap = parseEther(capRaw);
      if (cap < 1_000_000_000_000_000n) {
        errors.maxReserveCap = "The platform minimum is 0.001 ETH.";
      } else if (config && cap > config.maxReserveCap) {
        errors.maxReserveCap = `A launch may only tighten the cap. The platform ceiling is ${formatEth(
          Number(formatEther(config.maxReserveCap))
        )} ETH.`;
      }
    }
  }

  const title = form.articleTitle.trim();
  if (!title) errors.articleTitle = "Your launch needs a headline.";
  else if (title.length > 200) errors.articleTitle = "Keep the headline under 200 characters.";

  if (avatar) {
    if (!avatar.type.startsWith("image/")) errors.avatar = "Avatar must be an image.";
    else if (avatar.size > MAX_AVATAR_BYTES) errors.avatar = "Avatar must be under 2 MB.";
  }

  return errors;
}

export default function LaunchForm() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const router = useRouter();

  const [form, setForm] = useState<FormState>({
    name: "",
    symbol: "",
    supply: DEFAULT_SUPPLY,
    maxReserveCap: "",
    articleTitle: "",
  });
  const [avatar, setAvatar] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [stage, setStage] = useState<Stage>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);

  // Which chain this launch lands on. Every factory is a separate deployment
  // with its own address, its own curve terms and its own faucet, so this is
  // not a display preference — it decides what gets signed.
  const [chainSlug, setChainSlug] = useState<string>(
    FACTORY_DEPLOYMENT?.chain ?? DEFAULT_CHAIN_SLUG
  );

  // Starts empty on purpose. Prefilled body text has to be selected and deleted
  // before you can write, and whatever survives that gets published; the prompt
  // belongs in a placeholder that disappears on its own.
  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    // Required in the App Router: rendering the editor during SSR causes a
    // hydration mismatch.
    immediatelyRender: false,
  });

  const busy = stage !== "idle";
  const deployment = deploymentFor(chainSlug);
  const chainEntry = chainBySlug(deployment?.chain ?? "");
  const curve = deployment?.defaultConfig;
  // For the copy and the faucet links, which have something to say even before
  // a chain is picked or when none has a factory.
  const faucetChain = deployment?.chain ?? DEFAULT_CHAIN_SLUG;

  // Launching costs gas, and a wallet that has never touched this testnet has
  // none. Read the balance up front so the form can point at a faucet instead
  // of letting the wallet reject the signature — and keep reading it, so a
  // claim made in the faucet tab lands here without a reload.
  const {
    balance,
    noGas,
    checking: checkingGas,
    refetch: refetchBalance,
  } = useGasBalance({ address, chainId: chainEntry?.chain.id });

  // The curve opens at virtualEthReserve / supply, so the price a buyer first
  // sees is known before anything is signed.
  const openingPrice = useMemo(
    () => (/^\d+$/.test(form.supply.trim()) ? openingPriceEth(Number(form.supply), curve) : 0),
    [form.supply, curve]
  );

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
    if (!deployment || !curve) {
      setErrors({
        form: `No factory is configured on ${
          chainBySlug(chainSlug)?.chain.name ?? chainSlug
        }. Deploy one with contracts/script/DeployFactory.s.sol and commit the deployments/${chainSlug}.json it writes.`,
      });
      return;
    }
    if (!chainEntry) {
      setErrors({ form: `Unsupported chain "${deployment.chain}" in the deployment record.` });
      return;
    }
    if (noGas) {
      setErrors({
        form: `This wallet has no ${chainEntry.chain.nativeCurrency.symbol} on ${chainEntry.chain.name}, and launching costs gas. Claim some from a faucet below, then try again.`,
      });
      return;
    }

    const found = validate(form, avatar, curve);
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
      // asleep, so wake it before the write rather than failing on signature.
      setStage("launching");
      await ensureWalletReady(config);

      // The wallet must be on the factory's chain, or the call lands on
      // whatever network happens to be selected — where there is no factory.
      if (getAccount(config).chainId !== chainEntry.chain.id) {
        await switchChain(config, { chainId: chainEntry.chain.id }).catch((err) => {
          throw new Error(
            `Switch your wallet to ${chainEntry.chain.name} to launch. (${
              err instanceof Error ? err.message : String(err)
            })`
          );
        });
      }

      // The four-argument overload, always. Zero means "use the platform
      // default cap"; anything else tightens this launch's blast radius.
      const cap = form.maxReserveCap.trim() ? parseEther(form.maxReserveCap.trim()) : 0n;

      const hash = await writeContract(config, {
        address: deployment.factory,
        abi: FOLIO_FACTORY_ABI,
        functionName: "createToken",
        args: [form.name.trim(), form.symbol.trim(), BigInt(form.supply.trim()), cap],
        chainId: chainEntry.chain.id,
      });
      setTxHash(hash);

      setStage("confirming");
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainEntry.chain.id,
      });
      if (receipt.status !== "success") {
        throw new Error("The launch transaction reverted. Nothing was published.");
      }

      // The token address comes from the event, not from arithmetic. A clone's
      // address is a hash of the factory's nonce and the implementation, and
      // predicting it here would be a second implementation of something the
      // chain already told us.
      const created = parseEventLogs({
        abi: FOLIO_FACTORY_ABI,
        eventName: "TokenCreated",
        logs: receipt.logs,
      }).find((log) => log.address.toLowerCase() === deployment.factory.toLowerCase());

      if (!created) {
        throw new Error(
          `The launch transaction confirmed but emitted no TokenCreated event. Check ${hash} on the explorer before retrying.`
        );
      }

      // Lowercased so token page lookups by URL are case-insensitive.
      const contractAddress = created.args.token.toLowerCase();
      const wholeSupply = Number(formatUnits(created.args.totalSupply, 18));

      setStage("saving");
      const { error } = await supabase.from("tokens").insert({
        contract_address: contractAddress,
        chain: deployment.chain,
        name: form.name.trim(),
        symbol: form.symbol.trim(),
        supply: wholeSupply,
        // The curve has no fixed price. What is stored is its opening marginal
        // price — virtualEthReserve / supply, the one price that is knowable
        // before anyone trades. Every later price is read from the contract,
        // never from here.
        starting_price: openingPriceEth(wholeSupply, curve),
        creator_wallet: address.toLowerCase(),
        article_title: form.articleTitle.trim(),
        // An untouched editor still serialises to "<p></p>"; store nothing
        // rather than an empty paragraph.
        article_body: editor && !editor.isEmpty ? editor.getHTML() : "",
        avatar_url: avatarUrl,
        deploy_tx: hash,
      });

      if (error) {
        // The token is live even though the article didn't save, so surface the
        // address rather than losing it.
        throw new Error(
          `Token created at ${contractAddress}, but saving the article failed: ${error.message}`
        );
      }

      router.push(`/token/${contractAddress}`);
    } catch (err) {
      console.error("Launch failed:", err);
      // Messages thrown above are already written for a person; only wallet and
      // RPC failures need translating.
      const authored =
        err instanceof Error &&
        /^(Avatar upload failed|Switch your wallet|Token created at|The launch transaction)/.test(
          err.message
        );
      setErrors({ form: authored ? (err as Error).message : classifyTxError(err).message });
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
          Write the piece and mint the token it describes, in one transaction, on the Folio factory
          on {chainEntry?.chain.name ?? chainBySlug(DEFAULT_CHAIN_SLUG)?.chain.name ?? "a testnet"}.
          The article is yours and it is the listing — this is the way to publish on Folio under
          your own name. You pay only gas: the whole supply starts on a bonding curve, so anyone
          can buy from it or sell back to it at a price the curve sets, and you earn{" "}
          {curve ? formatBps(curve.feeBps) : "a"} fee on every trade in either direction.
        </p>
      </header>

      {FACTORY_DEPLOYMENTS.length === 0 && (
        <div className="notice notice--alert" role="alert" style={{ marginBottom: "var(--sp-5)" }}>
          <p className="notice__title">No factory configured</p>
          <p>
            Deploy one with <code>contracts/script/DeployFactory.s.sol</code> and commit the{" "}
            <code>deployments/&lt;chain&gt;.json</code> it writes, or set{" "}
            <code>NEXT_PUBLIC_FACTORY_ADDRESS</code>.
          </p>
        </div>
      )}

      {/*
        The network picker, shown only when there is a choice. A launch is
        permanent and lives on exactly one chain: its buyers need gas there, its
        curve terms come from that factory, and nothing later can move it. So
        this sits above the form rather than inside it, and it names the chain
        again on the button you press to sign.
      */}
      {hasMultipleLaunchChains && (
        <div style={{ marginBottom: "var(--sp-5)" }}>
          <span className="field__label">Launch network</span>
          <div
            className="chip-row"
            role="group"
            aria-label="Launch network"
            style={{ marginTop: "var(--sp-2)" }}
          >
            {FACTORY_DEPLOYMENTS.map((option) => (
              <button
                key={option.chain}
                type="button"
                className="chip"
                aria-pressed={option.chain === chainSlug}
                disabled={busy}
                onClick={() => {
                  setChainSlug(option.chain);
                  // The old chain's caps produced these, so they no longer
                  // describe anything. Re-validating happens on submit.
                  setErrors({});
                }}
              >
                {chainBySlug(option.chain)?.chain.name ?? option.chain}
              </button>
            ))}
          </div>
          <p className="field__hint" style={{ marginTop: "var(--sp-2)" }}>
            Each network has its own factory, its own curve terms and its own faucet. A token
            launched here cannot be moved to another one.
          </p>
        </div>
      )}

      {!isConnected && (
        <div className="notice" style={{ marginBottom: "var(--sp-5)" }}>
          <p className="notice__title">Connect a wallet to sign the launch</p>
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
            chain={faucetChain}
            heading={`No ${chainEntry?.chain.nativeCurrency.symbol ?? "test ETH"} to pay gas with`}
            onRecheck={() => void refetchBalance()}
            checking={checkingGas}
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

          <Field
            label="Total supply"
            hint="1,000,000,000 is the convention. Change it if you want to."
            error={errors.supply}
          >
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              placeholder={DEFAULT_SUPPLY}
              value={form.supply}
              onChange={(e) => set("supply")(e.target.value)}
              disabled={busy}
              className="input"
            />
          </Field>

          <Field
            label="Max reserve cap (ETH)"
            hint={
              curve
                ? `Optional. Blank uses the platform default of ${formatEth(
                    Number(formatEther(curve.maxReserveCap))
                  )} ETH. You may lower it, never raise it.`
                : "Optional."
            }
            error={errors.maxReserveCap}
          >
            <input
              type="number"
              min="0"
              step="0.001"
              inputMode="decimal"
              placeholder={curve ? formatEther(curve.maxReserveCap) : "5"}
              value={form.maxReserveCap}
              onChange={(e) => set("maxReserveCap")(e.target.value)}
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
            <div
              className={`editor${editor?.isEmpty ? " editor--empty" : ""}`}
              data-placeholder="Tell the story behind your token..."
            >
              <EditorContent editor={editor} />
            </div>
          </Field>
        </div>

        {curve && (
          <section className="factbox">
            <h2 className="factbox__head">
              <span>Curve terms</span>
              <span>Frozen at launch</span>
            </h2>
            {(
              [
                ["Opening price", <Eth key="price" value={openingPrice} suffix=" per token" />],
                /*
                  Not "opening market cap", which this never was: the figure is
                  the curve's virtual ETH reserve — the basis its prices are
                  computed from — and elsewhere "market cap" means price times
                  supply. Naming it that here invited a comparison with a
                  different number entirely.
                */
                [
                  "Starting reserve",
                  <Eth key="virtual" value={Number(formatEther(curve.virtualEthReserve))} />,
                ],
                [
                  "Buys close at",
                  curve.graduationThreshold > 0n ? (
                    <Eth
                      key="threshold"
                      value={Number(formatEther(curve.graduationThreshold))}
                      suffix=" in reserve"
                    />
                  ) : (
                    "never"
                  ),
                ],
                [
                  "Reserve ceiling",
                  <Eth
                    key="ceiling"
                    value={Number(
                      formatEther(
                        form.maxReserveCap.trim() && !errors.maxReserveCap
                          ? parseEther(form.maxReserveCap.trim())
                          : curve.maxReserveCap
                      )
                    )}
                  />,
                ],
                ["Your fee", `${formatBps(curve.feeBps)} of every buy and sell`],
              ] as [string, React.ReactNode][]
            ).map(([label, value]) => (
              <div key={label} className="factbox__row">
                <span className="factbox__label">{label}</span>
                <span className="factbox__value">{value}</span>
              </div>
            ))}
            <p className="field__hint" style={{ marginTop: "var(--sp-3)" }}>
              These terms are copied into your token when it is created. Nothing can change them
              afterwards — not you, not the platform.
            </p>
          </section>
        )}

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
                {explorerTxUrl(faucetChain, txHash) ? (
                  <a
                    href={explorerTxUrl(faucetChain, txHash) as string}
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
            disabled={!isConnected || busy || !deployment}
            className="btn btn--primary btn--block"
            // A launch is an upload, a deploy and a receipt; the sweep is the
            // only sign the sequence is still running. See globals.css.
            data-busy={busy || undefined}
          >
            {busy
              ? "Working..."
              : hasMultipleLaunchChains && chainEntry
                ? `Publish & launch on ${chainEntry.chain.name}`
                : "Publish & launch"}
          </button>

          <p className="field__hint" style={{ marginTop: "var(--sp-3)" }}>
            Need test ETH on {chainEntry?.chain.name ?? "this network"}?{" "}
            <FaucetLinks chain={faucetChain} />
          </p>
        </div>
      </div>
    </main>
  );
}

/** An ETH figure with its worth in the reader's currency underneath. */
function Eth({ value, suffix = "" }: { value: number; suffix?: string }) {
  return (
    <>
      {formatEth(value)} ETH{suffix}
      <FiatValue eth={value} block />
    </>
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
