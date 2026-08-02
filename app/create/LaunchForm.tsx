"use client";

import { useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAccount, useConfig } from "wagmi";
import {
  getAccount,
  getPublicClient,
  simulateContract,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import type { Config } from "wagmi";
import {
  formatEther,
  formatUnits,
  getAbiItem,
  parseEther,
  parseEventLogs,
  type TransactionReceipt,
} from "viem";
import { useRouter } from "next/navigation";
import ConnectCue from "@/components/ConnectCue";
import FiatValue from "@/components/FiatValue";
import { GasNotice } from "@/components/GasNotice";
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
import {
  DEFAULT_CHAIN_SLUG,
  chainBySlug,
  explorerAddressUrl,
  explorerTxUrl,
} from "@/lib/chains";
import { useDeclarePreferredChain } from "@/lib/preferredChain";
import { classifyTxError } from "@/lib/txErrors";
import { ensureWalletReady } from "@/lib/walletReady";
import { formatBps, formatEth, shortAddress } from "@/lib/types";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * The image types the storage bucket accepts, which is what makes this list
 * worth keeping in step rather than loosening — see the bucket's
 * `allowed_mime_types` in lib/schema.sql, which is where the rule actually
 * lives. Checking it here too is not duplication for its own sake: it is the
 * difference between "Avatar must be a PNG…" under the field and a storage
 * error from Supabase after the reader has filled in the whole form.
 *
 * `image/svg+xml` is absent deliberately. An SVG is a document that can carry
 * script — inert inside the <img> a listing draws it in, and not inert at all
 * when someone opens the public storage link to it directly.
 */
const AVATAR_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

const AVATAR_TYPES = Object.keys(AVATAR_EXTENSIONS);

/**
 * A billion tokens, the memecoin convention. It is only a default — the field
 * takes anything the factory will accept, and the curve prices whatever supply
 * you choose against the same starting reserve, so a bigger supply is a smaller
 * opening price and nothing else.
 */
const DEFAULT_SUPPLY = "1000000000";

/**
 * The factory's own bounds on the opening window, mirrored so the form can
 * refuse a launch before it costs gas rather than after.
 *
 * Constants rather than reads, because they are `constant` on the factory and
 * cannot drift the way `defaultConfig` can — that one *is* read, and comes in
 * as `config`. Keep these in step with `FolioFactory.MAX_SNIPER_WINDOW_SECONDS`
 * and `MIN_SNIPER_MAX_ETH_PER_WALLET`; the chain is the authority either way,
 * and a stale copy here only costs a worse error message.
 */
const MAX_SNIPER_WINDOW_SECONDS = 3600;
const MIN_SNIPER_MAX_ETH_PER_WALLET = 100_000_000_000_000n; // 0.0001 ETH

/**
 * Something that stopped a launch, in the shape the box on screen needs.
 *
 * A launch fails in more than one place and the places are not alike: a
 * declined signature is not a failure at all, a stale factory address is a
 * deployment bug, and a confirmed transaction whose event went missing leaves
 * a token that may well exist. Each of those wants its own headline and, when
 * there is one, a link — the transaction and the token are the two facts a
 * reader can check for themselves, and pasting a 66-character hash into a
 * sentence is not a way of giving them either.
 */
type Failure = {
  /** The headline. One line, no punctuation at the end. */
  title: string;
  body: string;
  /** The launch transaction, when one was sent. Rendered short and linked. */
  hash?: string;
  /** The token, when it exists in spite of the failure. */
  token?: string;
  /** "plain" for the things that are not failures — a declined signature. */
  tone?: "alert" | "plain";
};

/**
 * An error carrying a {Failure} written for the person who hit it.
 *
 * Everything else reaching the catch is a wallet or RPC error, which
 * classifyTxError translates. This used to be told apart by matching the
 * message against the opening words of every sentence thrown above — a test
 * that quietly broke each time one of them was reworded.
 */
class AuthoredFailure extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(failure.body);
    this.name = "AuthoredFailure";
    this.failure = failure;
  }
}

const TOKEN_CREATED_EVENT = getAbiItem({ abi: FOLIO_FACTORY_ABI, name: "TokenCreated" });

/**
 * The TokenCreated log for a confirmed launch: the token's address and the
 * supply the factory actually minted, or null if neither can be found.
 *
 * The receipt is the first place to look and usually the last. A receipt that
 * comes back without the event does not mean the launch is lost, though: it is
 * assembled by whichever node the wallet happens to be talking to, and one that
 * is behind on indexing answers with a confirmed transaction and an empty log
 * list. So before concluding anything, ask the app's own RPC for that block's
 * logs — eth_getLogs is a different index from eth_getTransactionReceipt, and a
 * launch missing from only one of them is a launch that happened.
 *
 * Matched on the transaction hash, so a second launch landing in the same block
 * is never mistaken for this one.
 */
async function findCreatedToken(
  config: Config,
  {
    factory,
    chainId,
    hash,
    receipt,
  }: { factory: `0x${string}`; chainId: number; hash: string; receipt: TransactionReceipt }
): Promise<{ token: string; totalSupply: bigint } | null> {
  const fromReceipt = parseEventLogs({
    abi: FOLIO_FACTORY_ABI,
    eventName: "TokenCreated",
    logs: receipt.logs,
  }).find((log) => log.address.toLowerCase() === factory.toLowerCase());
  if (fromReceipt) {
    return { token: fromReceipt.args.token, totalSupply: fromReceipt.args.totalSupply };
  }

  const client = getPublicClient(config, { chainId });
  if (!client) return null;

  try {
    const logs = await client.getLogs({
      address: factory,
      event: TOKEN_CREATED_EVENT,
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
      strict: true,
    });
    const mine = logs.find((log) => log.transactionHash?.toLowerCase() === hash.toLowerCase());
    return mine ? { token: mine.args.token, totalSupply: mine.args.totalSupply } : null;
  } catch (err) {
    // A second lookup that cannot run leaves the receipt's answer standing.
    console.warn("Could not re-read the launch block for TokenCreated:", err);
    return null;
  }
}

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
  /** Optional opening-window length, in seconds. Empty means "platform
   *  default". May only be longer than the default — protection can be added to
   *  a launch, never taken off it. */
  sniperWindowSeconds: string;
  /** Optional per-wallet opening cap, in ETH. Empty means "platform default",
   *  and it may only be lower. */
  sniperMaxEthPerWallet: string;
  articleTitle: string;
};

/** Per-field errors. Whatever stops the whole form is a {Failure}, not one of
 *  these — it has a headline and links, and no field to sit under. */
type Errors = Partial<Record<keyof FormState | "avatar", string>>;

/**
 * @param config the curve terms of the chain being launched on. Passed in
 *        rather than read from a module constant: the caps differ per factory,
 *        and validating a launch against another chain's ceiling would reject a
 *        legal supply or accept an illegal one.
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

  // The opening window, which moves the opposite way to everything else on this
  // form: a *longer* window and a *smaller* per-wallet bite are the tightenings,
  // because both hand the launch's buyers more protection from snipers. The
  // factory refuses the other direction, and so does this.
  const windowRaw = form.sniperWindowSeconds.trim();
  if (windowRaw) {
    if (!/^\d+$/.test(windowRaw)) {
      errors.sniperWindowSeconds = "Whole seconds, digits only.";
    } else {
      const seconds = Number(windowRaw);
      if (seconds > MAX_SNIPER_WINDOW_SECONDS) {
        errors.sniperWindowSeconds = `The platform allows at most ${MAX_SNIPER_WINDOW_SECONDS} seconds.`;
      } else if (config && seconds < config.sniperWindowSeconds) {
        errors.sniperWindowSeconds = `A launch may only lengthen the window. The platform default is ${config.sniperWindowSeconds}s.`;
      }
    }
  }

  const walletCapRaw = form.sniperMaxEthPerWallet.trim();
  if (walletCapRaw) {
    if (!/^\d*\.?\d+$/.test(walletCapRaw)) {
      errors.sniperMaxEthPerWallet = "Use a plain decimal number, e.g. 0.05.";
    } else if ((walletCapRaw.split(".")[1]?.length ?? 0) > 18) {
      errors.sniperMaxEthPerWallet = "At most 18 decimal places.";
    } else {
      const walletCap = parseEther(walletCapRaw);
      if (walletCap < MIN_SNIPER_MAX_ETH_PER_WALLET) {
        errors.sniperMaxEthPerWallet = "The platform minimum is 0.0001 ETH.";
      } else if (
        config &&
        config.sniperMaxEthPerWallet > 0n &&
        walletCap > config.sniperMaxEthPerWallet
      ) {
        errors.sniperMaxEthPerWallet = `A launch may only lower the per-wallet cap. The platform default is ${formatEth(
          Number(formatEther(config.sniperMaxEthPerWallet))
        )} ETH.`;
      }
    }
  }

  // A creator switching the window on for a platform that ships it off has to
  // name the cap it runs under; the factory rejects the half-configured pair.
  if (windowRaw && !errors.sniperWindowSeconds && config?.sniperMaxEthPerWallet === 0n) {
    if (!walletCapRaw) {
      errors.sniperMaxEthPerWallet =
        "This platform has no default per-wallet cap, so a window needs one set here.";
    }
  }

  const title = form.articleTitle.trim();
  if (!title) errors.articleTitle = "Your launch needs a headline.";
  else if (title.length > 200) errors.articleTitle = "Keep the headline under 200 characters.";

  if (avatar) {
    if (!AVATAR_TYPES.includes(avatar.type)) {
      errors.avatar = "Avatar must be a PNG, JPEG, GIF, WebP or AVIF image.";
    } else if (avatar.size > MAX_AVATAR_BYTES) {
      errors.avatar = "Avatar must be under 2 MB.";
    }
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
    sniperWindowSeconds: "",
    sniperMaxEthPerWallet: "",
    articleTitle: "",
  });
  const [avatar, setAvatar] = useState<File | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);

  // Which chain this launch lands on. Every factory is a separate deployment
  // with its own address and its own curve terms, so this is not a display
  // preference — it decides what gets signed.
  const [chainSlug, setChainSlug] = useState<string>(
    FACTORY_DEPLOYMENT?.chain ?? DEFAULT_CHAIN_SLUG
  );

  // Which chain a wallet connecting from this page should be asked for. Picking
  // from the selector above only changes where an unsupported wallet gets moved
  // to; a wallet already on a supported chain is left alone until the launch is
  // signed, which is where the switch that matters happens.
  useDeclarePreferredChain(chainSlug);

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
  // Which chain the copy, the explorer links and the gas notice speak about.
  // Falls back to the default so those still say something before a chain is
  // picked, or when none of them has a factory.
  const launchChain = deployment?.chain ?? DEFAULT_CHAIN_SLUG;

  // Launching costs gas, and a wallet that has never touched this network has
  // none. Read the balance up front so the form can say so instead of letting
  // the wallet reject the signature — and keep reading it, so ETH that arrives
  // in another tab lands here without a reload.
  const {
    noGas,
    unreadable: gasUnreadable,
    elsewhere: gasElsewhere,
    checking: checkingGas,
    refetch: refetchBalance,
  } = useGasBalance({ address, chainId: chainEntry?.chain.id });

  /**
   * What to tell a creator whose gas turned out to be on another chain.
   *
   * The launch is the one screen where finding the money elsewhere can be good
   * news: nothing has been signed yet, so if Folio has a factory on the chain
   * the ETH is actually on, the listing can go there instead and funding stops
   * being the blocker. That is one press — the same press the network picker
   * makes, aimed by the balance sweep rather than by the creator guessing
   * which network their ETH is on.
   *
   * Worth being deliberate about, because the press moves the launch to
   * wherever the money is and every chain Folio supports spends real ETH. The
   * button names the chain it would switch to, and the chain picker sits next
   * to it either way. With Robinhood Chain the only supported network the
   * sweep finds nothing and none of this renders — see useGasBalance.
   *
   * When there is no factory there, the honest answer is the other one. A
   * creator who knows their ETH is on the other network will otherwise go
   * looking for a bridge or a setting that would let them spend it, and there
   * isn't one; saying so is what ends that search.
   */
  const elsewhereDeployment = gasElsewhere ? deploymentFor(gasElsewhere.slug) : null;
  const wayOut = !gasElsewhere
    ? null
    : elsewhereDeployment
      ? {
          note: `Folio launches on ${gasElsewhere.name} too — this listing can go there instead and spend the ${gasElsewhere.symbol} you already hold. That factory's curve terms apply, and the token stays on that network for good.`,
          action: {
            label: `Launch on ${gasElsewhere.name} instead`,
            disabled: busy,
            onClick: () => {
              setChainSlug(elsewhereDeployment.chain);
              // Same reason as the network picker: these errors were measured
              // against the old chain's caps and no longer describe anything.
              setErrors({});
            },
          },
        }
      : {
          note: `Folio has no factory on ${gasElsewhere.name}, so there is nowhere to move this launch to: nothing on Folio can spend that balance where it sits.`,
        };

  // The curve opens at virtualEthReserve / supply, so the price a buyer first
  // sees is known before anything is signed.
  const openingPrice = useMemo(
    () => (/^\d+$/.test(form.supply.trim()) ? openingPriceEth(Number(form.supply), curve) : 0),
    [form.supply, curve]
  );

  const set = (key: keyof FormState) => (value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
    setFailure(null);
  };

  async function uploadAvatar(file: File, owner: string): Promise<string> {
    /*
     * The extension comes from the type, not from the name.
     *
     * A filename is whatever the reader's disk says it is — "logo.html", or no
     * extension at all — and it used to be carried straight through into the
     * object's path. The bucket's insert policy now checks that extension
     * (lib/schema.sql), so deriving it from the type the file was validated as
     * is both the honest name for the object and the one that will be accepted.
     */
    const ext = AVATAR_EXTENSIONS[file.type] ?? "png";
    const path = `${owner.toLowerCase()}/${Date.now()}.${ext}`;

    const { error } = await supabase.storage
      .from("token-avatars")
      .upload(path, file, { contentType: file.type, upsert: false });
    // The caller supplies the "what failed" half; this is only the "why".
    if (error) throw new Error(error.message);

    return supabase.storage.from("token-avatars").getPublicUrl(path).data.publicUrl;
  }

  const handleSubmit = async () => {
    if (!isConnected || !address) return;

    if (!isSupabaseConfigured) {
      setFailure({
        title: "Publishing isn't configured",
        body: "Supabase isn't set up, so there is nowhere to store the article this token belongs to. See .env.example.",
      });
      return;
    }
    if (!deployment || !curve) {
      setFailure({
        title: `No factory on ${chainBySlug(chainSlug)?.chain.name ?? chainSlug}`,
        body: `Deploy one with contracts/script/DeployFactory.s.sol and commit the deployments/${chainSlug}.json it writes.`,
      });
      return;
    }
    if (!chainEntry) {
      setFailure({
        title: "The deployment record names a chain this build doesn't support",
        body: `deployments/${deployment.chain}.json is for "${deployment.chain}", which is not in SUPPORTED_CHAINS.`,
      });
      return;
    }
    if (noGas) {
      setFailure({
        title: `No ${chainEntry.chain.nativeCurrency.symbol} to pay gas with`,
        body: `This wallet holds nothing on ${chainEntry.chain.name}, and launching costs gas. Fund it on ${chainEntry.chain.name}, then try again.`,
      });
      return;
    }

    const found = validate(form, avatar, curve);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setErrors({});
    setFailure(null);
    setTxHash(null);

    // Held locally as well as in state: the catch below runs in the closure
    // this render created, where `txHash` is still whatever it was before the
    // launch started.
    let sentHash: `0x${string}` | null = null;

    try {
      let avatarUrl: string | null = null;
      if (avatar) {
        setStage("uploading");
        try {
          avatarUrl = await uploadAvatar(avatar, address);
        } catch (err) {
          throw new AuthoredFailure({
            title: "The avatar didn't upload",
            body: `${err instanceof Error ? err.message : String(err)} Nothing was signed — try again, or launch without an avatar.`,
          });
        }
      }

      // A stored session can look connected while its connector is still
      // asleep, so wake it before the write rather than failing on signature.
      setStage("launching");
      await ensureWalletReady(config);

      // The wallet must be on the factory's chain, or the call lands on
      // whatever network happens to be selected — where there is no factory.
      if (getAccount(config).chainId !== chainEntry.chain.id) {
        await switchChain(config, { chainId: chainEntry.chain.id }).catch((err) => {
          throw new AuthoredFailure({
            title: `Your wallet is not on ${chainEntry.chain.name}`,
            body: `The launch has to be signed there, and the switch was refused: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        });
      }

      // The six-argument overload, always. Zero means "use the platform default"
      // for each of the three; anything else tightens this launch — a smaller
      // blast radius, a longer opening window, a smaller bite per wallet. None
      // of them can go the other way, here or on the factory.
      const cap = form.maxReserveCap.trim() ? parseEther(form.maxReserveCap.trim()) : 0n;
      const sniperWindow = form.sniperWindowSeconds.trim()
        ? Number(form.sniperWindowSeconds.trim())
        : 0;
      const sniperCap = form.sniperMaxEthPerWallet.trim()
        ? parseEther(form.sniperMaxEthPerWallet.trim())
        : 0n;

      const call = {
        address: deployment.factory,
        abi: FOLIO_FACTORY_ABI,
        functionName: "createToken",
        args: [
          form.name.trim(),
          form.symbol.trim(),
          BigInt(form.supply.trim()),
          cap,
          sniperWindow,
          sniperCap,
        ],
        chainId: chainEntry.chain.id,
      } as const;

      // Ask the chain what this call would do before asking anyone to sign it.
      // The case that matters is an address with no contract behind it: a call
      // to one succeeds, costs gas and emits nothing, which at the receipt is
      // indistinguishable from a launch that vanished. eth_call names it now,
      // before the money is spent — as it does a paused factory, or a supply
      // this factory's curve won't take.
      try {
        await simulateContract(config, { ...call, account: address });
      } catch (err) {
        const refusal = classifyTxError(err);
        if (refusal.reason === "NoContract") {
          throw new AuthoredFailure({
            title: `No factory answered on ${chainEntry.chain.name}`,
            body: `Nothing at ${deployment.factory} responded to createToken, so signing this would spend gas and create nothing. That address comes from deployments/${deployment.chain}.json — re-run DeployFactory.s.sol against ${chainEntry.chain.name} and commit the record it writes.`,
          });
        }
        if (refusal.kind === "reverted") {
          throw new AuthoredFailure({
            title: "The chain would refuse this launch",
            body: `${refusal.message} Nothing was signed and no gas was spent.`,
          });
        }
        // An RPC that never answered is not a verdict on the launch. The wallet
        // gets its turn: a preflight that could not run is no reason to block a
        // transaction that would have gone through.
        console.warn("Launch preflight could not run:", err);
      }

      const hash = await writeContract(config, call);
      sentHash = hash;
      setTxHash(hash);

      setStage("confirming");
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainEntry.chain.id,
      });
      if (receipt.status !== "success") {
        throw new AuthoredFailure({
          title: "The launch transaction reverted",
          body: "The chain rejected it, so no token was created and nothing was published. The gas is spent either way.",
          hash,
        });
      }

      // The token address comes from the event, not from arithmetic. A clone's
      // address is a hash of the factory's nonce and the implementation, and
      // predicting it here would be a second implementation of something the
      // chain already told us.
      const created = await findCreatedToken(config, {
        factory: deployment.factory,
        chainId: chainEntry.chain.id,
        hash,
        receipt,
      });

      if (!created) {
        throw new AuthoredFailure({
          title: "The launch confirmed, but its token never turned up",
          body: "No TokenCreated event came back for this transaction — not on the receipt, and not in the logs of the block it landed in — so the article was not published. Open it on the explorer before launching again: if it did create a token, a second launch creates a second one.",
          hash,
        });
      }

      // Lowercased so token page lookups by URL are case-insensitive.
      const contractAddress = created.token.toLowerCase();
      const wholeSupply = Number(formatUnits(created.totalSupply, 18));

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
        throw new AuthoredFailure({
          title: "Your token is live, but the article didn't save",
          body: `The launch went through on ${chainEntry.chain.name}; storing the listing that goes with it failed: ${error.message}. The token exists and is tradeable — do not launch it again.`,
          hash,
          token: contractAddress,
        });
      }

      router.push(`/token/${contractAddress}`);
    } catch (err) {
      console.error("Launch failed:", err);

      if (err instanceof AuthoredFailure) {
        setFailure(err.failure);
      } else {
        // Everything left is the wallet or the RPC talking.
        const classified = classifyTxError(err);
        setFailure({
          title:
            classified.kind === "cancelled"
              ? "Launch cancelled"
              : classified.kind === "network"
                ? "The network didn't answer"
                : "The launch didn't go through",
          body:
            classified.kind === "cancelled"
              ? "You declined the transaction in your wallet, so nothing was published and nothing was spent."
              : classified.message,
          // A cancellation is not an error. Painting it red is how a launchpad
          // ends up feeling broken to someone who simply changed their mind.
          tone: classified.kind === "cancelled" ? "plain" : "alert",
          hash: sentHash ?? undefined,
        });
      }
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
          on{" "}
          {chainEntry?.chain.name ??
            chainBySlug(DEFAULT_CHAIN_SLUG)?.chain.name ??
            "a supported network"}
          .
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
            Each network has its own factory and its own curve terms. A token launched here
            cannot be moved to another one.
          </p>
        </div>
      )}

      {/*
        The notice carries the request rather than describing where to make it.
        Same button, same label, same states as the one in the settings panel —
        it is the same component. See ConnectCue.
      */}
      {!isConnected && (
        <div className="notice" style={{ marginBottom: "var(--sp-5)" }}>
          <p className="notice__title">Connect a wallet to sign the launch</p>
          <p>Nothing is published until you approve the transaction.</p>
          <div className="connect-cue">
            <ConnectCue />
          </div>
        </div>
      )}

      {/*
        No balance is printed for a funded wallet, deliberately.

        The wallet shows that number itself, at the signature, with more
        authority than this page can borrow — and there is nothing here to
        decide with it. A launch has no ETH input the way a trade does, where
        the balance is the ceiling on what you can type; it costs gas, in an
        amount this screen cannot predict. So the reading that matters is
        binary, and only one side of it is worth a line: the notice below,
        which speaks when the wallet cannot pay, or when the balance could not
        be read at all. Silence here means the launch is payable.

        What the wallet cannot say is kept: it reports the chain it is on,
        while `useGasBalance` reads the chain this launch deploys to, and gas
        on the wrong network is invisible from inside the wallet. That, and
        the fact that a signature comes too late — the avatar has already
        uploaded by then — is what the `noGas` gate in `submit` is for.
      */}
      {isConnected && (noGas || gasUnreadable) && (
        <div style={{ marginTop: "var(--sp-4)" }}>
          <GasNotice
            chain={launchChain}
            heading={`No ${chainEntry?.chain.nativeCurrency.symbol ?? "test ETH"} to pay gas with`}
            address={address}
            elsewhere={gasElsewhere}
            wayOut={wayOut}
            unreadable={gasUnreadable}
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

          <Field
            label="Opening window (seconds)"
            hint={
              curve
                ? `Optional. Blank uses the platform default of ${curve.sniperWindowSeconds}s. You may lengthen it, never shorten it — a longer window is more protection from snipers, not less.`
                : "Optional."
            }
            error={errors.sniperWindowSeconds}
          >
            <input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              placeholder={curve ? String(curve.sniperWindowSeconds) : "120"}
              value={form.sniperWindowSeconds}
              onChange={(e) => set("sniperWindowSeconds")(e.target.value)}
              disabled={busy}
              className="input"
            />
          </Field>

          <Field
            label="Opening cap per wallet (ETH)"
            hint={
              curve && curve.sniperMaxEthPerWallet > 0n
                ? `Optional. Blank uses the platform default of ${formatEth(
                    Number(formatEther(curve.sniperMaxEthPerWallet))
                  )} ETH. You may lower it, never raise it. It caps addresses, not people — a determined bot can fund more wallets.`
                : "Optional. This platform sets no default, so a window you switch on needs a cap here."
            }
            error={errors.sniperMaxEthPerWallet}
          >
            <input
              type="number"
              min="0"
              step="0.0001"
              inputMode="decimal"
              placeholder={
                curve && curve.sniperMaxEthPerWallet > 0n
                  ? formatEther(curve.sniperMaxEthPerWallet)
                  : "0.1"
              }
              value={form.sniperMaxEthPerWallet}
              onChange={(e) => set("sniperMaxEthPerWallet")(e.target.value)}
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
              // The same list the bucket enforces, so the file picker offers
              // only files that will be accepted.
              accept={AVATAR_TYPES.join(",")}
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
                [
                  "Opening window",
                  (() => {
                    const seconds =
                      form.sniperWindowSeconds.trim() && !errors.sniperWindowSeconds
                        ? Number(form.sniperWindowSeconds.trim())
                        : curve.sniperWindowSeconds;
                    if (seconds === 0) return "none — no per-wallet cap at launch";
                    const walletCap =
                      form.sniperMaxEthPerWallet.trim() && !errors.sniperMaxEthPerWallet
                        ? parseEther(form.sniperMaxEthPerWallet.trim())
                        : curve.sniperMaxEthPerWallet;
                    return (
                      <>
                        <Eth value={Number(formatEther(walletCap))} /> per wallet for {seconds}s
                      </>
                    );
                  })(),
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

        {failure && <FailureNotice failure={failure} chain={launchChain} />}

        {busy && (
          <p className="status" role="status">
            {STAGE_LABEL[stage as Exclude<Stage, "idle">]}
            {txHash && (
              <>
                {" "}
                {explorerTxUrl(launchChain, txHash) ? (
                  <a
                    href={explorerTxUrl(launchChain, txHash) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    follow it on the explorer
                  </a>
                ) : (
                  <span className="mono">tx {shortAddress(txHash)}</span>
                )}
              </>
            )}
          </p>
        )}

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
      </div>
    </main>
  );
}

/**
 * What went wrong, boxed like every other notice on the site.
 *
 * The transaction and the token are given as short forms with a link, not as
 * full hashes in a sentence: sixty-six unbreakable characters in a paragraph
 * overflow the box on a phone, and a reader who wants to check the transaction
 * wants to open it, not to read it out. Both of them are also the reason this
 * box exists at all — every failure after signing leaves something on chain
 * that the reader needs to look at before deciding whether to try again.
 */
function FailureNotice({ failure, chain }: { failure: Failure; chain: string }) {
  const txUrl = failure.hash ? explorerTxUrl(chain, failure.hash) : null;
  const tokenUrl = failure.token ? explorerAddressUrl(chain, failure.token) : null;

  return (
    <div
      className={`notice${failure.tone === "plain" ? "" : " notice--alert"}`}
      // A cancellation is announced, not interrupted with.
      role={failure.tone === "plain" ? "status" : "alert"}
    >
      <p className="notice__title">{failure.title}</p>
      <p>{failure.body}</p>

      {failure.token && (
        <p style={{ marginTop: "var(--sp-2)" }}>
          Token <span className="mono">{shortAddress(failure.token)}</span>
          {tokenUrl && (
            <>
              {" · "}
              <a href={tokenUrl} target="_blank" rel="noopener noreferrer">
                view on explorer
              </a>
            </>
          )}
        </p>
      )}

      {failure.hash && (
        <p style={{ marginTop: "var(--sp-2)" }}>
          Transaction <span className="mono">{shortAddress(failure.hash)}</span>
          {txUrl && (
            <>
              {" · "}
              <a href={txUrl} target="_blank" rel="noopener noreferrer">
                view on explorer
              </a>
            </>
          )}
        </p>
      )}
    </div>
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
