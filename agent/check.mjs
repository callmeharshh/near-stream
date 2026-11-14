// Deterministic delivery check. The watchdog only attests when ALL of these hold:
// the worker answered, the payload is well-formed, the latest work is fresh, and
// the worker has made progress since the last check. No LLM is in this path.
export function checkDelivery(body, nowMs, lastSequence, maxStalenessMs) {
  if (!body || typeof body !== "object") return { ok: false, reason: "no payload" };
  const { sequence, producedAt, output } = body;
  if (!Number.isInteger(sequence)) return { ok: false, reason: "malformed sequence" };
  if (typeof output !== "string" || !/^[0-9a-f]{64}$/.test(output)) return { ok: false, reason: "malformed output" };
  const producedMs = Date.parse(producedAt);
  if (Number.isNaN(producedMs)) return { ok: false, reason: "malformed timestamp" };
  if (nowMs - producedMs > maxStalenessMs) {
    return { ok: false, reason: `stale work (${Math.round((nowMs - producedMs) / 1000)}s old)` };
  }
  if (lastSequence !== null && sequence <= lastSequence) return { ok: false, reason: "no progress since last check" };
  return { ok: true, reason: `fresh work #${sequence}` };
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
