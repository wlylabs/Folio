# Folio — Testnet Token Launchpad

Every token launch is published as an article. Built with Next.js, wagmi/RainbowKit, Supabase.

## Status

Launches are real. Publishing deploys `contracts/FolioSale.sol` — an ERC20 that
runs its own fixed-price sale — to a testnet from your wallet, and the article
page reads sale progress straight off the chain. Holders can buy and sell back
against that contract; there is no external liquidity pool involved.

Still a testnet project, and one thing is worth knowing before you rely on it:
`creator_wallet` is a **claim, not a proof**. The browser talks to Supabase with
the public anon key, which carries no wallet identity, so anyone could insert a
row attributing a launch to someone else's address. Verifying authorship needs
signature-based auth (Sign-In With Ethereum minting a Supabase JWT), which isn't
implemented here. Row-level security in `lib/schema.sql` blocks client-side
updates and deletes, so existing listings can't be tampered with.

## Setup (from your phone, via GitHub Codespaces)

1. Push this folder to a new GitHub repo (see steps below).
2. Open the repo on github.com → green **Code** button → **Codespaces** tab → **Create codespace on main**.
   This opens a full VS Code + terminal in your browser, works fine on mobile.
3. In the Codespaces terminal:
   ```
   npm install
   cp .env.example .env.local
   ```
4. Fill `.env.local` (see `.env.example` for every variable):
   - Supabase: create a free project at supabase.com → Project Settings → API → copy URL + anon key
   - WalletConnect: create a free project at cloud.walletconnect.com → copy Project ID
5. Run `lib/schema.sql` in Supabase's SQL editor. It creates the `tokens` table,
   the avatar storage bucket, and the row-level security policies.
6. `npm run dev` → Codespaces gives you a forwarded URL to preview in browser.
7. Get testnet ETH from a Base Sepolia faucet — deploying costs gas.

The app boots without `.env.local` and shows a setup notice instead of crashing,
so you can check the UI before wiring up Supabase.

## Deploy to Vercel (no CLI needed)

1. vercel.com → **Add New Project** → import your GitHub repo.
2. Paste the same env vars from `.env.local` into Vercel's Environment Variables settings.
3. Deploy. Done — you get a live `.vercel.app` URL.

## Getting test ETH

Every step here — deploying, buying, selling — is a real transaction and costs
gas, so a wallet with a zero balance can't do anything. Both the launch form and
the trade bar read the connected balance on the target chain and print faucet
links for that chain the moment it's empty, rather than letting the wallet fail
with "insufficient funds". The links live in `SUPPORTED_CHAINS` in
`lib/chains.ts`; add a chain there and its faucets travel with it.

## How a launch works

1. **Validate** the form client-side (name, symbol, supply, price, headline),
   and check the wallet actually has gas on the target chain.
2. **Upload** the optional avatar to Supabase Storage.
3. **Switch** the wallet to the target chain, then **deploy** `FolioSale` with
   your name, symbol, supply, price and address as the proceeds recipient.
4. **Wait** for the receipt and take the real contract address from it.
5. **Insert** the article row keyed to that address, and redirect to it.

If the deploy succeeds but the database insert fails, the error message includes
the deployed address so the contract isn't lost.

## How trading works

The trade bar on an article page has a buy leg and a sell leg, both settling
against the launch's own contract at a fixed price:

- **Buy** sends ETH to `buy()` and receives tokens out of the contract's
  inventory at `price`.
- **Sell** returns tokens to `sell()` and receives ETH at `sellPrice()`, which
  is `price` minus a 5% spread. The tokens go back into inventory, so a
  sold-out launch reopens when someone sells back into it.

Both legs read the wallet's balances first, so the button can say *why* it is
disabled — no test ETH, no tokens to sell — before anything is signed. On
confirmation the page revalidates, so the sale figures update in place.

The 5% spread is what the creator earns. It also means the contract cannot pay
every holder out *and* hand the creator the whole balance, so `withdraw()` only
releases what is above `reserveRequired()` — the ETH needed to buy back every
circulating token. A holder can therefore always sell, which is the property
that makes the sell button worth trusting. The reserve is printed on the article
page next to the price.

Launches deployed before the buyback existed have no `sellPrice()` to read.
`fetchSaleStats` treats that failed read as "no buyback", and the sell tab says
so instead of offering a button that would always revert.

## The contract

`contracts/FolioSale.sol` is a dependency-free ERC20 plus fixed-price sale with a
buyback. The whole supply is minted to the contract itself as sale inventory, so
`sold()` and `balanceOf(contract)` always reconcile and the frontend can read
progress without indexing events or running a cron.

`buy()` caps a purchase at the remaining inventory and refunds the difference,
so overpaying on a nearly-sold-out launch never overcharges. Proceeds stay in
the contract for the creator to `withdraw()` rather than being pushed on each
sale, so a buyer's transaction can't be griefed by a reverting recipient.

`sell()` is the reverse leg. It floors each payout while the reserve is computed
over the whole position, so the reserve is always sufficient — a sum of floors
never exceeds the floor of the sum. Both legs settle state before their external
call, so neither can be re-entered against a stale balance, and `withdraw()`
derives its amount from the live balance, which the value transfer has already
debited by the time a reentrant frame runs.

A price under 2 wei would floor `sellPrice()` to zero and mint tokens nobody
could sell, so the constructor rejects it.

```
npm run compile:contracts   # regenerate lib/contracts/folioSale.ts (needs solc)
npm test                    # run the sale against an in-memory EVM
```

The compiled ABI and bytecode are committed, so builds and deploys never need a
Solidity compiler — only edits to the `.sol` file do.

## Notes

- **Sale figures come from the chain.** `tokens.sold_amount` is only a fallback
  for rows whose contract can't be reached, since nothing on chain writes back
  to Postgres.
- **Article HTML is sanitized on render** (`lib/sanitize.ts`) with an allowlist
  matching Tiptap's output. Stored bodies are untrusted — they arrive through
  the public anon key.
- **Addresses are stored lowercased** so URL lookups are case-insensitive.

## Possible next steps

- [ ] Sign-In With Ethereum so `creator_wallet` is verified rather than claimed
- [ ] A creator-side withdraw button — `withdraw()` is live on the contract but
      has no UI, so the spread has to be claimed by hand for now
- [ ] Mainnet support, which needs a real audit of the sale contract first
- [ ] Richer editor (images inside articles, embeds) with the allowlist widened to match
