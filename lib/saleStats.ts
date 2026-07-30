import { formatUnits } from "viem";
import { FOLIO_SALE_ABI } from "@/lib/contracts/folioSale";
import { publicClientFor } from "@/lib/chains";
import { percentSold, type SaleStats, type Token } from "@/lib/types";

/**
 * Read live sale figures straight off the contract.
 *
 * The `tokens.sold_amount` column can only ever be stale — nothing on chain
 * writes back to Postgres — so the chain is the source of truth and the stored
 * values are the fallback. Rows created before real deployment existed have a
 * placeholder address with no contract behind it; those reads fail and we fall
 * back rather than blowing up the page.
 */
export async function fetchSaleStats(token: Token): Promise<SaleStats> {
  const fallback: SaleStats = {
    sold: Number(token.sold_amount ?? 0),
    supply: Number(token.supply ?? 0),
    percentSold: percentSold(Number(token.sold_amount ?? 0), Number(token.supply ?? 0)),
    onChain: false,
  };

  const client = publicClientFor(token.chain);
  if (!client) return fallback;

  try {
    const contract = {
      address: token.contract_address as `0x${string}`,
      abi: FOLIO_SALE_ABI,
    } as const;

    const [sold, totalSupply, decimals] = await Promise.all([
      client.readContract({ ...contract, functionName: "sold" }),
      client.readContract({ ...contract, functionName: "totalSupply" }),
      client.readContract({ ...contract, functionName: "decimals" }),
    ]);

    const soldWhole = Number(formatUnits(sold, decimals));
    const supplyWhole = Number(formatUnits(totalSupply, decimals));

    return {
      sold: soldWhole,
      supply: supplyWhole,
      percentSold: percentSold(soldWhole, supplyWhole),
      onChain: true,
    };
  } catch {
    // Placeholder address, unreachable RPC, or a contract that isn't a
    // FolioSale. Show the stored numbers instead.
    return fallback;
  }
}
