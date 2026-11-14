import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDelivery, shouldCancel } from "./check.mjs";

const ms = (iso) => Date.parse(iso);
const nanos = (iso) => (BigInt(ms(iso)) * 1_000_000n).toString();
const guarded = {
  sender: "payer.testnet",
  verifier: "watchdog.testnet",
  heartbeatSeconds: "20",
  lastAttestedAt: nanos("2026-11-14T12:00:00.000Z"), // deadline 12:00:20
  closed: false,
};

test("guardian: does not cancel while within the heartbeat window", () => {
  assert.equal(shouldCancel(guarded, "payer.testnet", ms("2026-11-14T12:00:15.000Z"), 30).cancel, false);
});

test("guardian: waits out the grace period after the freeze, then cancels", () => {
  assert.equal(shouldCancel(guarded, "payer.testnet", ms("2026-11-14T12:00:45.000Z"), 30).cancel, false); // frozen 25s
  assert.equal(shouldCancel(guarded, "payer.testnet", ms("2026-11-14T12:00:51.000Z"), 30).cancel, true); // frozen 31s
});

test("guardian: never touches streams it isn't the sender of, closed streams, or unguarded streams", () => {
  const later = ms("2026-11-14T13:00:00.000Z");
  assert.equal(shouldCancel(guarded, "someone-else.testnet", later, 30).cancel, false);
  assert.equal(shouldCancel({ ...guarded, closed: true }, "payer.testnet", later, 30).cancel, false);
  assert.equal(shouldCancel({ ...guarded, verifier: null }, "payer.testnet", later, 30).cancel, false);
});

const now = Date.parse("2026-11-14T12:00:10.000Z");
const good = { sequence: 5, producedAt: "2026-11-14T12:00:08.000Z", output: "a".repeat(64) };

test("attests fresh, well-formed, progressing work", () => {
  assert.equal(checkDelivery(good, now, 4, 10_000).ok, true);
  assert.equal(checkDelivery(good, now, null, 10_000).ok, true);
});

test("refuses when the worker is unreachable or returns nothing", () => {
  assert.equal(checkDelivery(null, now, null, 10_000).ok, false);
});

test("refuses stale work even if the server answers (the /stall case)", () => {
  const stale = { ...good, producedAt: "2026-11-14T11:59:50.000Z" };
  assert.match(checkDelivery(stale, now, 4, 10_000).reason, /stale/);
});

test("refuses when no progress was made since the last attestation", () => {
  assert.match(checkDelivery(good, now, 5, 10_000).reason, /no progress/);
});

test("refuses malformed payloads", () => {
  assert.equal(checkDelivery({ ...good, output: "not-hex" }, now, null, 10_000).ok, false);
  assert.equal(checkDelivery({ ...good, sequence: "5" }, now, null, 10_000).ok, false);
  assert.equal(checkDelivery({ ...good, producedAt: "nope" }, now, null, 10_000).ok, false);
});
