import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDelivery } from "./check.mjs";

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
