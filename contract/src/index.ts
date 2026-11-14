import { NearBindgen, near, call, view, UnorderedMap, NearPromise } from "near-sdk-js";
import { accruedAmount, effectiveAttestedAt, creditForAttestation, verifiedAccrued, type Heartbeat } from "./stream-math";

const FT_TRANSFER_GAS = 15_000_000_000_000n;
const PAYOUT_CALLBACK_GAS = 20_000_000_000_000n;
const ONE_YOCTO = 1n; // NEP-141 requires exactly 1 yoctoNEAR on ft_transfer

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
  // NEP-141 token contract (e.g. USDC) the stream is denominated in; null = native NEAR.
  token: string | null;
  // Set when the sender cancels: accrual never counts time past this point.
  settledAt: bigint | null;
  // Token refunds to the sender whose ft_transfer failed; reclaimable via claim_refund.
  refundOwed: bigint;
  // Verified-time accounting for gated streams: nanoseconds of delivery covered by
  // consecutive quorum attestations (see creditForAttestation). null = ungated, or a
  // stream created before this field existed (those keep the legacy clock-based model).
  verifiedNanos: bigint | null;

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
    token: string | null;
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
    this.token = args.token;
    this.settledAt = null;
    this.refundOwed = 0n;
    this.verifiedNanos = args.verifiers ? 0n : null;
  }
}

type StreamParams = {
  receiver_id: string;
  duration_seconds: number;
  verifier_id?: string | null; // shorthand for verifier_ids: [verifier_id], threshold: 1
  verifier_ids?: string[] | null;
  threshold?: number | null;
  heartbeat_seconds?: number | null;
};

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

function usesVerifiedTime(stream: Stream): boolean {
  return heartbeatOf(stream) !== null && stream.verifiedNanos !== null && stream.verifiedNanos !== undefined;
}

// Total owed to the receiver as of `now`.
function accruedAt(stream: Stream, now: bigint): bigint {
  if (usesVerifiedTime(stream)) {
    return verifiedAccrued(stream.totalAmount, stream.verifiedNanos!, stream.durationSeconds);
  }
  return accruedAmount(stream, now, heartbeatOf(stream));
}

// A cancelled stream never accrues past settledAt. Closed streams without settledAt
// (fully withdrawn, or cancelled before settledAt existed) are final.
function accruedNow(stream: Stream): bigint {
  if (stream.closed && !stream.settledAt) return stream.withdrawn;
  return accruedAt(stream, stream.settledAt ?? near.blockTimestamp());
}

@NearBindgen({})
class StreamContract {
  nextId: number = 0;
  streams: UnorderedMap<Stream> = new UnorderedMap<Stream>("streams");

  // Native-NEAR stream: the attached deposit funds it.
  @call({ payableFunction: true })
  create_stream(params: StreamParams): number {
    const totalAmount = near.attachedDeposit();
    if (totalAmount <= 0n) {
      throw new Error("Must attach a deposit to fund the stream");
    }
    return this.openStream(near.predecessorAccountId(), totalAmount, null, params);
  }

  // NEP-141 stream (e.g. USDC): the sender calls `ft_transfer_call` on the token with
  // this contract as receiver and the stream params as `msg`. If anything here throws,
  // the token contract refunds the sender in full (NEP-141 `ft_resolve_transfer`).
  @call({})
  ft_on_transfer({ sender_id, amount, msg }: { sender_id: string; amount: string; msg: string }): string {
    const token = near.predecessorAccountId();
    const totalAmount = BigInt(amount);
    if (totalAmount <= 0n) {
      throw new Error("Must transfer a positive amount");
    }
    this.openStream(sender_id, totalAmount, token, JSON.parse(msg) as StreamParams);
    return "0"; // keep all transferred tokens
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
    const previous = stream.lastAttestedAt;
    if (stream.verifiers && stream.attestations && stream.threshold) {
      stream.attestations[caller] = now;
      stream.lastAttestedAt = effectiveAttestedAt(
        stream.verifiers.map((v) => stream.attestations![v] ?? stream.startTime),
        stream.threshold,
      );
    } else {
      stream.lastAttestedAt = now; // legacy 1-of-1 stream
    }
    if (usesVerifiedTime(stream)) {
      stream.verifiedNanos! += creditForAttestation(previous, stream.lastAttestedAt, stream.startTime, stream.heartbeatSeconds!);
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
    if (stream.closed && !stream.settledAt) {
      throw new Error("Stream already closed");
    }
    const available = accruedNow(stream) - stream.withdrawn;
    if (available <= 0n) {
      throw new Error("Nothing available to withdraw yet");
    }
    stream.withdrawn += available;
    if (stream.withdrawn >= stream.totalAmount) {
      stream.closed = true;
    }
    this.streams.set(String(stream_id), stream);
    near.log(`Stream ${stream_id}: withdrawing ${available.toString()} to ${stream.receiver}`);
    return this.payout(stream, "receiver", available);
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
    const now = near.blockTimestamp();
    const accrued = accruedAt(stream, now);
    const owedToReceiver = accrued - stream.withdrawn;
    const refundToSender = stream.totalAmount - accrued;
    stream.withdrawn = accrued;
    stream.closed = true;
    stream.settledAt = now;
    this.streams.set(String(stream_id), stream);
    near.log(`Stream ${stream_id} cancelled by sender: ${owedToReceiver.toString()} to receiver, ${refundToSender.toString()} refunded`);

    // NEAR disallows returning a joint (`.and()`) promise, so the refund is fired independently
    // via `.build()` (scheduled, but not part of the function's return value) and only the
    // receiver payout is returned.
    if (refundToSender > 0n) {
      this.payout(stream, "sender", refundToSender).build();
    }
    if (owedToReceiver > 0n) {
      return this.payout(stream, "receiver", owedToReceiver);
    }
    return undefined;
  }

  // Retry a refund to the sender whose payout failed (token storage unregistered, or account gone).
  @call({})
  claim_refund({ stream_id }: { stream_id: number }): NearPromise {
    const stream = this.requireStream(stream_id);
    if (near.predecessorAccountId() !== stream.sender) {
      throw new Error("Only the sender can cancel this stream");
    }
    const amount = stream.refundOwed ?? 0n;
    if (amount <= 0n) {
      throw new Error("No refund owed");
    }
    stream.refundOwed = 0n;
    this.streams.set(String(stream_id), stream);
    return this.payout(stream, "sender", amount);
  }

  // Callback after any payout (native transfer or ft_transfer). On failure, undo the bookkeeping so the funds
  // stay claimable instead of silently disappearing from the stream's accounts.
  @call({ privateFunction: true })
  on_payout({ stream_id, to, amount }: { stream_id: number; to: "receiver" | "sender"; amount: string }): boolean {
    try {
      near.promiseResultRaw(0);
      return true;
    } catch {
      const stream = this.requireStream(stream_id);
      const value = BigInt(amount);
      if (to === "receiver") {
        stream.withdrawn -= value;
        if (!stream.settledAt) stream.closed = stream.withdrawn >= stream.totalAmount;
      } else {
        stream.refundOwed = (stream.refundOwed ?? 0n) + value;
      }
      this.streams.set(String(stream_id), stream);
      near.log(`Stream ${stream_id}: payout of ${amount} to ${to} failed; restored so it can be claimed again`);
      return false;
    }
  }

  @view({})
  get_stream({ stream_id }: { stream_id: number }): (Stream & { withdrawable: string }) | null {
    const stream = this.streams.get(String(stream_id));
    if (!stream) return null;
    const withdrawable = accruedNow(stream) - stream.withdrawn;
    return { ...stream, withdrawable: (withdrawable > 0n ? withdrawable : 0n).toString() } as any;
  }

  @view({})
  list_streams(): Stream[] {
    return this.streams.toArray().map(([, stream]) => stream);
  }

  private payout(stream: Stream, to: "receiver" | "sender", amount: bigint): NearPromise {
    const accountId = to === "receiver" ? stream.receiver : stream.sender;
    // A native transfer to a nonexistent account fails and NEAR returns the coins to this
    // contract, so native payouts need the same rollback callback as token payouts.
    const transfer = stream.token
      ? NearPromise.new(stream.token).functionCall("ft_transfer", JSON.stringify({ receiver_id: accountId, amount: amount.toString() }), ONE_YOCTO, FT_TRANSFER_GAS)
      : NearPromise.new(accountId).transfer(amount);
    return transfer.then(
        NearPromise.new(near.currentAccountId()).functionCall(
          "on_payout",
          JSON.stringify({ stream_id: stream.id, to, amount: amount.toString() }),
          0n,
          PAYOUT_CALLBACK_GAS,
        ),
      );
  }

  private openStream(sender: string, totalAmount: bigint, token: string | null, params: StreamParams): number {
    const { receiver_id, duration_seconds, verifier_id, verifier_ids, threshold, heartbeat_seconds } = params;
    if (!receiver_id || !(duration_seconds > 0)) {
      throw new Error("duration_seconds must be positive");
    }
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
      token,
    });
    this.streams.set(String(id), stream);
    near.log(
      `Stream ${id} created: ${sender} -> ${receiver_id}, ${totalAmount.toString()} ${token ?? "yoctoNEAR"} over ${duration_seconds}s` +
        (verifiers ? `, verified by ${k} of [${verifiers.join(", ")}] every ${heartbeat_seconds}s` : ""),
    );
    return id;
  }

  private requireStream(streamId: number): Stream {
    const stream = this.streams.get(String(streamId));
    if (!stream) {
      throw new Error(`Stream ${streamId} does not exist`);
    }
    return stream;
  }
}
