# Folio — Testnet Token Launchpad

Every token launch is published as an article. Built with Next.js, wagmi/RainbowKit, Supabase.

## Status

Launches are real. Publishing calls `createToken` on `FolioFactory`, which
clones a `FolioToken` — an ERC20 that is also its own bonding-curve market maker
— and the article page prices every trade off that curve live. Holders buy from
and sell back to the curve; there is no external liquidity pool involved.

The factory is deployed once per network and its address lives in
`deployments/base-sepolia.json`, written by `contracts/script/DeployFactory.s.sol`.
`lib/contracts/deployment.ts` is the only module that reads it, so re-deploying
is a one-file change.

Still a testnet project, and one thing is worth knowing before you rely on it:
`creator_wallet` is a **claim, not a proof**. The browser talks to Supabase with
the public anon key, which carries no wallet identity, so anyone could insert a
row attributing a launch to someone else's address. Verifying authorship needs
signature-based auth (Sign-In With Ethereum minting a Supabase JWT), which isn't
implemented here. Row-level security in `lib/schema.sql` blocks client-side
updates and deletes, so existing listings can't be tampered with.

`TERMS.md` and `PRIVACY.md` hold draft policies covering the testnet stage, and
`/terms` and `/privacy` render those two files directly — the markdown at the
repo root is the only copy. Both are unreviewed drafts, so both pages carry a
"Draft — pending legal review" badge; clearing `draft` in `lib/legal.ts`
removes it. Governing law in the terms is still a placeholder — it depends on
where the operator is domiciled — and a lawyer has to look at both documents
before this runs against real value or real users.

One gap worth knowing about, because the privacy policy implies otherwise: the
consent banner gates Folio's own analytics, and there are none yet, but
WalletConnect pings `pulse.walletconnect.org` on page load regardless. It comes
from the Reown AppKit modal that `@walletconnect/ethereum-provider` builds
during provider init, which hardcodes its own options — see the note in
`lib/wagmiConfig.ts` for the two ways out. Until one of them is taken, a
third-party request does happen before the reader has answered the banner.

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
   - WalletConnect: create a free project at cloud.walletconnect.com → copy Project ID.
     Required for phone wallets — they reach the site over WalletConnect's relay,
     which rejects an unknown project ID. Without it the settings panel says so,
     and only browser-extension wallets can connect.
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

1. **Validate** the form client-side (name, symbol, supply, optional reserve
   cap, headline), and check the wallet actually has gas on the target chain.
2. **Upload** the optional avatar to Supabase Storage.
3. **Switch** the wallet to the factory's chain, then call
   `factory.createToken(name, symbol, supply, maxReserveCap)`.
4. **Wait** for the receipt and read the new token's address out of the
   `TokenCreated` event — never computed, never assumed.
5. **Insert** the article row keyed to that address, and redirect to it.

Supply defaults to 1,000,000,000, the memecoin convention, and is editable. It
doesn't change what a launch opens at: the whole supply sits on the curve, so
the opening market cap is `virtualEthReserve` whatever supply you pick.

If the token is created but the database insert fails, the error message
includes the address so the launch isn't lost — and `/api/indexer` will list it
from the event log regardless.

## Taking a listing down

A launch is two things: a contract on chain and a listing in Postgres. Only the
second can be removed, and `scripts/delete-token.mjs` is what removes it.

```
npm run token:list                                   # what is published
npm run token:delete -- 0xabc… --reason "test launch"
npm run token:delete -- 0xabc… --restore             # undo the delisting
```

It deletes the row — article, headline, byline, and the avatar in Storage — and
leaves the token itself untouched. The curve keeps quoting and holders can still
sell back through the contract; what goes is the article, the card in the feed
and the `/token/<address>` page.

Deleting the row is not enough on its own. `/api/indexer` rebuilds listings from
the factory's `TokenCreated` log, and that log is permanent, so a plain `delete
from tokens` reappears on the next run. Every deletion therefore writes a
tombstone into `delisted_tokens`, which the indexer reads and skips — so
**re-run `lib/schema.sql`** before deleting anything, or the script will refuse
rather than delete something that would come straight back.

The script needs `SUPABASE_SERVICE_ROLE_KEY`, because the public policies allow
reads and inserts and nothing else: a delete the anon key could perform is a
delete anyone on the internet could perform.

`--restore` only drops the tombstone. The row is gone for good — the article
went with it — and the next indexer run relists the launch from its event log
with a placeholder article.

## How trading works

The trade bar on an article page has a buy leg and a sell leg, both settling
against the launch's own curve:

- **Buy** sends ETH to `buy(minTokensOut)`. The quote under the field is
  `getBuyQuote(ethIn)` — the same code path `buy` runs — re-read on every change
  to the amount and on a timer while the panel is open.
- **Sell** returns tokens to `sell(amount, minEthOut)` at `getSellPrice(amount)`.
  Tokens are burned and the curve retraces the path a buy of that size took.
  Selling is never closed except by the platform emergency stop.

There is no fixed price to display, so nothing is displayed as fixed. Both legs
carry a **slippage tolerance** (1% by default) which becomes the `minTokensOut`
/ `minEthOut` floor on chain: if the price moves between the quote and the block,
the trade reverts instead of filling at whatever a sandwich left behind.

Both legs read the wallet's balances and the live curve state first, so the
button can say *why* it is disabled — no test ETH, no tokens to sell, curve
graduated, trading paused — before anything is signed.

**Paused** is its own state and says so plainly. The factory's emergency stop
halts buying *and* selling on every launch; the panel disables both and explains
that holdings are untouched and creator fees are still claimable.

The **reserve** is printed beside the buttons: the real ETH backing the curve,
against its cap, with the headroom left before buys close. `reserveHealthBps` on
the article page states the same thing as a ratio — 100% means every token in
circulation can be sold back right now.

Launches from the retired fixed-price design still work. `lib/tokenStats.ts`
discovers which contract is at an address by reading it, and the page renders the
panel that describes it honestly rather than one that would revert.

## The contracts

`contracts/src/FolioFactory.sol` deploys launches as EIP-1167 minimal proxies —
~41k gas each instead of ~1.5M for a full ERC20 — over one shared
`FolioToken` implementation its own constructor deploys. It holds the platform's
default curve terms and the single emergency stop, both bounded by hard
constants that fence the owner as much as anyone else.

`contracts/src/FolioToken.sol` is the ERC20 and the market maker. Constant
product, `x * y = k`, with a virtual ETH reserve giving the curve a finite
opening price. Fees are taken outside the curve, so the reserve never subsidises
them and the sell-back guarantee stays exact. See `contracts/README.md` for the
full design and `DEPLOYMENT.md` for deploying it.

`contracts/FolioSale.sol` is the retired design, kept because listings created
under it are still live.

```
npm run compile:contracts   # regenerate lib/contracts/*.ts from the .sol files
npm run forge:test          # the contract test suite
npm run watch:launches      # index TokenCreated events as they land
```

The compiled ABIs are committed, so builds and deploys never need a Solidity
compiler — only edits to a `.sol` file do.

## Notes

- **Curve figures come from the chain.** `tokens.sold_amount` and
  `tokens.starting_price` are fallbacks for rows whose contract can't be
  reached, since nothing on chain writes back to Postgres. The database stores
  the article; the contract stores the market.
- **New listings are indexed from the event log.** The create page writes its
  own row, and `/api/indexer` reconciles anything created outside it — a Foundry
  script, Basescan, or a browser that closed at the wrong moment. Pages read the
  table; they never scan the chain for the feed.
- **ETH figures carry a fiat estimate.** Every price on the site is quoted in
  ETH by a contract; a quieter line under it says what that is worth in USD or
  IDR, at the reader's choice (remembered in `localStorage`, guessed from the
  browser's locale the first time). The rate comes from `/api/eth-price`, which
  caches CoinGecko server-side for a minute. It is display only — no trade, no
  floor and no stored value is ever computed from it — and it disappears
  entirely when the price feed is unreachable, leaving the ETH untouched.
- **Article HTML is sanitized on render** (`lib/sanitize.ts`) with an allowlist
  matching Tiptap's output. Stored bodies are untrusted — they arrive through
  the public anon key.
- **Addresses are stored lowercased** so URL lookups are case-insensitive.
- **The front page explains itself below the feed.** How a launch works, the
  curve terms the factory would hand the next one (read from
  `deployments/base-sepolia.json`, never written into the copy), and what a
  testnet edition does and doesn't promise. Those sections are not conditional
  on the feed being empty — an edition with one listing needs them as much as an
  edition with none.

## Possible next steps

- [ ] Sign-In With Ethereum so `creator_wallet` is verified rather than claimed
- [ ] A creator-side fee claim button — `claimFees()` is live on the token but
      has no UI, so fees have to be claimed from Basescan for now
- [ ] A price chart from the `TokensBought` / `TokensSold` log, which is the
      thing a curve most obviously wants and the event stream already supports
- [ ] Graduation handling beyond closing the curve — the contract emits
      `Graduated` and stops there on purpose; migrating that liquidity to a DEX
      is an off-chain decision nobody has made yet
- [ ] Mainnet support, which needs a real audit first
- [ ] Richer editor (images inside articles, embeds) with the allowlist widened to match
