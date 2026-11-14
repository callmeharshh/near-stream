import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDelivery, shouldCancel, classifyError, nextDelayMs } from "./check.mjs";

test("agent errors: closed/missing streams and permission errors are permanent; RPC errors are transient", () => {
  assert.equal(classifyError("Smart contract panicked: Stream already closed"), "permanent");
  assert.equal(classifyError("Smart contract panicked: Stream 4 does not exist"), "permanent");
  assert.equal(classifyError("Only the configured verifier can attest to this stream"), "permanent");
  assert.equal(classifyError("Exceeded the prepaid gas."), "permanent");
  assert.equal(classifyError("Not enough allowance for access key ed25519:abc"), "permanent");
  assert.equal(classifyError("429 Too Many Requests"), "transient");
  assert.equal(classifyError("fetch failed"), "transient");
});

test("agent backoff: doubles per consecutive failure, capped at 60s, normal after success", () => {
  assert.equal(nextDelayMs(5000, 0), 5000);
  assert.equal(nextDelayMs(5000, 1), 10_000);
  assert.equal(nextDelayMs(5000, 3), 40_000);
  assert.equal(nextDelayMs(5000, 10), 60_000);
});

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

test("guardian: also guards k-of-n streams (verifiers list instead of a single verifier)", () => {
  const kofn = { ...guarded, verifier: null, verifiers: ["a.testnet", "b.testnet", "c.testnet"], threshold: 2 };
  assert.equal(shouldCancel(kofn, "payer.testnet", ms("2026-11-14T12:00:51.000Z"), 30).cancel, true);
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
