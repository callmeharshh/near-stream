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
