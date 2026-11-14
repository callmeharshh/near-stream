import { test } from "node:test";
import assert from "node:assert/strict";
import { accruedAmount } from "./stream-math.ts";

const base = { totalAmount: 1000n, startTime: 0n, durationSeconds: 100n };
const S = 1_000_000_000n; // 1 second in nanoseconds

test("nothing accrued before start", () => {
  assert.equal(accruedAmount(base, -1n), 0n);
  assert.equal(accruedAmount(base, 0n), 0n);
});

test("linear accrual mid-stream", () => {
  assert.equal(accruedAmount(base, 25n * S), 250n);
  assert.equal(accruedAmount(base, 50n * S), 500n);
});

test("clamps to total at and after duration", () => {
  assert.equal(accruedAmount(base, 100n * S), 1000n);
  assert.equal(accruedAmount(base, 500n * S), 1000n);
});

test("never exceeds totalAmount with non-divisible rates", () => {
  const odd = { totalAmount: 999n, startTime: 0n, durationSeconds: 7n };
  for (let s = 0n; s <= 10n; s++) {
    const accrued = accruedAmount(odd, s * S);
    assert.ok(accrued <= odd.totalAmount, `accrued ${accrued} exceeds total at s=${s}`);
  }
});

test("heartbeat: accrues normally while within the attested window", () => {
  const heartbeat = { lastAttestedAt: 0n, heartbeatSeconds: 30n };
  assert.equal(accruedAmount(base, 20n * S, heartbeat), 200n);
  assert.equal(accruedAmount(base, 30n * S, heartbeat), 300n); // exactly at the deadline
});

test("heartbeat: freezes accrual once real time passes the deadline", () => {
  const heartbeat = { lastAttestedAt: 0n, heartbeatSeconds: 30n };
  const atDeadline = accruedAmount(base, 30n * S, heartbeat);
  // Real time moves far past the deadline, but accrual stays pinned to it.
  assert.equal(accruedAmount(base, 90n * S, heartbeat), atDeadline);
  assert.equal(accruedAmount(base, 1000n * S, heartbeat), atDeadline);
});

test("heartbeat: a fresh attestation immediately releases the real elapsed amount", () => {
  // The freeze is a *cancel-time safety cap*, not a reduction of what's owed: once a
  // fresh attestation moves the deadline past the real clock, accrual reflects the
  // real elapsed time again (no separate "paused duration" is tracked).
  const stalled = { lastAttestedAt: 0n, heartbeatSeconds: 30n };
  const frozenAt = accruedAmount(base, 90n * S, stalled); // 300: safe to cancel-refund at this point
  assert.equal(frozenAt, 300n);
  const resumed = { lastAttestedAt: 90n * S, heartbeatSeconds: 30n };
  assert.equal(accruedAmount(base, 90n * S, resumed), 900n); // real 90s elapsed, now confirmed safe
});

test("heartbeat: null behaves exactly like an ungated stream", () => {
  assert.equal(accruedAmount(base, 40n * S, null), accruedAmount(base, 40n * S));
});
