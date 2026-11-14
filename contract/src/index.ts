import { NearBindgen, near, call, view, UnorderedMap, NearPromise } from "near-sdk-js";
import { accruedAmount, type Heartbeat } from "./stream-math";

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
  verifier: string | null;
  heartbeatSeconds: bigint | null;
  lastAttestedAt: bigint;

  constructor(args: {
    id: number;
    sender: string;
    receiver: string;
    totalAmount: bigint;
    startTime: bigint;
    durationSeconds: bigint;
    verifier: string | null;
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
    this.verifier = args.verifier;
    this.heartbeatSeconds = args.heartbeatSeconds;
    this.lastAttestedAt = args.startTime;
  }
}

function heartbeatOf(stream: Stream): Heartbeat {
  if (!stream.verifier || stream.heartbeatSeconds === null) return null;
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
    heartbeat_seconds,
  }: {
    receiver_id: string;
    duration_seconds: number;
    verifier_id?: string | null;
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
    const hasVerifier = verifier_id !== undefined && verifier_id !== null;
    const hasHeartbeat = heartbeat_seconds !== undefined && heartbeat_seconds !== null;
    if (hasVerifier !== hasHeartbeat) {
      throw new Error("verifier_id and heartbeat_seconds must be set together");
    }
    if (hasVerifier && verifier_id === receiver_id) {
      throw new Error("The verifier cannot be the receiver");
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
      verifier: hasVerifier ? verifier_id! : null,
      heartbeatSeconds: hasHeartbeat ? BigInt(heartbeat_seconds!) : null,
    });
    this.streams.set(String(id), stream);
    near.log(
      `Stream ${id} created: ${sender} -> ${receiver_id}, ${totalAmount.toString()} yoctoNEAR over ${duration_seconds}s` +
        (hasVerifier ? `, verified by ${verifier_id} every ${heartbeat_seconds}s` : ""),
    );
    return id;
  }

  @call({})
  attest({ stream_id }: { stream_id: number }): void {
    const stream = this.requireStream(stream_id);
    if (!stream.verifier) {
      throw new Error("This stream has no verifier configured");
    }
    if (near.predecessorAccountId() !== stream.verifier) {
      throw new Error("Only the configured verifier can attest to this stream");
    }
    if (stream.closed) {
      throw new Error("Stream already closed");
    }
    stream.lastAttestedAt = near.blockTimestamp();
    this.streams.set(String(stream_id), stream);
    near.log(`Stream ${stream_id}: attested by ${stream.verifier}`);
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
