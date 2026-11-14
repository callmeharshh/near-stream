// Deterministic delivery check for the paid service (a NEAR RPC data provider). The
// watchdog attests only when ALL hold: the payload is well-formed; the block hash
// matches an independent reference RPC at that height (the data is real, not
// fabricated); the block is recent and not future-dated; and the height advanced since
// the last attestation. If the reference can't be reached, it doesn't attest: unverified
// means unpaid. No LLM is in this path.
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export function checkDelivery(body, referenceHash, nowMs, lastHeight, maxStalenessMs, maxSkewMs = 5000) {
  if (!body || typeof body !== "object") return { ok: false, reason: "no payload" };
  const { height, hash, timestampNanos } = body;
  if (!Number.isInteger(height) || height <= 0) return { ok: false, reason: "malformed height" };
  if (typeof hash !== "string" || !BASE58_HASH.test(hash)) return { ok: false, reason: "malformed hash" };
  if (typeof timestampNanos !== "string" || !/^\d+$/.test(timestampNanos)) return { ok: false, reason: "malformed timestamp" };
  const producedMs = Number(BigInt(timestampNanos) / 1_000_000n);
  if (producedMs > nowMs + maxSkewMs) return { ok: false, reason: "timestamp is in the future" };
  if (nowMs - producedMs > maxStalenessMs) {
    return { ok: false, reason: `stale data (block is ${Math.round((nowMs - producedMs) / 1000)}s old)` };
  }
  if (lastHeight !== null && height <= lastHeight) return { ok: false, reason: "no progress since last check" };
  if (!referenceHash) return { ok: false, reason: "reference RPC unavailable, can't verify" };
  if (hash !== referenceHash) return { ok: false, reason: "block hash doesn't match the reference: wrong data" };
  return { ok: true, reason: `verified block #${height}` };
}

// Agent error handling. Permanent contract errors stop the loop (retrying would only
// burn the key's gas allowance); transient RPC failures (e.g. 429 rate limits) back off
// exponentially, capped at 60s, and reset after the next success.
// Out-of-gas and allowance errors are permanent too: retrying the same call can't succeed and only burns gas.
const PERMANENT = /Stream already closed|does not exist|Only the configured verifier|Only the sender|Exceeded the prepaid gas|Not enough allowance/;

export function classifyError(message) {
  return PERMANENT.test(message) ? "permanent" : "transient";
}

export function nextDelayMs(baseMs, consecutiveFailures) {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(60_000, baseMs * 2 ** consecutiveFailures);
}

// Guardian rule: cancel one of *my* verifier-gated streams once its payout has been
// frozen (heartbeat deadline passed) for at least `graceSeconds`. Cancel can only
// refund the sender and pay the receiver what was verified, so acting early is safe.
export function shouldCancel(stream, myAccountId, nowMs, graceSeconds) {
  if (stream.closed || stream.sender !== myAccountId) return { cancel: false };
  const guarded = Boolean(stream.verifier) || (stream.verifiers?.length ?? 0) > 0;
  if (!guarded || !stream.heartbeatSeconds || !stream.lastAttestedAt) return { cancel: false };
  const deadlineMs = Number(BigInt(stream.lastAttestedAt) / 1_000_000n) + Number(stream.heartbeatSeconds) * 1000;
  const frozenForS = Math.floor((nowMs - deadlineMs) / 1000);
  if (frozenForS < graceSeconds) return { cancel: false, frozenForS };
  return { cancel: true, frozenForS };
}
