/**
 * Turns a wallet, RPC or contract failure into something a person can act on.
 *
 * Three things can go wrong when a page sends a transaction, and they are not
 * the same event:
 *
 *   cancelled — the user declined in their wallet. Nothing failed. Saying
 *               "error" here is a lie that makes a launchpad feel broken.
 *   reverted  — the chain refused the transaction, for a reason the contract
 *               named. That name is the useful part, and it is what gets
 *               translated below.
 *   network   — the RPC never answered, or answered with nonsense. Retrying is
 *               a reasonable thing to suggest; changing the amount is not.
 *
 * {classifyTxError} keeps that distinction so callers can style and act on it —
 * a cancellation clears the status line rather than painting it red.
 *
 * Matching is on the error *name* inside the message rather than the message
 * shape, because viem wraps its errors several layers deep by the time one
 * reaches a component, and the name is the part that survives.
 */

import { DEFAULT_CHAIN_SLUG, chainBySlug } from "@/lib/chains";

/**
 * The network to name in a wrong-chain message.
 *
 * Read from the chain registry rather than written out, because this used to
 * spell a network name that stopped being true the moment the chain list
 * changed — and a message telling a reader to switch to a network Folio no
 * longer supports is worse than one that says nothing.
 */
const TARGET_NETWORK = chainBySlug(DEFAULT_CHAIN_SLUG)?.chain.name ?? "the right network";

export type TxErrorKind = "cancelled" | "reverted" | "network" | "unknown";

export type TxError = {
  kind: TxErrorKind;
  /** One sentence, written for the person who hit it. */
  message: string;
  /** The Solidity error or wallet code this was recognised by, when it was. */
  reason?: string;
};

/** Every custom error the current contracts can revert with, in the words of
 *  someone who has to decide what to do next. */
const REVERTS: [RegExp, string, string][] = [
  // --- curve trading (FolioToken) ---
  [
    /SlippageExceeded/,
    "SlippageExceeded",
    "The price moved past your slippage tolerance before the trade landed. Raise the tolerance or try again.",
  ],
  [
    /CurveClosed/,
    "CurveClosed",
    "This curve is closed to buys — it either graduated or hit its ETH ceiling. You can still sell.",
  ],
  [
    /TradingPaused/,
    "TradingPaused",
    "Trading is halted by the platform's emergency stop. Buying and selling are both disabled until it is released.",
  ],
  [/ZeroEthIn/, "ZeroEthIn", "Enter an amount of ETH above zero."],
  [/ZeroTokenAmount/, "ZeroTokenAmount", "Enter an amount above zero."],
  [
    /PaymentTooSmall/,
    "PaymentTooSmall",
    "That amount is too small to buy a single token at the current price. Try a larger amount.",
  ],
  [
    /PayoutTooSmall/,
    "PayoutTooSmall",
    "That amount is too small to pay out anything. Try selling more.",
  ],
  [
    /ExceedsCurveInventory/,
    "ExceedsCurveInventory",
    "That's more than the curve has left to issue.",
  ],
  [
    /ExceedsCirculating/,
    "ExceedsCirculating",
    "That's more than the curve ever issued, so it can't be sold back.",
  ],
  [
    /ReserveShortfall/,
    "ReserveShortfall",
    "The reserve can't cover that payout right now. Try a smaller amount.",
  ],
  [
    /ERC20InsufficientBalance|InsufficientBalance/,
    "ERC20InsufficientBalance",
    "You don't hold that many tokens.",
  ],
  [/NotCreator/, "NotCreator", "Only the launch's creator can do that."],
  [/NothingToClaim/, "NothingToClaim", "There are no fees to claim yet."],
  [
    /EthTransferFailed/,
    "EthTransferFailed",
    "The ETH transfer out of the contract failed. If you're using a contract wallet, it may be rejecting the payment.",
  ],

  // --- launching (FolioFactory) ---
  [/EmptyName/, "EmptyName", "Give your token a name."],
  [/EmptySymbol/, "EmptySymbol", "A symbol is required."],
  [/NameTooLong/, "NameTooLong", "Keep the name under 64 characters."],
  [/SymbolTooLong/, "SymbolTooLong", "Keep the symbol under 16 characters."],
  [
    /SupplyTooLargeForCurve/,
    "SupplyTooLargeForCurve",
    "That supply is too large for the platform's curve — the opening price would round to zero. Choose a smaller supply.",
  ],
  [/InvalidSupply/, "InvalidSupply", "Supply must be a whole number above zero."],
  [
    /ReserveCapTooLow/,
    "ReserveCapTooLow",
    "That reserve cap is below the platform minimum of 0.001 ETH.",
  ],
  [
    /ReserveCapAboveDefault/,
    "ReserveCapAboveDefault",
    "A launch's reserve cap can only be tightened below the platform default, never raised above it.",
  ],
  [
    /EnforcedPause/,
    "EnforcedPause",
    "New launches are paused platform-wide right now. Try again once the emergency stop is released.",
  ],
  [
    /InvalidInitialization|AlreadyInitialized/,
    "InvalidInitialization",
    "That launch has already been set up.",
  ],

  // --- retired FolioSale listings ---
  [/SoldOut/, "SoldOut", "This sale is sold out."],
  [/NothingToSell/, "NothingToSell", "Enter an amount above zero."],
  [/InvalidPrice/, "InvalidPrice", "That price is too low to run a buyback."],
  [/InvalidCreator/, "InvalidCreator", "The proceeds address is invalid."],
];

export function classifyTxError(err: unknown): TxError {
  const message = err instanceof Error ? err.message : String(err);

  // --- the user said no. Not a failure. ---
  if (
    /User rejected|User denied|rejected the request|UserRejectedRequest|ACTION_REJECTED/i.test(
      message
    )
  ) {
    return { kind: "cancelled", message: "Transaction cancelled.", reason: "UserRejected" };
  }

  // --- their wallet can't pay for it ---
  if (/insufficient funds/i.test(message)) {
    return {
      kind: "reverted",
      reason: "InsufficientFunds",
      message: "Not enough ETH in your wallet to cover this plus gas. Fund it and try again.",
    };
  }

  // wagmi's wording for a session it can't sign with — a stored connection it
  // hasn't revived, or one the wallet has since dropped. Reaching a user, it
  // reads as a bug in the page rather than something they can fix.
  if (/Connector not connected|Connector unavailable while reconnecting/i.test(message)) {
    return {
      kind: "network",
      reason: "ConnectorUnavailable",
      message: "Your wallet session dropped. Reconnect your wallet, then try again.",
    };
  }

  if (/ChainMismatch|chain of the connected wallet|does not match the target chain/i.test(message)) {
    return {
      kind: "network",
      reason: "ChainMismatch",
      message: `Your wallet is on a different network. Switch it to ${TARGET_NETWORK} and try again.`,
    };
  }

  // --- a named revert ---
  for (const [pattern, reason, text] of REVERTS) {
    if (pattern.test(message)) return { kind: "reverted", reason, message: text };
  }

  // A listing whose contract_address has no contract behind it, or a call to a
  // selector this contract doesn't have.
  if (/returned no data|does not exist|is not a contract/i.test(message)) {
    return {
      kind: "reverted",
      reason: "NoContract",
      message: "This contract doesn't support that action.",
    };
  }

  // --- the network, not the transaction ---
  if (
    /HttpRequestError|TimeoutError|timed out|fetch failed|Failed to fetch|NetworkError|ECONNRESET|503|502|429|rate limit|Internal error|InternalRpcError/i.test(
      message
    )
  ) {
    return {
      kind: "network",
      reason: "RpcError",
      message:
        "The network didn't respond. Nothing was sent — check your connection and try again.",
    };
  }

  if (/replacement transaction underpriced|nonce too low|already known/i.test(message)) {
    return {
      kind: "network",
      reason: "NonceConflict",
      message: "Your wallet has another transaction in flight. Wait for it to confirm, then retry.",
    };
  }

  // Some wallets surface a plain revert with no name attached.
  if (/reverted|execution reverted/i.test(message)) {
    return {
      kind: "reverted",
      message:
        "The chain rejected this transaction. Re-check the amount — the price may have moved since you were quoted.",
    };
  }

  return {
    kind: "unknown",
    message: message.split("\n")[0] || "Something went wrong. Check the console.",
  };
}

/** The sentence alone, for callers that don't care which kind it was. */
export function describeTxError(err: unknown): string {
  return classifyTxError(err).message;
}
