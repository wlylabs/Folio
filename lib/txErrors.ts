/**
 * Turns a wallet or RPC failure into a sentence a user can act on.
 *
 * viem's errors are several paragraphs of request detail with the useful part —
 * a custom error name from FolioSale, or a wallet rejection — buried inside, and
 * printing that raw is what makes a launchpad feel broken. Matching on the name
 * is deliberate: it survives the error being wrapped, which it always is by the
 * time it reaches a component.
 */
export function describeTxError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/User rejected|User denied|rejected the request/i.test(message)) {
    return "Transaction cancelled.";
  }
  if (/insufficient funds/i.test(message)) {
    return "Not enough ETH in your wallet to cover this plus gas. Top up from a faucet.";
  }

  // --- sale ---
  if (/SoldOut/.test(message)) return "This sale is sold out.";
  if (/PaymentTooSmall/.test(message)) return "That amount is too small to buy any tokens.";

  // --- buyback ---
  if (/NothingToSell/.test(message)) return "Enter an amount above zero.";
  if (/PayoutTooSmall/.test(message)) return "That amount is too small to pay out anything.";
  if (/InsufficientBalance/.test(message)) return "You don't hold that many tokens.";
  if (/ExceedsCirculating/.test(message)) {
    return "That's more than the sale ever sold, so it can't be bought back.";
  }
  if (/ReserveShortfall/.test(message)) {
    return "The sale can't cover that buyback right now. Try a smaller amount.";
  }

  // --- deploy ---
  if (/InvalidSupply/.test(message)) return "Supply must be greater than zero.";
  if (/InvalidPrice/.test(message)) {
    return "That price is too low to run a buyback. Use at least 0.000000000000000002 ETH.";
  }
  if (/InvalidCreator/.test(message)) return "The proceeds address is invalid.";

  // A listing whose contract_address has no contract behind it, or a launch
  // deployed before sell() existed, where the selector simply isn't there.
  if (/returned no data|does not exist|is not a contract/i.test(message)) {
    return "This contract doesn't support that action.";
  }

  return message.split("\n")[0] || "Something went wrong. Check the console.";
}
