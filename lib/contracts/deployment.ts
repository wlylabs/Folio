import baseSepoliaRecord from "@/deployments/base-sepolia.json";
import robinhoodTestnetRecord from "@/deployments/robinhood-testnet.json";
import { FOLIO_FACTORY_ABI } from "@/lib/contracts/folioFactory";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { DEFAULT_CHAIN_SLUG, SUPPORTED_CHAINS, chainIdBySlug, type ChainSlug } from "@/lib/chains";

/**
 * The one place the app learns where the factories live — one per chain.
 *
 * `deployments/<slug>.json` is written by contracts/script/DeployFactory.s.sol
 * and committed, so a re-deploy is a one-file change: run the script, commit
 * the JSON it rewrote, and every page here follows. Nothing else in the
 * codebase may hardcode a contract address.
 *
 * A chain appears here only if it has a record. That is deliberate: the curve
 * terms shown before you sign come out of the same file as the address, so a
 * chain with an address and no record would have the site quoting terms it
 * guessed. Adding a chain is therefore two steps — an entry in SUPPORTED_CHAINS
 * so the app can read it, and a committed deployment record so it can launch
 * on it.
 *
 * Env overrides exist on top of that, for pointing a preview deployment at a
 * factory that isn't the committed one without editing the repo:
 *
 *   NEXT_PUBLIC_FACTORY_ADDRESS_BASE_SEPOLIA=0x...
 *   NEXT_PUBLIC_FACTORY_ADDRESS_ROBINHOOD_TESTNET=0x...
 *   NEXT_PUBLIC_FACTORY_ADDRESS=0x...   (the default chain, kept for back-compat)
 *
 * They have to be NEXT_PUBLIC_*, because the create page reads them in the
 * browser, and they override the *address* only — the curve terms still come
 * from the record, because that is where a deploy wrote them.
 */

/** The shape DeployFactory.s.sol writes. Wei values are strings — they exceed
 *  2^53 and would lose precision the moment JSON.parse touched them. */
type DeploymentRecord = {
  network: string;
  chainId: number;
  factory: string;
  implementation: string;
  owner: string;
  deployer: string;
  deployedAtBlock: number;
  deployedAtTimestamp: number;
  explorer: string;
  lastToken: string;
  defaultConfig: {
    virtualEthReserve: string;
    maxReserveCap: string;
    graduationThreshold: string;
    feeBps: number;
    priceMoveAlertBps: number;
  };
};

export type CurveConfig = {
  virtualEthReserve: bigint;
  maxReserveCap: bigint;
  graduationThreshold: bigint;
  feeBps: number;
  priceMoveAlertBps: number;
};

export type FactoryDeployment = {
  chain: ChainSlug;
  chainId: number;
  factory: `0x${string}`;
  implementation: `0x${string}`;
  owner: `0x${string}`;
  /** Block the factory was deployed in, or 0 when the record predates that
   *  field. Zero means "find it at runtime" — see resolveFactoryStartBlock. */
  deployedAtBlock: bigint;
  /** Curve terms the factory hands to the *next* launch. A live token holds its
   *  own frozen copy, so this is a preview, never a source of truth for one. */
  defaultConfig: CurveConfig;
};

/**
 * The committed records, keyed by slug.
 *
 * Statically imported one by one rather than resolved from the slug at runtime:
 * the bundler has to see every path it must include, and `deployments/` is not
 * readable from the browser at all. A new chain adds a line here.
 */
const RECORDS: Partial<Record<ChainSlug, DeploymentRecord>> = {
  "base-sepolia": baseSepoliaRecord as DeploymentRecord,
  "robinhood-testnet": robinhoodTestnetRecord as DeploymentRecord,
};

/**
 * Per-chain address overrides. Also spelled out rather than looked up by slug,
 * because Next.js inlines `process.env.NEXT_PUBLIC_*` by matching the literal
 * text — a computed key reads as undefined in the browser.
 */
const ADDRESS_OVERRIDES: Partial<Record<ChainSlug, string | undefined>> = {
  "base-sepolia": process.env.NEXT_PUBLIC_FACTORY_ADDRESS_BASE_SEPOLIA,
  sepolia: process.env.NEXT_PUBLIC_FACTORY_ADDRESS_SEPOLIA,
  "robinhood-testnet": process.env.NEXT_PUBLIC_FACTORY_ADDRESS_ROBINHOOD_TESTNET,
};

/** The old single-chain override, still honoured — for the default chain. */
const LEGACY_OVERRIDE = process.env.NEXT_PUBLIC_FACTORY_ADDRESS;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A 0x-prefixed 20-byte address, or null for the placeholders an unrun deploy
 *  script leaves behind. */
function address(value: string | undefined): `0x${string}` | null {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase() === ZERO_ADDRESS ? null : (value as `0x${string}`);
}

function buildDeployment(slug: ChainSlug): FactoryDeployment | null {
  const record = RECORDS[slug];
  if (!record) return null;

  const override =
    address(ADDRESS_OVERRIDES[slug]) ??
    (slug === DEFAULT_CHAIN_SLUG ? address(LEGACY_OVERRIDE) : null);

  const factory = override ?? address(record.factory);
  if (!factory) return null;

  // A record whose chainId disagrees with the chain we would send the
  // transaction to is a misconfiguration that only shows up as funds spent on
  // the wrong network, so it disqualifies the chain rather than being trusted.
  // The usual cause is a record copied between files by hand.
  const expected = chainIdBySlug(slug);
  if (expected !== undefined && record.chainId !== expected) {
    console.warn(
      `deployments/${slug}.json says chainId ${record.chainId}, but ${slug} is ` +
        `chain ${expected}. Ignoring the record — fix the file or re-run ` +
        `DeployFactory.s.sol against the right RPC.`
    );
    return null;
  }

  return {
    chain: slug,
    chainId: record.chainId,
    factory,
    implementation: address(record.implementation) ?? ZERO_ADDRESS,
    owner: address(record.owner) ?? ZERO_ADDRESS,
    deployedAtBlock: BigInt(record.deployedAtBlock || 0),
    defaultConfig: {
      virtualEthReserve: BigInt(record.defaultConfig.virtualEthReserve),
      maxReserveCap: BigInt(record.defaultConfig.maxReserveCap),
      graduationThreshold: BigInt(record.defaultConfig.graduationThreshold),
      feeBps: record.defaultConfig.feeBps,
      priceMoveAlertBps: record.defaultConfig.priceMoveAlertBps,
    },
  };
}

/**
 * Every chain that has a factory, in SUPPORTED_CHAINS order.
 *
 * Empty means nothing is deployed anywhere, which pages report as "not
 * configured" rather than sending a transaction into the void.
 */
export const FACTORY_DEPLOYMENTS: readonly FactoryDeployment[] = SUPPORTED_CHAINS.map((entry) =>
  buildDeployment(entry.slug)
).filter((d): d is FactoryDeployment => d !== null);

const BY_SLUG = new Map(FACTORY_DEPLOYMENTS.map((d) => [d.chain, d]));

/** The factory on one chain, or null when nothing is deployed there. Takes a
 *  plain string because it is usually a `tokens.chain` value from the database,
 *  which can name a chain this build no longer supports. */
export function deploymentFor(chain: string | null | undefined): FactoryDeployment | null {
  if (!chain) return null;
  return BY_SLUG.get(chain as ChainSlug) ?? null;
}

/**
 * The chain a launch starts on unless the creator picks another: the configured
 * default when it has a factory, otherwise the first chain that does.
 *
 * Everything that reads one deployment without being about a specific token —
 * the front page's curve terms, the create form's initial state — reads this
 * one.
 */
export const FACTORY_DEPLOYMENT: FactoryDeployment | null =
  deploymentFor(DEFAULT_CHAIN_SLUG) ?? FACTORY_DEPLOYMENTS[0] ?? null;

/** True when there is at least one factory to launch from. */
export const isFactoryConfigured = FACTORY_DEPLOYMENTS.length > 0;

/** True when a creator has a choice to make, i.e. the picker is worth showing. */
export const hasMultipleLaunchChains = FACTORY_DEPLOYMENTS.length > 1;

/**
 * A factory as wagmi/viem want it: `{ address, abi }`, both `as const`, so
 * `functionName`, `args` and return types are all inferred from the ABI rather
 * than trusted from a call site.
 *
 * Null when that chain has no factory — callers that would send a transaction
 * must check.
 */
export function factoryContractFor(chain: string | null | undefined) {
  const deployment = deploymentFor(chain);
  return deployment ? ({ address: deployment.factory, abi: FOLIO_FACTORY_ABI } as const) : null;
}

/** The same, for the default chain. */
export const factoryContract = FACTORY_DEPLOYMENT
  ? ({ address: FACTORY_DEPLOYMENT.factory, abi: FOLIO_FACTORY_ABI } as const)
  : null;

/** The same, for one launch. Every launch is a proxy over the same
 *  implementation, so they all answer to this ABI. */
export function tokenContract(address: string) {
  return { address: address as `0x${string}`, abi: FOLIO_TOKEN_ABI } as const;
}

/**
 * The opening marginal price of a launch, in ETH per whole token.
 *
 * The curve opens at `virtualEthReserve / wholeSupply` — the whole supply sits
 * on the curve, so the opening price falls out of the config and the supply
 * alone, with no chain read. The create page shows this before you sign and
 * stores it as the listing's `starting_price`.
 *
 * Pass the config of the chain being launched on. The default is only the
 * fallback for callers that have no particular chain in hand.
 */
export function openingPriceEth(
  wholeSupply: number,
  config: CurveConfig | undefined = FACTORY_DEPLOYMENT?.defaultConfig
): number {
  if (!config || !Number.isFinite(wholeSupply) || wholeSupply <= 0) return 0;
  return Number(config.virtualEthReserve) / 1e18 / wholeSupply;
}
