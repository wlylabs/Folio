# The listing is the article

*Folio is a launchpad where you write the piece and the token is minted out of
the page. Here is what that changes.*

Most tokens arrive as a ticker, a supply, and somebody's word for it. The
description is a text field under the name. The case for buying lives somewhere
else entirely — a thread, a group chat, a call — and none of it is attached to
the thing being bought.

Folio starts from the other end. The listing *is* the article. You write the
piece, publish it, and the token it describes is minted onto a bonding curve
that quotes both sides of the trade from the foot of that same page. There is no
description field, because the description is the product.

## What a launch actually is

One transaction. Publishing calls createToken on the factory, which clones an
ERC20 that is also its own market maker, and the new address is read out of the
receipt rather than computed or assumed. Name, symbol, supply, curve terms and
creator fee are frozen at that moment. Nothing on the site can rewrite them
afterwards, and no admin key here can either.

There is no pool to seed and no listing fee, so a launch costs its creator
nothing but gas. Supply defaults to a billion because that is the convention,
and changing it does not change what the launch opens at: the whole supply sits
on the curve, so the opening valuation is the curve's virtual reserve whatever
number you pick.

## The market is at the foot of the piece

Readers buy from the curve and sell straight back into the reserve it holds.
Constant product, x · y = k, with a virtual ETH reserve so the opening price is
finite. No counterparty to find, no external liquidity, no pool that can be
pulled.

A few things about that panel are worth saying plainly, because they are usually
the parts left unsaid:

**Both legs quote live.** The number under the field is the same code path the
transaction runs, re-read on every change to the amount and on a timer while the
panel is open.

**Slippage becomes a floor on chain.** The tolerance you set is the minimum-out
argument in the call. If the price moves between the quote and the block, the
trade reverts instead of filling at whatever a sandwich left behind.

**Selling is never closed** — not by the creator, not by graduation. The only
thing that halts it is the platform emergency stop, which halts buying too, and
says so on the panel.

**The opening minutes are capped per wallet.** A buy over the cap is not
refused, it is trimmed and the difference refunded in the same transaction, and
the quote says so before anything is signed. A creator can tighten that window
for their own launch and cannot loosen it.

**The reserve is printed beside the buttons** — the real ETH backing the curve,
against its cap. At 100%, every token in circulation can be sold back right now.

## The words cannot move afterwards

A blog corrects itself by rewriting the paragraph. The sentence that made the
case disappears, the date at the top does not, and a reader arriving later
cannot tell that the piece in front of them is not the piece anybody acted on.
That is a small dishonesty on a blog and a large one here, because on Folio
somebody bought on the strength of the words.

So an article is fixed at publication. There is no update policy and no delete
policy for any client — including the author, which is the entire point. Second
thoughts are appended instead: an addition is signed by the byline, dated,
rendered between the article and the trade panel, and cannot be withdrawn
afterwards either. An author who retracts cannot later retract the retraction.

The trade log is on the same page. So a reader can see that the author changed
their mind, when they changed it, and what the price was doing at the time.

## A byline is a claim until it is signed

Publishing through the site asks the wallet for one signature — a Sign-In With
Ethereum message naming this site, this address and a single-use nonce. It costs
no gas and moves nothing. What it buys is that the insert is refused in Postgres
if the byline does not match the address that signed, so no component can skip
the check. Anything published another way records the address without proving
it, and renders as "Unverified byline" — the honest label rather than a hidden
one.

Powers that move money are not decided from any of that. The creator-fee claim
reads the creator off the contract, because a database row — verified or not —
is the wrong authority for a payout.

## A readership figure worth reading

Every blog prints a view count and none of them is worth reading: a view costs
one request to manufacture. A launch on a curve has a better number lying
around — the count of distinct addresses that bought it and never sold back.
Forging that costs a transaction per address in real ETH, and every one of them
is in the contract's own event log, where anybody can recount them. It is
printed under the byline, which is where a blog puts its views.

The chart under the article comes from the same place. Every buy and sell
carries the price it left behind, so a launch's whole history is on chain and
nothing has to be recorded for it to exist. It steps rather than slopes, because
a curve only moves when somebody trades against it, and sloping between two
trades would draw a drift that never happened.

## The part no post should bury

Folio runs on one network: Robinhood Chain, mainnet, real ETH. There is no test
network and no practice mode — the one that existed was removed, so nothing on
the site is a rehearsal. The trade is final, the fees are real, and a token
bought there can lose every bit of what it cost. It is not an investment, and
nobody is underwriting it.

Write the piece. The token is minted out of the page.
