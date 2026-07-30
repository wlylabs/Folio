# Folio — Testnet Token Launchpad

Every token launch is published as an article. Built with Next.js, wagmi/RainbowKit, Supabase.

## Status
This is a **starter scaffold**, not production-ready. The `handleSubmit` in
`app/create/page.tsx` currently saves a **fake contract address** — real
on-chain deployment (ERC20 + sale contract) still needs to be wired in.
Everything else (feed, article page, wallet connect, buy button UI) works.

## Setup (from your phone, via GitHub Codespaces)

1. Push this folder to a new GitHub repo (see steps below).
2. Open the repo on github.com → green **Code** button → **Codespaces** tab → **Create codespace on main**.
   This opens a full VS Code + terminal in your browser, works fine on mobile.
3. In the Codespaces terminal:
   ```
   npm install
   cp .env.example .env.local
   ```
4. Fill `.env.local`:
   - Supabase: create a free project at supabase.com → Project Settings → API → copy URL + anon key
   - Run the SQL in `lib/supabaseClient.ts` (bottom comment) in Supabase's SQL editor to create the `tokens` table
   - WalletConnect: create a free project at cloud.walletconnect.com → copy Project ID
5. `npm run dev` → Codespaces gives you a forwarded URL to preview in browser.

## Deploy to Vercel (no CLI needed)
1. vercel.com → **Add New Project** → import your GitHub repo.
2. Paste the same env vars from `.env.local` into Vercel's Environment Variables settings.
3. Deploy. Done — you get a live `.vercel.app` URL.

## Next steps (not yet built)
- [ ] Real contract deployment on create (recommend: Thirdweb SDK — no need to write Solidity by hand)
- [ ] Actual `buy()` function matching your sale contract's real ABI
- [ ] Image upload for token avatar (Supabase Storage, free tier)
- [ ] `sold_amount` tracking (read from chain events or index via a cron)
