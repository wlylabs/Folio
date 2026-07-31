import baseSepolia from "@/deployments/base-sepolia.json";
import { FOLIO_FACTORY_ABI } from "@/lib/contracts/folioFactory";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import type { ChainSlug } from "@/lib/chains";

/**
 * The one place the app learns where the factory lives.
 *
 * `deployments/base-sepolia.json` is written by
 * contracts/script/DeployFactory.s.sol and committed, so a re-deploy is a
 * one-file change: run the script, commit the JSON it rewrote, and every page
 * here follows. Nothing else in the codebase may hardcode a contract address.
 *
 * An env override exists on top of that, for pointing a preview deployment at a
 * factory that isn't the committed one without editing the repo:
 *
 *   NEXT_PUBLIC_FACTORY_ADDRESS=0x...
 *
 * It has to be NEXT_PUBLIC_*, because the create page reads it in the browser.
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

const record = baseSepolia as DeploymentRecord;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A 0x-prefixed 20-byte address, or null for the placeholders an unrun deploy
 *  script leaves behind. */
function address(value: string | undefined): `0x${string}` | null {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  return value.toLowerCase() === ZERO_ADDRESS ? null : (value as `0x${string}`);
}

const factoryAddress =
  address(process.env.NEXT_PUBLIC_FACTORY_ADDRESS) ?? address(record.factory);

/**
 * The deployed factory, or null when neither the committed record nor the env
 * override names one. Pages check for null and say the platform isn't
 * configured, rather than sending a transaction into the void.
 */
export const FACTORY_DEPLOYMENT: FactoryDeployment | null = factoryAddress
  ? {
      chain: "base-sepolia",
      chainId: record.chainId,
      factory: factoryAddress,
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
    }
  : null;

/** True when there is a factory to launch from. */
export const isFactoryConfigured = FACTORY_DEPLOYMENT !== null;

/**
 * The factory as wagmi/viem want it: `{ address, abi }`, both `as const`, so
 * `functionName`, `args` and return types are all inferred from the ABI rather
 * than trusted from a call site.
 *
 * Null when unconfigured — callers that would send a transaction must check.
 */
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
 */
export function openingPriceEth(
  wholeSupply: number,
  config: CurveConfig | undefined = FACTORY_DEPLOYMENT?.defaultConfig
): number {
  if (!config || !Number.isFinite(wholeSupply) || wholeSupply <= 0) return 0;
  return Number(config.virtualEthReserve) / 1e18 / wholeSupply;
}
