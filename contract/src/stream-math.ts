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
