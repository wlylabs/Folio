import { getAbiItem, parseEventLogs, type Log } from "viem";
import { FOLIO_FACTORY_ABI } from "@/lib/contracts/folioFactory";

/**
 * The factory generation that predates the opening window.
 *
 * ## What happened, plainly
 *
 * `CurveConfig` gained three fields — `sniperWindowSeconds`,
 * `sniperMaxEthPerWallet` and `migrator` — after the factory on Robinhood Chain
 * was deployed. That struct is an argument to `createToken`'s widest overload
 * and a member of the `TokenCreated` event, so growing it changed both: a new
 * function selector, and a new `topic0`.
 *
 * A factory deployed before that change does not have the six-argument
 * `createToken` at all, and the event it emits hashes to a different topic than
 * the generated ABI describes. Which makes the failure mode worth stating,
 * because neither half of it looks like a version mismatch from the outside:
 *
 *  - a launch reverts, with the chain declining a function that is not there;
 *  - and had it not reverted, the create page would have confirmed a
 *    transaction and then reported that its token "never turned up", because
 *    the log it went looking for was filtered on the wrong topic;
 *  - and `/api/indexer` would keep answering `found: 0` on a factory with
 *    launches in it, forever, with nothing anywhere looking broken.
 *
 * ## The rule this file follows
 *
 * The same one `lib/tokenStats.ts` already follows for listings: discover what
 * is actually at an address by reading it, and speak the dialect it answers to,
 * rather than the one the repository happens to have compiled last. A deploy is
 * an event in the world, and a frontend that can only talk to the contract it
 * was built alongside is a frontend that breaks every time one is not redone.
 *
 * So this module carries the older shapes — enough of them to launch, and
 * enough to read a launch back — and the callers pick between the two.
 *
 * Regenerating `lib/contracts/*.ts` does not touch this file: solc emits the
 * ABI of the source in front of it, and the whole point here is the source that
 * is *not* in front of it any more. The fragments below are written out by hand
 * for that reason, and they are frozen — a contract already on chain cannot
 * change shape.
 */

/**
 * `createToken` and `TokenCreated` as the pre-window factory has them.
 *
 * Only these two. Everything else the app reads off a factory — `paused`,
 * `owner`, `implementation`, `isFolioToken`, the bounds constants — kept its
 * signature across the change, so the generated ABI speaks to both generations
 * for all of it. Duplicating those here would be three more things to keep in
 * step for no benefit at all.
 */
export const LEGACY_FOLIO_FACTORY_ABI = [
  {
    type: "function",
    name: "createToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name_", type: "string" },
      { name: "symbol_", type: "string" },
      { name: "wholeSupply", type: "uint256" },
      { name: "maxReserveCap", type: "uint256" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
  {
    type: "event",
    name: "TokenCreated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "totalSupply", type: "uint256", indexed: false },
      {
        name: "config",
        type: "tuple",
        indexed: false,
        components: [
          { name: "virtualEthReserve", type: "uint256" },
          { name: "maxReserveCap", type: "uint256" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "feeBps", type: "uint16" },
          { name: "priceMoveAlertBps", type: "uint16" },
        ],
      },
    ],
  },
] as const;

/** The `TokenCreated` item of each generation, for a log filter. */
export const TOKEN_CREATED_EVENTS = [
  getAbiItem({ abi: FOLIO_FACTORY_ABI, name: "TokenCreated" }),
  getAbiItem({ abi: LEGACY_FOLIO_FACTORY_ABI, name: "TokenCreated" }),
] as const;

/**
 * The read that tells the two generations apart.
 *
 * `MAX_SNIPER_WINDOW_SECONDS` is a constant that arrived with the window, so a
 * factory that answers it is one that has the mechanism — and therefore the
 * six-argument `createToken` and the wider event. A factory that does not
 * answer it reverts, which is the answer.
 *
 * Chosen over probing `defaultConfig`, which also differs, because a constant
 * getter cannot be confused for anything: it has no arguments to get wrong and
 * its absence is unambiguous, where a struct returning fewer words than
 * expected surfaces as a decoding error somewhere inside viem.
 */
export const GENERATION_PROBE = {
  abi: FOLIO_FACTORY_ABI,
  functionName: "MAX_SNIPER_WINDOW_SECONDS",
} as const;

/** What a launch's `TokenCreated` says, whichever generation emitted it. */
export type CreatedToken = { token: `0x${string}`; totalSupply: bigint };

/**
 * The launch in a set of logs, read with whichever ABI matches.
 *
 * The two events share their first five members and differ only in the config
 * tuple at the end, so both decode to the two fields anybody here wants. Tried
 * newest-first — a redeployed factory is the case that should cost nothing —
 * and `parseEventLogs` simply finds nothing when the topic does not match,
 * which is what makes trying both safe rather than a guess.
 */
export function findTokenCreated(logs: Log[], factory: string): CreatedToken | null {
  const from = factory.toLowerCase();

  for (const abi of [FOLIO_FACTORY_ABI, LEGACY_FOLIO_FACTORY_ABI]) {
    const found = parseEventLogs({ abi, eventName: "TokenCreated", logs }).find(
      (log) => log.address.toLowerCase() === from
    );
    if (found) {
      const args = found.args as unknown as CreatedToken;
      return { token: args.token, totalSupply: args.totalSupply };
    }
  }

  return null;
}
