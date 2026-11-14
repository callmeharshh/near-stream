import { test } from "node:test";
import assert from "node:assert/strict";
import { accruedAmount, effectiveAttestedAt, creditForAttestation, verifiedAccrued } from "./stream-math.ts";

test("verified time: nothing is paid before the first quorum attestation", () => {
  // stream starts at 0; the first quorum attestation lands at 5s: the 0..5s stretch is unverified
  assert.equal(creditForAttestation(0n, 5n * 1_000_000_000n, 0n, 20n), 0n);
});

test("verified time: consecutive attestations within the heartbeat are paid", () => {
  const S = 1_000_000_000n;
  assert.equal(creditForAttestation(5n * S, 10n * S, 0n, 20n), 5n * S);
});

test("verified time: an outage longer than the heartbeat is never paid, even after recovery", () => {
  const S = 1_000_000_000n;
  // attest at 10s, outage, next attest at 70s with a 20s heartbeat: the 60s gap earns nothing
  assert.equal(creditForAttestation(10n * S, 70n * S, 0n, 20n), 0n);
  // the reviewer's case: 30s verified then a 60s outage then recovery must stay at 30s worth
  let verified = 0n;
  const attests = [5n, 10n, 15n, 20n, 25n, 30n, 35n, 95n, 100n].map((t) => t * S); // outage 35s..95s
  for (let i = 1; i < attests.length; i++) verified += creditForAttestation(attests[i - 1], attests[i], 0n, 20n);
  assert.equal(verified, 35n * S); // 5..35 (30s) + 95..100 (5s); the 60s outage is excluded
  assert.equal(verifiedAccrued(1000n, verified, 100n), 350n);
});

test("verified time: payout caps at the stream total", () => {
  assert.equal(verifiedAccrued(1000n, 500n * 1_000_000_000n, 100n), 1000n);
});

test("k-of-n: effective attestation is the k-th most recent", () => {
  assert.equal(effectiveAttestedAt([10n, 50n, 30n], 1), 50n);
  assert.equal(effectiveAttestedAt([10n, 50n, 30n], 2), 30n);
  assert.equal(effectiveAttestedAt([10n, 50n, 30n], 3), 10n);
});

test("k-of-n 2-of-3: one rogue verifier alone cannot keep a stream alive", () => {
  // Only verifier A keeps attesting (t=100); B and C went silent at t=0.
  const heartbeat = { lastAttestedAt: effectiveAttestedAt([100n * S, 0n, 0n], 2), heartbeatSeconds: 20n };
  assert.equal(accruedAmount(base, 100n * S, heartbeat), accruedAmount(base, 20n * S)); // frozen at 20s
});

test("k-of-n 2-of-3: one silent verifier alone cannot freeze a healthy stream", () => {
  // A and B attested at t=95; C is silent (or malicious) since t=0.
  const heartbeat = { lastAttestedAt: effectiveAttestedAt([95n * S, 95n * S, 0n], 2), heartbeatSeconds: 20n };
  assert.equal(accruedAmount(base, 100n * S, heartbeat), accruedAmount(base, 100n * S)); // still accruing in real time
});

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
