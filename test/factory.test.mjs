/**
 * The two factory generations, and the promise that both are still readable.
 *
 * `CurveConfig` grew three fields after the factory on Robinhood Chain was
 * deployed, which changed `createToken`'s widest selector and `TokenCreated`'s
 * topic. The app now speaks both dialects — see
 * `lib/contracts/folioFactoryLegacy.ts` — and these cases are what stop that
 * from quietly stopping being true.
 *
 * The legacy topic here is a **frozen constant**, checked against the bytecode
 * of the live factory rather than derived from anything in this repository. A
 * contract already on chain cannot change shape, so if this value ever needs
 * editing, the edit is the bug.
 *
 *   npm run test:web
 */

import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, toEventSelector, toFunctionSelector } from "viem";

const { FOLIO_FACTORY_ABI } = await import("../lib/contracts/folioFactory.ts");
const { LEGACY_FOLIO_FACTORY_ABI, TOKEN_CREATED_EVENTS, findTokenCreated } = await import(
  "../lib/contracts/folioFactoryLegacy.ts"
);

/**
 * `topic0` of the five-field `TokenCreated`, read out of the deployed factory's
 * own bytecode at 0x7a2dddAE4c5Ae1db2b7450931FB66776C31b0131 on chain 4663.
 */
const LEGACY_TOPIC = "0x796c556f9ab8653a0ba060954c21149cffeeb55912775b2116bcef6188536dfa";

const FACTORY = "0x7a2ddDae4C5ae1DB2B7450931fb66776c31B0131";

const item = (abi, type, name) => abi.find((entry) => entry.type === type && entry.name === name);

test("the legacy event still hashes to the topic the live factory emits", () => {
  assert.equal(toEventSelector(item(LEGACY_FOLIO_FACTORY_ABI, "event", "TokenCreated")), LEGACY_TOPIC);
});

test("the two generations are genuinely different events", () => {
  const modern = toEventSelector(item(FOLIO_FACTORY_ABI, "event", "TokenCreated"));
  assert.notEqual(modern, LEGACY_TOPIC);

  // Which is the whole reason both are subscribed to: a filter carrying one of
  // these matches none of the other's logs, silently and forever.
  assert.deepEqual(TOKEN_CREATED_EVENTS.map(toEventSelector).sort(), [modern, LEGACY_TOPIC].sort());
});

test("the legacy createToken is a different function from the current one", () => {
  const legacy = toFunctionSelector(item(LEGACY_FOLIO_FACTORY_ABI, "function", "createToken"));

  const widest = FOLIO_FACTORY_ABI.find(
    (entry) => entry.type === "function" && entry.name === "createToken" && entry.inputs.length === 6
  );
  assert.ok(widest, "the current ABI should still carry a six-argument createToken");

  assert.notEqual(legacy, toFunctionSelector(widest));

  // The four-argument overload is what the fallback calls, and it must be a
  // form the *current* factory also has — the app picks by generation, and a
  // fallback only one side speaks is not a fallback.
  const shared = FOLIO_FACTORY_ABI.find(
    (entry) => entry.type === "function" && entry.name === "createToken" && entry.inputs.length === 4
  );
  assert.ok(shared, "the current ABI should still carry a four-argument createToken");
  assert.equal(toFunctionSelector(shared), legacy);
});

test("a launch is read back from either generation's log", () => {
  const token = "0x00000000000000000000000000000000000000aa";
  const supply = 1_000_000_000n * 10n ** 18n;

  for (const abi of [FOLIO_FACTORY_ABI, LEGACY_FOLIO_FACTORY_ABI]) {
    const log = tokenCreatedLog(abi, { token, supply });
    const found = findTokenCreated([log], FACTORY);

    assert.ok(found, "both generations should decode");
    assert.equal(found.token.toLowerCase(), token);
    assert.equal(found.totalSupply, supply);
  }
});

test("a log from another contract is not this factory's launch", () => {
  const log = tokenCreatedLog(FOLIO_FACTORY_ABI, {
    token: "0x00000000000000000000000000000000000000aa",
    supply: 1n,
  });

  const elsewhere = { ...log, address: "0x000000000000000000000000000000000000dead" };
  assert.equal(findTokenCreated([elsewhere], FACTORY), null);
});

test("the factory address is matched without regard to checksum case", () => {
  const log = tokenCreatedLog(FOLIO_FACTORY_ABI, {
    token: "0x00000000000000000000000000000000000000aa",
    supply: 7n,
  });

  assert.ok(findTokenCreated([log], FACTORY.toLowerCase()));
  assert.ok(findTokenCreated([log], FACTORY.toUpperCase().replace("0X", "0x")));
});

test("logs that decode to nothing are not mistaken for a launch", () => {
  assert.equal(findTokenCreated([], FACTORY), null);
});

/** A `TokenCreated` log as the given generation of the factory would emit it. */
function tokenCreatedLog(abi, { token, supply }) {
  const event = item(abi, "event", "TokenCreated");
  const creator = "0x00000000000000000000000000000000000000bb";

  const topics = encodeEventTopics({ abi: [event], eventName: "TokenCreated", args: { token, creator } });

  // Everything after the two indexed addresses, in order. The config tuple is
  // the member whose width differs, so it is built from the ABI's own component
  // list rather than written out — which is what keeps this fixture honest when
  // the struct grows again.
  const unindexed = event.inputs.filter((input) => !input.indexed);
  const config = unindexed.find((input) => input.name === "config");
  const values = [
    "Probe",
    "PRB",
    supply,
    Object.fromEntries(config.components.map((c) => [c.name, c.type === "address" ? creator : 1n])),
  ];

  return {
    address: FACTORY,
    topics,
    data: encodeAbiParameters(unindexed, values),
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: `0x${"11".repeat(32)}`,
  };
}
