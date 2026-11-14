const NANOS_PER_SECOND = 1_000_000_000n;

export type StreamTiming = {
  totalAmount: bigint;
  startTime: bigint;
  durationSeconds: bigint;
};

// A stream can optionally be gated by a verifier's heartbeat: if `now` has drifted
// past `lastAttestedAt + heartbeatSeconds`, accrual freezes at that deadline instead
// of continuing to the real time, until a fresh attestation moves the deadline
// forward again. `null` means an ungated stream (accrues in real time, as before).
export type Heartbeat = {
  lastAttestedAt: bigint;
  heartbeatSeconds: bigint;
} | null;

// k-of-n verification: the stream counts as attested at time T only once at least
// `threshold` distinct verifiers have attested at or after T, i.e. the k-th most
// recent attestation. One verifier alone can neither keep a dead service paid
// (with k >= 2) nor freeze a healthy one (with k < n).
export function effectiveAttestedAt(attestationTimes: bigint[], threshold: number): bigint {
  const sorted = [...attestationTimes].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return sorted[threshold - 1];
}

// Verified-time accounting (gated streams created after this change): a stretch of
// time is paid only if it lies between two consecutive quorum attestations no more
// than one heartbeat apart. Outage gaps (longer than the heartbeat) and the time
// before the first quorum attestation are never paid, even after delivery resumes.
// `prevEffective <= startTime` means no quorum had attested yet.
export function creditForAttestation(
  prevEffective: bigint,
  nextEffective: bigint,
  startTime: bigint,
  heartbeatSeconds: bigint,
): bigint {
  if (prevEffective <= startTime) return 0n;
  const gap = nextEffective - prevEffective;
  if (gap <= 0n || gap > heartbeatSeconds * NANOS_PER_SECOND) return 0n;
  return gap;
}

export function verifiedAccrued(totalAmount: bigint, verifiedNanos: bigint, durationSeconds: bigint): bigint {
  const durationNanos = durationSeconds * NANOS_PER_SECOND;
  if (verifiedNanos >= durationNanos) return totalAmount;
  return (totalAmount * verifiedNanos) / durationNanos;
}

// Legacy model (streams created before verified-time accounting, and ungated streams):
// accrual follows the clock, capped at the heartbeat deadline when gated.
export function accruedAmount(stream: StreamTiming, now: bigint, heartbeat: Heartbeat = null): bigint {
  let effectiveNow = now;
  if (heartbeat) {
    const deadline = heartbeat.lastAttestedAt + heartbeat.heartbeatSeconds * NANOS_PER_SECOND;
    if (effectiveNow > deadline) effectiveNow = deadline;
  }
  const elapsedSeconds = (effectiveNow - stream.startTime) / NANOS_PER_SECOND;
  if (elapsedSeconds <= 0n) return 0n;
  if (elapsedSeconds >= stream.durationSeconds) return stream.totalAmount;
  return (stream.totalAmount * elapsedSeconds) / stream.durationSeconds;
}
