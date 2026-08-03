# Posts

Long-form pieces written to be published as X Articles. One file per piece, and
the file *is* the post — headline, dek, body — so it can be pasted into the
composer without anything being stripped out of it first.

```
content/x/
  the-listing-is-the-article.md   what Folio is, and what the shape of it changes
  README.md                       this file
```

## Writing one

- **No markup that X will not render.** Its editor takes headings, bold,
  italics, bullets and links, and nothing else. Backticks would arrive as
  backticks, so identifiers are written in plain prose — `createToken` becomes
  createToken — and `x * y = k` is set with a real multiplication sign rather
  than a code span.
- **The first line is the headline and the second is the dek.** X asks for the
  title separately from the body; the italic line under it is the standfirst.
- **The real-money paragraph goes last and is not folded into a disclaimer.**
  Same rule the intro film's scene 7 follows (`scripts/intro-video/README.md`):
  it is in the piece because `/about` says the same thing, and a post that left
  it out would be selling something the product refuses to sell.

## What the article claims

Everything in it is something the repository already does, and it is worth
keeping that true as the piece is edited. Where each claim lives:

| claim | where it is true |
| --- | --- |
| The listing is the article and the token is minted from it | `app/create`, `app/about/page.tsx` |
| One call to the factory clones an ERC20 that is its own market maker; the address is read from the `TokenCreated` receipt | README, *How a launch works* |
| No listing fee and no pool to seed — a launch costs its creator gas | `app/about/page.tsx` |
| The whole supply sits on the curve, so supply does not set the opening valuation | README, *How a launch works* |
| Constant product with a virtual ETH reserve; fees taken outside it | `contracts/src/FolioToken.sol`, `contracts/README.md` |
| Quotes come from the same code path the trade runs | README, *How trading works* |
| Slippage becomes `minTokensOut` / `minEthOut` on chain | README, *How trading works* |
| Selling is closed only by the platform emergency stop | README, *How trading works* |
| The opening window trims an over-cap buy and refunds the difference in the same transaction; a creator may tighten it and not loosen it | README, *How trading works* |
| The reserve and its cap are printed beside the buttons; 100% means everything in circulation can be sold back | README, *How trading works* |
| No update and no delete policy on `tokens` for any client; additions are signed, dated and permanent | `lib/schema.sql`, README, *Changing your mind after publishing* |
| The trade log sits on the same page as the article and its additions | README, *Changing your mind after publishing* |
| The byline is proved by an EIP-4361 signature, checked by the insert policy in Postgres; anything else says "Unverified byline" | README, *Proving a byline* |
| `claimFees` reads `creator()` from the contract rather than the database | README, *Claiming creator fees* |
| Readership is distinct addresses that bought and never sold back to the curve | README, *The readership figure* |
| The price history is read from the trade events, and the chart steps rather than slopes | README, *The price history* |
| One network — Robinhood Chain, mainnet, real ETH, no test network and no practice mode | README, *Status*; `app/about/page.tsx` |

No launch, ticker, price or address is named anywhere in the piece, so there is
nothing in it that dates or that points a reader at somebody's position.
