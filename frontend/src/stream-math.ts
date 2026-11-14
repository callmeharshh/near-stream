// Mirrors contract/src/stream-math.ts so the UI can tick the withdrawable amount
// live between chain reads, without re-polling the RPC every second.
// k-of-n is deliberately NOT recomputed here: the contract already reduces the
// verifiers' attestations to one effective `lastAttestedAt` (the k-th most recent)
// on every `attest`, and the UI reads that value from chain.
const NANOS_PER_SECOND = 1_000_000_000n;

export type StreamTiming = {
  totalAmount: bigint;
  startTime: bigint;
  durationSeconds: bigint;
};

export type Heartbeat = {
  lastAttestedAt: bigint;
  heartbeatSeconds: bigint;
} | null;

// Newer gated streams pay only verified time (stretches between consecutive attestations
// within the heartbeat); the contract tracks it as `verifiedNanos`.
export function verifiedAccrued(totalAmount: bigint, verifiedNanos: bigint, durationSeconds: bigint): bigint {
  const durationNanos = durationSeconds * NANOS_PER_SECOND;
  if (verifiedNanos >= durationNanos) return totalAmount;
  return (totalAmount * verifiedNanos) / durationNanos;
}

export function accruedAmount(stream: StreamTiming, nowNanos: bigint, heartbeat: Heartbeat = null): bigint {
  let effectiveNow = nowNanos;
  if (heartbeat) {
    const deadline = heartbeat.lastAttestedAt + heartbeat.heartbeatSeconds * NANOS_PER_SECOND;
    if (effectiveNow > deadline) effectiveNow = deadline;
  }
  const elapsedSeconds = (effectiveNow - stream.startTime) / NANOS_PER_SECOND;
  if (elapsedSeconds <= 0n) return 0n;
  if (elapsedSeconds >= stream.durationSeconds) return stream.totalAmount;
  return (stream.totalAmount * elapsedSeconds) / stream.durationSeconds;
}
