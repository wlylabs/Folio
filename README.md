# Folio — Token Launchpad

Every token launch is published as an article. Built with Next.js,
wagmi/RainbowKit, Supabase.

## Status

Launches are real. Publishing calls `createToken` on `FolioFactory`, which
clones a `FolioToken` — an ERC20 that is also its own bonding-curve market maker
— and the article page prices every trade off that curve live. Holders buy from
and sell back to the curve; there is no external liquidity pool involved.

The factory is deployed once per network, and each network's address lives in
its own `deployments/<chain>.json`, written by
`contracts/script/DeployFactory.s.sol`. `lib/contracts/deployment.ts` is the
only module that reads them, so re-deploying is a one-file change and adding a
network is one record plus an entry in `SUPPORTED_CHAINS` (`lib/chains.ts`).

The one supported network is **Robinhood Chain** (4663, mainnet, real ETH).
Folio used to run Base Sepolia alongside it as a testnet to rehearse on; that
network is gone — its chain entry, deployment record, deploy workflow, RPC
alias and every faucet link with it — so there is no free-ETH mode and nothing
on the site is a rehearsal. The machinery stayed multi-chain: every listing
stores the chain it was launched on, so a token page reads, prices and trades
against the network it actually lives on rather than a global default, and the
create form asks which network to launch on if a second one ever has a factory.

The network is printed on the listing, in the trade panel and in the deploy
script's confirmation banner. `deployments/robinhood-mainnet.json` ships with an
empty `factory`, so nothing launches until a deploy fills it in — see
[DEPLOYMENT.md](DEPLOYMENT.md) section 3.

One thing is worth knowing before you rely on any of it: `creator_wallet` is a
claim **unless the listing says otherwise**. The browser talks to Supabase with
the public anon key, which carries no wallet identity, so a row inserted with it
could attribute a launch to anyone's address — and rows written that way are
stamped `creator_verified = false` and render as "Unverified byline".

Publishing through the site proves it instead, where the deploy has
`SUPABASE_JWT_SECRET` set. The wallet signs an EIP-4361 message naming this
site, this address and a server-issued nonce — free, no transaction, no gas —
`/api/auth/verify` checks it and mints a Supabase JWT carrying the address, and
the insert policy in `lib/schema.sql` refuses any row whose `creator_wallet` is
not that address. The comparison happens in Postgres, so no component can skip
it, and the listing reads "Verified" beside the byline. See **Proving a byline**
below. Row-level security also blocks client-side updates and deletes, so
existing listings can't be tampered with either way.

Powers that move money are still not decided from any of this: `claimFees` and
the migration prompt read `creator()` off the contract, because a database row —
verified or not — is the wrong authority for a payout.

**A factory older than this checkout still works.** `CurveConfig` grew three
fields when the opening window and migration arrived, which changed
`createToken`'s widest selector and `TokenCreated`'s topic — so a site built
from this repository could not launch on, or index, a factory deployed before
that. It reads the factory instead of assuming: `lib/contracts/folioFactoryLegacy.ts`
carries the older shapes, the create form offers the opening-window fields only
where the factory has them, and the indexer and the watcher filter on both
topics. See **Two generations of factory** below.

`TERMS.md` and `PRIVACY.md` hold draft policies, and `/terms` and `/privacy`
render those two files directly — the markdown at the repo root is the only
copy. Both are unreviewed drafts, so both pages carry a "Draft — pending legal
review" badge; clearing `draft` in `lib/legal.ts` removes it. Governing law in
the terms is still a placeholder — it depends on where the operator is
domiciled. The terms now describe the mainnet network rather than promising
testnet-only, but that is a factual correction, not a review: a lawyer has to
look at both documents before this is operated against real value or real users.

The consent banner gates Folio's own analytics, and there are none yet.
WalletConnect used to ping `pulse.walletconnect.org` on page load regardless —
the ping comes from the Reown AppKit modal that
`@walletconnect/ethereum-provider` builds during provider init, and that modal
hardcodes its own options, so there is no flag that silences it. The way out
taken here is the third one: the provider is not built on page load at all.
Nothing in the wallet layer is constructed until the reader shows an interest in
connecting one, so a reader who only reads never reaches any third-party request
— see `lib/walletBoot.ts`. A reader who does head for the settings panel
releases the connectors then, which is after the banner has had its chance.

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
7. Fund the wallet on Robinhood Chain — deploying costs gas. It is a mainnet
   and has no faucet, so that ETH has to be bridged or bought. To develop
   without spending anything, fork the chain locally (`anvil --fork-url ...`,
   which keeps chain id 4663) and point the scripts at it.

The app boots without `.env.local` and shows a setup notice instead of crashing,
so you can check the UI before wiring up Supabase.

## Deploy to Vercel (no CLI needed)

1. vercel.com → **Add New Project** → import your GitHub repo.
2. Paste the same env vars from `.env.local` into Vercel's Environment Variables settings.
3. Deploy. Done — you get a live `.vercel.app` URL.

## Gas

Every step here — deploying, buying, selling — is a real transaction on a
mainnet and costs real ETH, so a wallet with a zero balance can't do anything.
Both the launch form and the trade bar read the connected balance on the target
chain and say so the moment it's empty, naming the network the ETH has to be on,
rather than letting the wallet fail with "insufficient funds".

There are no faucet links anywhere in the app, and there should not be: gas here
is bought or bridged, and anything offering to give it away is not a faucet.

## How a launch works

1. **Validate** the form client-side (name, symbol, supply, optional reserve
   cap, headline), and check the wallet actually has gas on the target chain.
2. **Upload** the optional avatar to Supabase Storage.
3. **Switch** the wallet to the chosen network's factory chain, then call
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

### Clearing out the testnet rows

Folio rehearsed on Base Sepolia, and on a Robinhood testnet before that. The
listings those launches wrote are still in `tokens`, and their `chain` slug no
longer resolves to anything — no explorer link, no RPC to read the curve from,
and a network label that falls back to "Unsupported network".

```
npm run token:prune-testnet -- --dry-run    # what would go
npm run token:prune-testnet
```

Retired is defined by the code rather than a list in the script: it reads
`SUPPORTED_CHAINS` from `lib/chains.ts` and deletes every row whose chain is not
in it, avatars included. Nothing is hardcoded, so putting a chain back in that
list takes its rows out of range. If that array can't be parsed the script stops
instead of guessing, because "no chain is supported" and "every row is retired"
are the same sentence to it.

It writes no tombstones, and that is the difference from `token:delete`. A
tombstone stops `/api/indexer` putting a row back, and the indexer only scans
chains that have a `deployments/<slug>.json` record — a retired chain has none,
so nothing is watching and nothing will relist. Pass `--chain <slug>` to prune
one retired network at a time; naming a *live* chain is refused rather than
performed, since that is what `token:delete` is for.

Doing it by hand in the SQL editor works too — `delete from tokens where chain
<> 'robinhood-mainnet'` — but it leaves the avatars behind in Storage, and the
anon key cannot run it at all: the policies in `lib/schema.sql` allow no deletes.

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

**The opening window** shows up here too. For the first couple of minutes of a
launch each wallet has a buy cap, and the panel reports how much of it this
wallet has left and how long is to go. Buys over the cap are not refused, they
are trimmed and the difference refunded in the same transaction, and the quote
says so before anything is signed. It caps addresses, not people — the full
account of what that does and does not stop is in `contracts/README.md`.

A creator can tighten it for their own launch from the create form: a longer
window, a smaller bite per wallet. Both directions are the protective one, and
neither can be loosened past what the platform set — the same bargain the
reserve cap already runs on.

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

## The price history

Every `TokensBought` and `TokensSold` carries the marginal price the trade left
behind, so a launch's whole price history is already on chain and nothing has to
be recorded to draw it. `lib/tradeHistory.ts` reads it back — walking the log
backwards from the head of the chain, because the interesting end of a price
history is the recent end — and the panel under the article plots it.

The chart **steps rather than slopes**. A constant-product curve only moves when
somebody trades against it, so between two trades the price is a flat line, and
sloping between points would invent a drift that never happened. The last price
runs out to the right edge for the same reason: it is still the price.

Two things about how it is wired matter more than they look:

- **It is not part of the page's server render.** A scan is a dozen
  `eth_getLogs` calls plus a block header per trade; the article, the fact box
  and the trade panel are the page and none of them should wait on it. The panel
  mounts empty and fills in from `/api/token/<address>/trades`, which caches each
  scan for twenty seconds and shares one walk between concurrent readers.
- **The axis labels are HTML, not SVG text.** Anything inside a scaled `viewBox`
  scales with it, which turns a 9px label into a 5px one on a phone. The open,
  the high and the low are printed around the plot instead — to four
  significant figures, because `formatEth`'s six decimal places cannot tell two
  curve prices apart down where a young launch's price lives.

Above the chart is the quote: the price at headline size, and beside it what it
has done over the selected window. Scrubbing the chart re-points both at the
trade under the pointer, and the label stops saying "price now" the moment the
figure stops being one.

The window is chosen with the chips under the plot — hour, day, week, month, all
— and `lib/priceWindow.ts` is the whole of that vocabulary. Two things there are
worth knowing. A range earns its chip only by containing a trade *and* leaving
one out, so a filter that would change nothing is never offered. And a window's
opening price is the last trade **before** it rather than the first one inside
it: on a curve where a single buy can move the price by a fifth, taking the
first trade inside would quietly discount the move that trade itself made. That
opening price is the dashed line on the plot, it is always inside the y-domain,
and it is what the change beside the price is measured from.

Colour on this panel says one thing and says it twice. The line, its wash and
its markers are green when the window ended above its open and red when below —
the one broker convention worth borrowing, and the reason the chip beside the
price also draws an arrow and writes the word ("Up 12.4%"). Buy and sell keep
filled and hollow markers and their words in the tape, because side and
direction are two different facts and neither is ever left to a hue alone.

Under the chart is the trade tape: side, size, trader and how long ago, each row
linking to the transaction. It doubles as the chart's table view, and hovering a
point on the chart highlights its row.

## The interface

Everything the UI is made of lives in `app/globals.css` as custom properties —
which is what makes the night palette a re-pointing of about twenty tokens
rather than a second stylesheet. `lib/theme.ts` owns the vocabulary;
`lib/boot.ts` owns the script that runs before the first paint;
`components/ThemeProvider.tsx` keeps it in step with the settings panel, other
tabs and the operating system. The default is `system`, and the wallet modal
follows along — `lib/walletTheme.ts` carries both palettes, because a wallet
list in full daylight opened from a dark page is the whole illusion gone.

### What happens on a reload

Everything below is settled by `lib/boot.ts` in the document head, before the
browser paints anything, because each one is a visible fault if it is settled a
frame later instead:

- **the palette**, on `data-theme` and `color-scheme`;
- **`theme-color`**, which on a phone is the address bar above the page and the
  gesture strip below it — the largest surface on the screen the stylesheet
  cannot reach;
- **a booting mark**, cleared two animation frames later, which holds every CSS
  transition still while the first paint is assembled. It ends as early as it
  can: a reader who presses something in the first second should see the press;
- **a settling mark**, cleared when the page has loaded, which holds the
  document's smooth scrolling. A browser restores the scroll position of a
  refresh and keeps adjusting it while the page settles — with smooth scrolling
  on the document, every one of those adjustments is an *animation* down to
  where the reader already was;
- **a wallet hint** (`lib/walletHint.ts`), so the masthead holds the space for
  the reader's own link while wagmi revives a stored session, rather than
  gaining a link and reflowing a beat after the page is on screen. It is a
  guess about layout and never an authority on the connection: wagmi still
  decides that, and the hint is rewritten every time it answers;
- **a panel hint** (`lib/panelHint.ts`), which is the same idea for the one
  panel that cannot arrive with the page. The price history is a dozen log
  queries behind `/api/token/<address>/trades`, so it mounts saying it is
  reading the log and fills in — and what fills in is a quote, a chart, the
  range chips and eight rows of tape, appearing in the middle of an article the
  reader has already been put back into. So the height it had on this page last
  time is reserved before the first paint, and the panel fills the space it
  already holds. Like the wallet hint it decides nothing: it is dropped the
  moment there is real content, and a listing whose history has changed since is
  drawn from the log.

Two more shifts on the same frame are settled outside the boot script. A stacked
fiat conversion holds its line while there is no rate to write in it
(`components/FiatValue.tsx`), and the last rate served is remembered so the
second before `/api/eth-price` answers is not a page with no estimates on it
(`lib/currency.ts`). And an entrance animation is now only ever on an element
that *arrives*: the trade panel's standing advisories are in the server's HTML
and no longer fade up on every refresh — `--live` in `app/globals.css` marks the
ones that do.

Measured on a production build in Chromium, reloading a listing whose trade log
and price feed are stubbed to answer in 700ms and 400ms: cumulative layout shift
0.688 before this, 0.000 on every reload after it. A first visit, which has no
remembered height to reserve, still shifts — there is nothing to know yet.

### Installing it

Folio is a progressive web app. `app/manifest.ts` describes it, the icons are
drawn at build time from the same mark as the favicon (`lib/appIcon.tsx`), and
`public/sw.js` is the service worker.

The offer to install is in the settings panel and nowhere else — no banner, no
interstitial — which is what `lib/installPrompt.ts` catches
`beforeinstallprompt` for. `components/AppStatus.tsx` registers the worker and
owns the two things the page says about itself from the bottom edge: that the
connection is gone, and that a newer build is installed and waiting for a
reload it does not take by itself.

The worker's caching rules are shaped by one question asked of every request:
can this be stale without lying? `/api/*` and every non-GET request are never
cached at all, because a cached price is not an old price but a wrong one.
Pages are network-first and only come from cache once the network has already
failed — with the offline strip on screen saying so. Build output under
`/_next/static/` is cache-first, since its names carry a content hash. Nothing
cross-origin is touched. `app/offline/page.tsx` is what a reader gets for a
page the worker has never seen.

Two colours reach controls, and only inside a trade panel: green to buy, red to
sell. Everywhere else the primary action is ink, because everywhere else there
is only one of them.

## Proving a byline

A launch has an author, and until a signature is asked for, that author is
whatever the browser typed into a column. Setting `SUPABASE_JWT_SECRET` turns
the column into a fact.

The exchange is one signature, at the top of the publish flow:

1. The create page asks `/api/auth/nonce` for a single-use nonce — which also
   answers `configured: false` on a deployment with no secret, and the page
   publishes as it always did.
2. It builds an EIP-4361 message (`lib/siwe.ts`) naming the site's own host, the
   connected address, the chain, that nonce and a ten-minute expiry, and asks
   the wallet to sign it. **A signature, not a transaction**: it costs no gas
   and moves nothing, and the sentence the wallet renders says so.
3. `/api/auth/verify` re-reads the message with the same parser, and checks
   every claim in it against something it already knew — the grammar, the
   statement byte for byte, the domain and URI against the request's own host,
   the nonce against its own HMAC and against the nonces already spent, the
   clock, the chain. The signature is checked last, offline first (plain ECDSA
   recovery, no network) and through the chain only for a signature that needs
   EIP-1271 — a Safe, or a smart account.
4. It mints a Supabase JWT carrying `wallet`, and the insert goes out under
   that token instead of the bare anon key.

Which is where the guarantee actually lives. The policy in `lib/schema.sql`
compares `creator_wallet` against `auth.jwt() ->> 'wallet'` and only lets a
matching row set `creator_verified`; the anon policy may still publish, and may
only publish rows that call themselves unverified. Neither of those is a check
a component could forget to make.

The signature is asked for **before** the launch transaction on purpose. The
article is inserted at the end of the flow, long after the token exists — a
signature requested there and declined would leave a live token with no listing
and real gas spent. Asked for first, declining costs nothing.

The session lives in `sessionStorage`, keyed to the address it proves, and is
dropped when the wallet disconnects. That is a step down from where the theme
and the currency live: a palette surviving a closed tab is a courtesy, a
credential surviving one is a credential left on a shared machine.

Two things this does not buy, stated plainly. It proves control of a key at a
moment in time, not that the signer is who the name suggests. And it says
nothing about the launch — the contract is still the authority on the market.

## Two generations of factory

`contracts/src/types/CurveConfig.sol` gained `sniperWindowSeconds`,
`sniperMaxEthPerWallet` and `migrator` after the factory on Robinhood Chain was
deployed. That struct is an argument to `createToken`'s widest overload and a
member of the `TokenCreated` event, so growing it changed a function selector
and an event topic — and a frontend built from this repository would have met a
factory that has neither.

The failure had three faces and none of them looked like a version mismatch:

- a launch reverts, the chain declining a function that is not there;
- had it not, the create page would have confirmed a transaction and then
  reported that its token "never turned up", because the log it went looking
  for was filtered on the wrong topic;
- and `/api/indexer` would answer `found: 0` on a factory with launches in it,
  forever, with nothing anywhere looking broken.

So the app asks the factory what it is, the same way `lib/tokenStats.ts` has
always asked a listing. `MAX_SNIPER_WINDOW_SECONDS` is a constant that arrived
with the window, so a factory that answers it has the six-argument
`createToken`; one that reverts gets the four-argument form, which both
generations have. The create form offers the two opening-window fields only
where they can be honoured — a field whose value the contract has no argument
to receive is a promise the launch cannot keep — and says why when it withholds
them. `lib/indexer.ts` and `scripts/watch-launches.mjs` filter on both topics,
and `lib/contracts/folioFactoryLegacy.ts` holds the older shapes, written out by
hand because `npm run compile:contracts` emits the ABI of the source in front of
it and the point here is the source that is not in front of it any more.

`test/factory.test.mjs` pins the legacy topic to the value read out of the live
factory's bytecode. A contract already on chain cannot change shape, so if that
constant ever needs editing, the edit is the bug.

## Claiming creator fees

The creator's share of every leg accrues in `feesAccrued` and comes out with
`claimFees()`. The article page shows the balance and the button to the creator
and to nobody else — and it decides who that is from `creator()` on the contract,
never from `creator_wallet` in the database, because that column is a claim
rather than a proof and this one moves money.

Fees live outside `ethReserve`, so claiming them cannot touch the ETH backing
anyone's ability to sell, and the platform emergency stop deliberately does not
block the call: a halt freezes trading, not the creator's balance. The panel says
both, because a button that moves money out of a contract should explain what it
cannot take with it.

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

npm run typecheck           # tsc over the whole app
npm run lint                # next lint
npm run test:web            # the node suites under test/ — sign-in, factory ABIs
npm test                    # test:web, then the retired FolioSale suite
```

The compiled ABIs are committed, so builds and deploys never need a Solidity
compiler — only edits to a `.sol` file do.

`test/` runs the app's own TypeScript modules directly, through node's type
stripping and a small resolver for the `@/` alias (`test/alias.mjs`) — so the
things under test are the modules the app imports, not copies of them. That
needs **Node 22.6 or newer**; `.github/workflows/web.yml` pins 22 and runs the
four checks above on every push.

## Notes

- **Curve figures come from the chain.** `tokens.sold_amount` and
  `tokens.starting_price` are fallbacks for rows whose contract can't be
  reached, since nothing on chain writes back to Postgres. The database stores
  the article; the contract stores the market.
- **New listings are indexed from the event log.** The create page writes its
  own row, and `/api/indexer` reconciles anything created outside it — a Foundry
  script, the explorer, or a browser that closed at the wrong moment. Pages read the
  table; they never scan the chain for the feed.
- **ETH figures carry a fiat estimate.** Every price on the site is quoted in
  ETH by a contract; a quieter line under it says what that is worth in USD or
  IDR, at the reader's choice (remembered in `localStorage`, guessed from the
  browser's locale the first time). The rate comes from `/api/eth-price`, which
  caches CoinGecko server-side for a minute. It is display only — no trade, no
  floor and no stored value is ever computed from it — and it disappears
  entirely when the price feed is unreachable, leaving the ETH untouched.
- **A read the browser can't make itself falls back to this origin.** Balances
  and contract reads go straight to the chain's RPC, as they always did. When
  that request cannot leave the phone at all — a mobile network that filters the
  endpoint's domain, an in-app browser whose WebView can't resolve it, a
  middlebox answering the POST with a block page — viem's `fallback` re-asks the
  same question through `/api/rpc/<chain>`, which relays it server-side. That is
  the difference between "Balance unavailable" on a funded wallet and a figure
  that simply appears. The relay forwards a fixed list of read methods and
  nothing else: wallets broadcast transactions through their own provider, never
  through this. A working network never touches it.
- **Connecting a phone wallet is a round trip, and Folio owns both ends of it.**
  The pairing sends the reader into their wallet app; `lib/walletMetadata.ts`
  gives that session a `redirect` so the wallet can hand them straight back to
  the page they left, rather than leaving them to find the browser themselves.
  Wallets honour it unevenly — iOS 17 took away an app's ability to push the
  reader back into Safari — so the return is caught rather than assumed:
  `WalletSessionSync` adopts the approved session across the first seconds the
  tab is visible again, however it got there, and the wallet button reads
  "Connecting…" while it does.
- **When that round trip cannot be made, Folio offers the other way in.**
  Pairing from a phone browser needs WalletConnect's relay, a wallet that
  recognises the chain in the proposal, and something to hand the reader back —
  and when any of it fails the reader is told "not supported" by an app that is
  not this one. `components/WalletHandoff.tsx` sits under every connect button
  on the site as one quiet line — it is mounted by `ConnectCue`, so it is
  wherever the reader was actually stopped rather than in the settings panel
  they would have to go looking for — and opens into links that load the current
  page inside MetaMask's, Coinbase Wallet's or Trust's own browser, plus a
  copy-link for every wallet not on that list. On a phone it is offered as what
  it is ("Open in your wallet app"), not as a support link; it only calls itself
  "Wallet not connecting?" once a connect has actually stalled, which is also
  when it opens itself. There the page runs where the wallet already
  is: `window.ethereum` is present, the connection is local, and there is no app
  switch to survive. It hides itself entirely where it is not needed — a desktop
  with an extension, or a page already opened inside a wallet browser. The same
  component is the answer for a deployment with no
  `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`, which additionally stops the connect
  modal from listing wallets that cannot pair at all (`lib/wagmiConfig.ts`).
- **A token page reads as an article, and the trade comes at the end of it.**
  Headline, byline, the piece itself, then one section holding the three figures
  a decision turns on, the buy/sell panel, and — folded shut — the whole of the
  contract's data for anyone checking the claim. The panel used to sit in a rail
  beside the headline, and on a phone it was pinned over the article from the
  first line, which offered the button before any of the case for pressing it.
  The byline carries an anchor down to the panel, so a reader who came back to
  trade rather than to read is one press away from it.
- **The trade panel has a compact setting, and it is the phone's default.** Buy
  and sell are drawn from the same three parts in the same order — amount, quick
  sizes (`0.01/0.05/0.1 ETH` and the curve's ceiling; `25/50/75%` and Max), then
  the button — so switching tabs changes the numbers and nothing else. Compact
  keeps those and folds the slippage presets and the curve's accounting behind
  "Details", with the slippage in force printed in the line that stays, so
  nothing is hidden silently. The choice is remembered
  (`components/useTradeDensity.ts`); unanswered, it comes from the screen, since
  the panel is most of a phone and fits in view whole on a desktop.
- **A wallet that connects on the wrong chain is moved, not scolded.** Wallets
  open on Ethereum mainnet, which Folio does not support, so a fresh connection
  used to land straight on "Wrong network". The connect request now names the
  chain the page is about (RainbowKit's `initialChain`), and `ChainSync` asks
  again for anything that arrives on an unsupported chain another way — a
  restored session, a wallet switched in another tab. Which chain that is comes
  from the page: a token page declares the chain its listing was launched on,
  the create form the chain it would sign to, everything else the factory's
  (`lib/preferredChain.ts`). A wallet already on a *supported* chain is left
  where the reader put it; the switch to the token's own chain happens when
  there is a transaction to sign, in the trade bar. A declined switch is not
  asked again — the "Wrong network" button is still there, and it opens the
  chain modal.
- **Article HTML is sanitized on render** (`lib/sanitize.ts`) with an allowlist
  matching Tiptap's output. Stored bodies are untrusted — they arrive through
  the public anon key.
- **Addresses are stored lowercased** so URL lookups are case-insensitive.
- **An avatar URL is refused in three places.** The column is written through
  the public anon key and read into an `<img src>` on the feed, the listing and
  both of their share cards, so an arbitrary value is a way to make every
  reader's browser announce itself to a server the author chose. The insert
  policy in `lib/schema.sql` refuses to store one that does not point at this
  project's own storage bucket, `components/Mark.tsx` draws the monogram
  instead of an `<img>` for anything that is not plainly an http(s) URL, and
  the `img-src` directive stops the browser fetching it either way.
- **The front page explains itself below the feed.** How a launch works, the
  curve terms the factory would hand the next one (read from
  `deployments/<chain>.json`, never written into the copy), and what the site
  does and doesn't promise — including which network settles in real ETH. Those
  sections are not conditional on the feed being empty: a site with one listing
  needs them as much as one with none.

## Security of the web app

The contracts have their own review — `npm run slither` and section 2 of
DEPLOYMENT.md. This is the other half: the site in front of them.

**Headers.** `lib/securityHeaders.js` builds them and `next.config.js` applies
them to every response. The Content-Security-Policy is assembled from the
environment rather than written out flat, so a deploy pointed at a different
Supabase project or a dedicated RPC does not get a policy that blocks its own
database. It allows inline scripts and says why in a comment worth reading
before changing it: Next's App Router serves inline bootstrap scripts whose
content differs per render, so covering them means either a per-request nonce —
which would opt every prerendered route in this app into dynamic rendering — or
this. Script from another origin still cannot execute at all. Alongside it:
`nosniff`, `strict-origin-when-cross-origin` referrers, a `Permissions-Policy`
that switches off features this page has no use for (leaving WebHID alone, so
hardware wallets keep working), `same-origin-allow-popups` isolation, and HSTS
in production. `frame-ancestors` allows Safe's app and refuses everything else,
because the Safe connector only works inside a frame.

Two escape hatches exist because a policy that cannot be verified gets deleted
instead: `CSP_REPORT_ONLY=1` reports violations without enforcing any, and
`CSP_EXTRA_ORIGINS` adds hosts. Both are documented in `.env.example`. Verify a
new connector on a preview deploy with the first, then turn it off.

**Untrusted input.** Everything a stranger can write arrives through the public
Supabase anon key, and every consumer treats it that way. Article bodies are
allowlist-sanitised on render (`lib/sanitize.ts`). Avatar URLs are constrained
by the insert policy, the component and the policy header. The storage bucket
carries a size limit and an image-only MIME allowlist, and no SVG — an SVG is a
document that can carry script, harmless in an `<img>` and not harmless when
the public link to it is opened directly.

**The endpoints.** `/api/rpc/<chain>` forwards a fixed list of read methods,
refuses cross-origin scripting, caps the body it will read and counts calls per
caller per minute. `/api/indexer` compares its bearer token with a timing-safe
comparison over two hashes. Neither returns an exception's message to the
caller — those go to the log, because a thrown RPC or Postgres error names
endpoints and occasionally carries a key.

**Authorship.** `creator_wallet` is proved by signature where
`SUPABASE_JWT_SECRET` is set, and labelled unproved where it is not — see
**Proving a byline**. Everything that decides what a creator may *do* reads
`creator()` from the contract either way.

**What is not solved.** Nonces are single-use through an in-process set, so a
deployment running several instances enforces that per instance rather than
globally; the ten-minute expiry and the domain binding are what hold in the
meantime, and a durable store would close the rest. The rate limiter on
`/api/rpc` has the same shape and the same caveat: real rate limiting belongs at
the edge, where a request can be refused before it costs anything to receive.

## Possible next steps

- [x] Sign-In With Ethereum so `creator_wallet` is verified rather than claimed
- [x] Graduation handling beyond closing the curve — `FolioMigrator` moves a
      graduated launch into a locked Uniswap v4 position, and the token page now
      offers the transaction that does it (`components/MigrationPrompt.tsx`).
      Whether a deployment *opts in* is still a decision: no migrator named in
      the factory's config means the curve stays terminal and the panel never
      appears
- [ ] Persisting the trade log, so a chart doesn't cost a fresh scan — the scan
      window is bounded (about six days of blocks), which is why the panel
      says "the last N trades" rather than claiming to show every one
- [ ] Nonce and rate-limit state in a store the whole deployment shares, rather
      than one process at a time
- [ ] A real audit before this carries meaningful value
- [ ] Richer editor (images inside articles, embeds) with the allowlist widened to match
