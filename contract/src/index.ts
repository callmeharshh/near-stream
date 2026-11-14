import { NearBindgen, near, call, view, UnorderedMap, NearPromise } from "near-sdk-js";
import { accruedAmount, effectiveAttestedAt, type Heartbeat } from "./stream-math";

export class Stream {
  id: number;
  sender: string;
  receiver: string;
  totalAmount: bigint;
  startTime: bigint;
  durationSeconds: bigint;
  withdrawn: bigint;
  closed: boolean;
  // Optional: an account that must periodically call `attest` to keep the stream
  // accruing. If attestations stop, accrual freezes at the last-attested deadline
  // until a fresh attestation arrives. `verifier` null means an unguarded stream.
  verifier: string | null; // legacy single-verifier streams (created before k-of-n)
  heartbeatSeconds: bigint | null;
  // Effective attestation time: for k-of-n streams, the k-th most recent attestation.
  lastAttestedAt: bigint;
  verifiers: string[] | null;
  threshold: number | null;
  attestations: Record<string, bigint> | null;

  constructor(args: {
    id: number;
    sender: string;
    receiver: string;
    totalAmount: bigint;
    startTime: bigint;
    durationSeconds: bigint;
    verifiers: string[] | null;
    threshold: number | null;
    heartbeatSeconds: bigint | null;
  }) {
    this.id = args.id;
    this.sender = args.sender;
    this.receiver = args.receiver;
    this.totalAmount = args.totalAmount;
    this.startTime = args.startTime;
    this.durationSeconds = args.durationSeconds;
    this.withdrawn = 0n;
    this.closed = false;
    this.verifier = null;
    this.heartbeatSeconds = args.heartbeatSeconds;
    this.lastAttestedAt = args.startTime;
    this.verifiers = args.verifiers;
    this.threshold = args.threshold;
    this.attestations = args.verifiers ? Object.fromEntries(args.verifiers.map((v) => [v, args.startTime])) : null;
  }
}

// Streams created before k-of-n stored a single `verifier`; treat those as 1-of-1.
function verifiersOf(stream: Stream): string[] {
  if (stream.verifiers && stream.verifiers.length) return stream.verifiers;
  return stream.verifier ? [stream.verifier] : [];
}

function heartbeatOf(stream: Stream): Heartbeat {
  if (verifiersOf(stream).length === 0 || stream.heartbeatSeconds === null || stream.heartbeatSeconds === undefined) {
    return null;
  }
  return { lastAttestedAt: stream.lastAttestedAt, heartbeatSeconds: stream.heartbeatSeconds };
}

@NearBindgen({})
class StreamContract {
  nextId: number = 0;
  streams: UnorderedMap<Stream> = new UnorderedMap<Stream>("streams");

  @call({ payableFunction: true })
  create_stream({
    receiver_id,
    duration_seconds,
    verifier_id,
    verifier_ids,
    threshold,
    heartbeat_seconds,
  }: {
    receiver_id: string;
    duration_seconds: number;
    verifier_id?: string | null; // shorthand for verifier_ids: [verifier_id], threshold: 1
    verifier_ids?: string[] | null;
    threshold?: number | null;
    heartbeat_seconds?: number | null;
  }): number {
    const totalAmount = near.attachedDeposit();
    if (totalAmount <= 0n) {
      throw new Error("Must attach a deposit to fund the stream");
    }
    if (duration_seconds <= 0) {
      throw new Error("duration_seconds must be positive");
    }
    const sender = near.predecessorAccountId();
    if (receiver_id === sender) {
      throw new Error("Cannot stream to yourself");
    }
    if (verifier_id && verifier_ids) {
      throw new Error("Pass verifier_id or verifier_ids, not both");
    }
    const verifiers = verifier_ids ?? (verifier_id ? [verifier_id] : null);
    const hasVerifier = verifiers !== null;
    const hasHeartbeat = heartbeat_seconds !== undefined && heartbeat_seconds !== null;
    if (hasVerifier !== hasHeartbeat) {
      throw new Error("verifier_id and heartbeat_seconds must be set together");
    }
    let k: number | null = null;
    if (verifiers) {
      if (verifiers.length === 0) throw new Error("verifier_ids must not be empty");
      if (new Set(verifiers).size !== verifiers.length) throw new Error("verifier_ids must be distinct");
      if (verifiers.includes(receiver_id)) throw new Error("The verifier cannot be the receiver");
      k = threshold ?? 1;
      if (!Number.isInteger(k) || k < 1 || k > verifiers.length) {
        throw new Error("threshold must be between 1 and the number of verifiers");
      }
    } else if (threshold !== undefined && threshold !== null) {
      throw new Error("threshold requires verifier_ids");
    }
    if (hasHeartbeat && heartbeat_seconds! <= 0) {
      throw new Error("heartbeat_seconds must be positive");
    }

    const id = this.nextId;
    this.nextId += 1;
    const stream = new Stream({
      id,
      sender,
      receiver: receiver_id,
      totalAmount,
      startTime: near.blockTimestamp(),
      durationSeconds: BigInt(duration_seconds),
      verifiers,
      threshold: k,
      heartbeatSeconds: hasHeartbeat ? BigInt(heartbeat_seconds!) : null,
    });
    this.streams.set(String(id), stream);
    near.log(
      `Stream ${id} created: ${sender} -> ${receiver_id}, ${totalAmount.toString()} yoctoNEAR over ${duration_seconds}s` +
        (verifiers ? `, verified by ${k} of [${verifiers.join(", ")}] every ${heartbeat_seconds}s` : ""),
    );
    return id;
  }

  @call({})
  attest({ stream_id }: { stream_id: number }): void {
    const stream = this.requireStream(stream_id);
    const verifiers = verifiersOf(stream);
    if (verifiers.length === 0) {
      throw new Error("This stream has no verifier configured");
    }
    const caller = near.predecessorAccountId();
    if (!verifiers.includes(caller)) {
      throw new Error("Only the configured verifier can attest to this stream");
    }
    if (stream.closed) {
      throw new Error("Stream already closed");
    }
    const now = near.blockTimestamp();
    if (stream.verifiers && stream.attestations && stream.threshold) {
      stream.attestations[caller] = now;
      stream.lastAttestedAt = effectiveAttestedAt(
        stream.verifiers.map((v) => stream.attestations![v] ?? stream.startTime),
        stream.threshold,
      );
    } else {
      stream.lastAttestedAt = now; // legacy 1-of-1 stream
    }
    this.streams.set(String(stream_id), stream);
    near.log(`Stream ${stream_id}: attested by ${caller}`);
  }

  @call({})
  withdraw({ stream_id }: { stream_id: number }): NearPromise | void {
    const stream = this.requireStream(stream_id);
    const caller = near.predecessorAccountId();
    if (caller !== stream.receiver) {
      throw new Error("Only the receiver can withdraw from this stream");
    }
    const accrued = accruedAmount(stream, near.blockTimestamp(), heartbeatOf(stream));
    const available = accrued - stream.withdrawn;
    if (available <= 0n) {
      throw new Error("Nothing available to withdraw yet");
    }
    stream.withdrawn += available;
    if (stream.withdrawn >= stream.totalAmount) {
      stream.closed = true;
    }
    this.streams.set(String(stream_id), stream);
    near.log(`Stream ${stream_id}: withdrawing ${available.toString()} yoctoNEAR to ${stream.receiver}`);
    return NearPromise.new(stream.receiver).transfer(available);
  }

  @call({})
  cancel({ stream_id }: { stream_id: number }): NearPromise | void {
    const stream = this.requireStream(stream_id);
    const caller = near.predecessorAccountId();
    if (caller !== stream.sender) {
      throw new Error("Only the sender can cancel this stream");
    }
    if (stream.closed) {
      throw new Error("Stream already closed");
    }
    const accrued = accruedAmount(stream, near.blockTimestamp(), heartbeatOf(stream));
    const owedToReceiver = accrued - stream.withdrawn;
    const refundToSender = stream.totalAmount - accrued;
    stream.withdrawn = accrued;
    stream.closed = true;
    this.streams.set(String(stream_id), stream);
    near.log(`Stream ${stream_id} cancelled by sender: ${owedToReceiver.toString()} to receiver, ${refundToSender.toString()} refunded`);

    // NEAR disallows returning a joint (`.and()`) promise, so the refund is fired independently
    // via `.build()` (scheduled, but not part of the function's return value) and only the
    // receiver payout is returned.
    if (refundToSender > 0n) {
      NearPromise.new(stream.sender).transfer(refundToSender).build();
    }
    if (owedToReceiver > 0n) {
      return NearPromise.new(stream.receiver).transfer(owedToReceiver);
    }
    return undefined;
  }

  @view({})
  get_stream({ stream_id }: { stream_id: number }): (Stream & { withdrawable: string }) | null {
    const stream = this.streams.get(String(stream_id));
    if (!stream) return null;
    const accrued = accruedAmount(stream, near.blockTimestamp(), heartbeatOf(stream));
    return { ...stream, withdrawable: (accrued - stream.withdrawn).toString() } as any;
  }

  @view({})
  list_streams(): Stream[] {
    return this.streams.toArray().map(([, stream]) => stream);
  }

  private requireStream(streamId: number): Stream {
    const stream = this.streams.get(String(streamId));
    if (!stream) {
      throw new Error(`Stream ${streamId} does not exist`);
    }
    return stream;
  }
}
