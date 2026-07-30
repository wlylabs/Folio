import { supabase } from "@/lib/supabaseClient";
import { notFound } from "next/navigation";
import BuyBar from "@/components/BuyBar";

async function getToken(address: string) {
  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .eq("contract_address", address)
    .single();
  if (error || !data) return null;
  return data;
}

export default async function TokenPage({
  params,
}: {
  params: { address: string };
}) {
  const token = await getToken(params.address);
  if (!token) return notFound();

  const sold =
    token.sold_amount && token.supply
      ? ((token.sold_amount / token.supply) * 100).toFixed(1)
      : "0.0";

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", paddingBottom: 120 }}>
      <div style={{ padding: "16px 20px 0" }}>
        <div className="font-ui" style={{ fontSize: 9.5, letterSpacing: 2, color: "var(--ink-soft)" }}>
          {token.chain.toUpperCase()} · TOKEN FEATURE
        </div>
        <h1 className="font-display" style={{ fontWeight: 900, fontSize: 30, lineHeight: 1.15, margin: "10px 0" }}>
          {token.article_title}
        </h1>

        <div
          className="font-ui"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 0",
            borderTop: "1px solid var(--ink)",
            borderBottom: "1px solid var(--rule)",
            marginBottom: 16,
            fontSize: 10,
            color: "var(--ink-soft)",
          }}
        >
          <span>
            by <b style={{ color: "var(--ink)" }}>{token.creator_wallet.slice(0, 6)}...{token.creator_wallet.slice(-4)}</b>
          </span>
          <span>· {new Date(token.created_at).toLocaleDateString()}</span>
        </div>

        <div
          style={{ fontSize: 15.5, lineHeight: 1.75 }}
          dangerouslySetInnerHTML={{ __html: token.article_body }}
        />

        <div style={{ margin: "22px 0", border: "1px solid var(--ink)" }}>
          <div
            className="font-ui"
            style={{
              fontSize: 9.5,
              letterSpacing: 2,
              background: "var(--ink)",
              color: "var(--paper)",
              padding: "8px 12px",
            }}
          >
            CONTRACT DATA · TESTNET
          </div>
          {[
            ["Contract", `${token.contract_address.slice(0, 6)}...${token.contract_address.slice(-4)}`],
            ["Symbol", `$${token.symbol}`],
            ["Total supply", token.supply.toLocaleString()],
            ["Sold", `${sold}%`],
          ].map(([label, value]) => (
            <div
              key={label}
              className="font-ui"
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "9px 12px",
                borderBottom: "1px solid var(--rule)",
                fontSize: 11.5,
              }}
            >
              <span style={{ color: "var(--ink-soft)" }}>{label}</span>
              <span style={{ fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      <BuyBar token={token} />
    </main>
  );
}
