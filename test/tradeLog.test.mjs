/**
 * Reading a trade off the log, which two modules now depend on agreeing.
 *
 * `lib/tradeRecorder.ts` walks the log forward and writes what it finds down;
 * `lib/tradeHistory.ts` reads the last few blocks live and joins the two into
 * one chart. If they decoded a log differently the seam would show up as a step
 * in the price at whatever block the recorder happened to stop at — a chart
 * that lies, drawn from data that does not. So the decoder is one function and
 * these are its cases.
 *
 *   npm run test:web
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
  toEventSelector,
} from "viem";

const { TRADE_EVENTS, decodeTrade, chronological } = await import("../lib/tradeLog.ts");

const TRADER = "0x00000000000000000000000000000000000000aa";
const HASH = `0x${"22".repeat(32)}`;

const BOUGHT = parseAbiItem(
  "event TokensBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 newPrice)"
);
const SOLD = parseAbiItem(
  "event TokensSold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 newPrice)"
);

test("both legs of the curve are filtered for", () => {
  assert.equal(TRADE_EVENTS.length, 2);
  assert.deepEqual(
    TRADE_EVENTS.map(toEventSelector).sort(),
    [toEventSelector(BOUGHT), toEventSelector(SOLD)].sort()
  );
});

test("a buy decodes to whole ETH and whole tokens", () => {
  const trade = decodeTrade(
    log("TokensBought", {
      buyer: TRADER,
      ethIn: 1_500_000_000_000_000_000n, // 1.5 ETH
      tokensOut: 250_000n * 10n ** 18n,
      newPrice: 6_000_000_000_000n, // 0.000006 ETH
    })
  );

  assert.equal(trade.side, "buy");
  assert.equal(trade.trader, TRADER);
  assert.equal(trade.eth, 1.5);
  assert.equal(trade.tokens, 250_000);
  assert.equal(trade.price, 0.000006);
  assert.equal(trade.blockNumber, 42n);
  assert.equal(trade.logIndex, 3);
  assert.equal(trade.txHash, HASH);
});

test("a sell reads ETH out and tokens in, not the other way round", () => {
  // The two events order their amounts differently — a buy is (ethIn,
  // tokensOut) and a sell is (tokensIn, ethOut) — which is exactly the pair a
  // decoder gets backwards, and the symptom is a chart where every sell is
  // enormous.
  const trade = decodeTrade(
    log("TokensSold", {
      seller: TRADER,
      tokensIn: 250_000n * 10n ** 18n,
      ethOut: 1_400_000_000_000_000_000n,
      newPrice: 5_000_000_000_000n,
    })
  );

  assert.equal(trade.side, "sell");
  assert.equal(trade.eth, 1.4);
  assert.equal(trade.tokens, 250_000);
  assert.equal(trade.price, 0.000005);
});

test("the trader's address is lowercased, like every address stored here", () => {
  const trade = decodeTrade(
    log("TokensBought", {
      // Checksummed by viem rather than typed out, so the fixture is a form
      // a real log could actually carry.
      buyer: getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      ethIn: 1n,
      tokensOut: 1n,
      newPrice: 1n,
    })
  );

  assert.equal(trade.trader, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

test("a pending log is not a settled price", () => {
  // viem hands these back with nulls where the block would be, and a chart of
  // settled prices has no place for one.
  const base = log("TokensBought", {
    buyer: TRADER,
    ethIn: 1n,
    tokensOut: 1n,
    newPrice: 1n,
  });

  assert.equal(decodeTrade({ ...base, blockNumber: null }), null);
  assert.equal(decodeTrade({ ...base, transactionHash: null }), null);
  assert.equal(decodeTrade({ ...base, logIndex: null }), null);
});

test("anything that is not one of the two events decodes to nothing", () => {
  const base = log("TokensBought", {
    buyer: TRADER,
    ethIn: 1n,
    tokensOut: 1n,
    newPrice: 1n,
  });

  assert.equal(decodeTrade({ ...base, eventName: "Transfer" }), null);
  assert.equal(decodeTrade({ ...base, args: {} }), null);
  assert.equal(decodeTrade({}), null);
});

test("a log missing an amount is refused rather than read as zero", () => {
  const base = log("TokensBought", {
    buyer: TRADER,
    ethIn: 1n,
    tokensOut: 1n,
    newPrice: 1n,
  });

  const { ethIn, ...withoutEth } = base.args;
  assert.equal(decodeTrade({ ...base, args: withoutEth }), null);

  const { newPrice, ...withoutPrice } = base.args;
  assert.equal(decodeTrade({ ...base, args: withoutPrice }), null);
});

test("trades order by block, then by position inside it", () => {
  const at = (blockNumber, logIndex) => ({ blockNumber, logIndex });

  const ordered = chronological([at(10n, 5), at(2n, 9), at(10n, 1), at(2n, 0)]);

  assert.deepEqual(
    ordered.map((t) => `${t.blockNumber}:${t.logIndex}`),
    ["2:0", "2:9", "10:1", "10:5"]
  );
});

test("ordering does not mutate what it was given", () => {
  const input = [{ blockNumber: 2n, logIndex: 0 }, { blockNumber: 1n, logIndex: 0 }];
  const before = [...input];

  chronological(input);
  assert.deepEqual(input, before);
});

test("ordering survives block numbers past what a double can hold", () => {
  // The comparator subtracts two bigints before narrowing, so a pair far apart
  // still compares correctly — the trap is subtracting after Number().
  const huge = 2n ** 64n;
  const ordered = chronological([
    { blockNumber: huge + 1n, logIndex: 0 },
    { blockNumber: huge, logIndex: 0 },
  ]);

  assert.equal(ordered[0].blockNumber, huge);
});

/** A decoded viem log, in the shape getLogs hands one back. */
function log(eventName, args) {
  const event = eventName === "TokensBought" ? BOUGHT : SOLD;
  const indexed = event.inputs.find((input) => input.indexed);
  const unindexed = event.inputs.filter((input) => !input.indexed);

  return {
    eventName,
    args,
    topics: encodeEventTopics({
      abi: [event],
      eventName,
      args: { [indexed.name]: args[indexed.name] },
    }),
    data: encodeAbiParameters(
      unindexed,
      unindexed.map((input) => args[input.name])
    ),
    blockNumber: 42n,
    logIndex: 3,
    transactionHash: HASH,
  };
}
