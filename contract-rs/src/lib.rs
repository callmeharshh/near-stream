// Rust port of contract/src/index.ts for mainnet: same methods and JSON field names
// for native-NEAR streams (token streams stay in the JS contract). Rust instead of
// JavaScript because a JS contract embeds the QuickJS engine (~540 KB of storage,
// ~5.6 NEAR); this one is a small fraction of that.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

const NANOS_PER_SECOND: u64 = 1_000_000_000;

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
#[derive(Clone)]
pub struct Stream {
    pub id: u64,
    pub sender: AccountId,
    pub receiver: AccountId,
    pub total_amount: U128,
    pub start_time: U64,
    pub duration_seconds: U64,
    pub withdrawn: U128,
    pub closed: bool,
    pub verifiers: Option<Vec<AccountId>>,
    pub threshold: Option<u32>,
    pub heartbeat_seconds: Option<U64>,
    // Effective attestation time: the k-th most recent of `attestations`.
    pub last_attested_at: U64,
    pub attestations: Option<Vec<U64>>, // parallel to `verifiers`
    pub settled_at: Option<U64>,
    // Nanoseconds of delivery covered by consecutive quorum attestations (gated streams).
    pub verified_nanos: Option<U64>,
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct StreamView {
    #[serde(flatten)]
    pub stream: Stream,
    pub withdrawable: U128,
}

/// k-th most recent attestation (k-of-n): one verifier alone can neither keep a dead
/// stream paid (k >= 2) nor freeze a healthy one (k < n).
pub fn effective_attested_at(times: &[u64], threshold: u32) -> u64 {
    let mut sorted = times.to_vec();
    sorted.sort_unstable_by(|a, b| b.cmp(a));
    sorted[(threshold - 1) as usize]
}

/// Verified-time accounting: the stretch between two consecutive quorum attestations
/// is paid only if they are at most one heartbeat apart. Outages and time before the
/// first quorum attestation (prev <= start) are never paid.
pub fn credit_for_attestation(prev: u64, next: u64, start: u64, heartbeat_s: u64) -> u64 {
    if prev <= start || next <= prev || next - prev > heartbeat_s * NANOS_PER_SECOND {
        return 0;
    }
    next - prev
}

pub fn verified_accrued(total: u128, verified_nanos: u64, duration_s: u64) -> u128 {
    let duration = duration_s as u128 * NANOS_PER_SECOND as u128;
    let v = verified_nanos as u128;
    if v >= duration {
        return total;
    }
    total / duration * v + total % duration * v / duration
}

/// Linear accrual for ungated streams.
pub fn accrued_amount(total: u128, start: u64, duration_s: u64, now: u64, heartbeat: Option<(u64, u64)>) -> u128 {
    let mut effective_now = now;
    if let Some((last_attested_at, heartbeat_s)) = heartbeat {
        effective_now = effective_now.min(last_attested_at + heartbeat_s * NANOS_PER_SECOND);
    }
    if effective_now <= start {
        return 0;
    }
    let elapsed = ((effective_now - start) / NANOS_PER_SECOND) as u128;
    let duration = duration_s as u128;
    if elapsed >= duration {
        return total;
    }
    // total * elapsed / duration without overflowing u128
    total / duration * elapsed + total % duration * elapsed / duration
}

fn heartbeat_of(s: &Stream) -> Option<(u64, u64)> {
    match (&s.verifiers, s.heartbeat_seconds) {
        (Some(v), Some(h)) if !v.is_empty() => Some((s.last_attested_at.0, h.0)),
        _ => None,
    }
}

fn accrued_at(s: &Stream, now: u64) -> u128 {
    match (heartbeat_of(s), s.verified_nanos) {
        (Some(_), Some(v)) => verified_accrued(s.total_amount.0, v.0, s.duration_seconds.0),
        _ => accrued_amount(s.total_amount.0, s.start_time.0, s.duration_seconds.0, now, heartbeat_of(s)),
    }
}

// Total owed to the receiver so far; a cancelled stream never accrues past settledAt,
// and a closed stream without it (fully withdrawn) is final.
fn accrued_now(s: &Stream) -> u128 {
    if s.closed && s.settled_at.is_none() {
        return s.withdrawn.0;
    }
    accrued_at(s, s.settled_at.map(|t| t.0).unwrap_or_else(env::block_timestamp))
}

#[near(contract_state)]
pub struct Contract {
    next_id: u64,
    streams: IterableMap<u64, Stream>,
}

// Self-initializing (no separate init call), like the JS contract.
impl Default for Contract {
    fn default() -> Self {
        Self { next_id: 0, streams: IterableMap::new(b"s") }
    }
}

#[near]
impl Contract {
    #[payable]
    pub fn create_stream(
        &mut self,
        receiver_id: AccountId,
        duration_seconds: u64,
        verifier_id: Option<AccountId>,
        verifier_ids: Option<Vec<AccountId>>,
        threshold: Option<u32>,
        heartbeat_seconds: Option<u64>,
    ) -> u64 {
        let total = env::attached_deposit().as_yoctonear();
        require!(total > 0, "Must attach a deposit to fund the stream");
        require!(duration_seconds > 0, "duration_seconds must be positive");
        let sender = env::predecessor_account_id();
        require!(receiver_id != sender, "Cannot stream to yourself");
        require!(verifier_id.is_none() || verifier_ids.is_none(), "Pass verifier_id or verifier_ids, not both");
        let verifiers = verifier_ids.or(verifier_id.map(|v| vec![v]));
        require!(verifiers.is_some() == heartbeat_seconds.is_some(), "verifier_id and heartbeat_seconds must be set together");
        let mut k = None;
        if let Some(v) = &verifiers {
            require!(!v.is_empty(), "verifier_ids must not be empty");
            for (i, a) in v.iter().enumerate() {
                require!(!v[..i].contains(a), "verifier_ids must be distinct");
            }
            require!(!v.contains(&receiver_id), "The verifier cannot be the receiver");
            let t = threshold.unwrap_or(1);
            require!(t >= 1 && (t as usize) <= v.len(), "threshold must be between 1 and the number of verifiers");
            k = Some(t);
        } else {
            require!(threshold.is_none(), "threshold requires verifier_ids");
        }
        if let Some(h) = heartbeat_seconds {
            require!(h > 0, "heartbeat_seconds must be positive");
        }
        let now = env::block_timestamp();
        let id = self.next_id;
        self.next_id += 1;
        let attestations = verifiers.as_ref().map(|v| vec![U64(now); v.len()]);
        let verified_nanos = verifiers.as_ref().map(|_| U64(0));
        self.streams.insert(
            id,
            Stream {
                id,
                sender: sender.clone(),
                receiver: receiver_id.clone(),
                total_amount: U128(total),
                start_time: U64(now),
                duration_seconds: U64(duration_seconds),
                withdrawn: U128(0),
                closed: false,
                verifiers,
                threshold: k,
                heartbeat_seconds: heartbeat_seconds.map(U64),
                last_attested_at: U64(now),
                attestations,
                settled_at: None,
                verified_nanos,
            },
        );
        env::log_str(&format!("Stream {id} created: {sender} -> {receiver_id}, {total} yoctoNEAR over {duration_seconds}s"));
        id
    }

    pub fn attest(&mut self, stream_id: u64) {
        let caller = env::predecessor_account_id();
        let s = self.streams.get_mut(&stream_id).unwrap_or_else(|| env::panic_str("Stream does not exist"));
        let (verifiers, threshold) = match (&s.verifiers, s.threshold) {
            (Some(v), Some(t)) => (v.clone(), t),
            _ => env::panic_str("This stream has no verifier configured"),
        };
        let idx = verifiers
            .iter()
            .position(|v| *v == caller)
            .unwrap_or_else(|| env::panic_str("Only the configured verifier can attest to this stream"));
        require!(!s.closed, "Stream already closed");
        let atts = s.attestations.get_or_insert_with(Vec::new);
        atts[idx] = U64(env::block_timestamp());
        let times: Vec<u64> = atts.iter().map(|t| t.0).collect();
        let previous = s.last_attested_at.0;
        s.last_attested_at = U64(effective_attested_at(&times, threshold));
        if let (Some(v), Some(h)) = (s.verified_nanos, s.heartbeat_seconds) {
            s.verified_nanos = Some(U64(v.0 + credit_for_attestation(previous, s.last_attested_at.0, s.start_time.0, h.0)));
        }
        env::log_str(&format!("Stream {stream_id}: attested by {caller}"));
    }

    pub fn withdraw(&mut self, stream_id: u64) -> Promise {
        let s = self.streams.get_mut(&stream_id).unwrap_or_else(|| env::panic_str("Stream does not exist"));
        require!(env::predecessor_account_id() == s.receiver, "Only the receiver can withdraw from this stream");
        require!(!(s.closed && s.settled_at.is_none()), "Stream already closed");
        let available = accrued_now(s).saturating_sub(s.withdrawn.0);
        require!(available > 0, "Nothing available to withdraw yet");
        s.withdrawn = U128(s.withdrawn.0 + available);
        if s.withdrawn.0 >= s.total_amount.0 {
            s.closed = true;
        }
        env::log_str(&format!("Stream {stream_id}: withdrawing {available} to {}", s.receiver));
        Promise::new(s.receiver.clone()).transfer(NearToken::from_yoctonear(available))
    }

    pub fn cancel(&mut self, stream_id: u64) -> Option<Promise> {
        let s = self.streams.get_mut(&stream_id).unwrap_or_else(|| env::panic_str("Stream does not exist"));
        require!(env::predecessor_account_id() == s.sender, "Only the sender can cancel this stream");
        require!(!s.closed, "Stream already closed");
        let now = env::block_timestamp();
        let accrued = accrued_at(s, now);
        let owed = accrued - s.withdrawn.0;
        let refund = s.total_amount.0 - accrued;
        s.withdrawn = U128(accrued);
        s.closed = true;
        s.settled_at = Some(U64(now));
        env::log_str(&format!("Stream {stream_id} cancelled by sender: {owed} to receiver, {refund} refunded"));
        // NEAR forbids returning a joint promise: the refund is scheduled on its own
        // (detached) and only the receiver payout is returned.
        if refund > 0 {
            Promise::new(s.sender.clone()).transfer(NearToken::from_yoctonear(refund)).detach();
        }
        (owed > 0).then(|| Promise::new(s.receiver.clone()).transfer(NearToken::from_yoctonear(owed)))
    }

    pub fn get_stream(&self, stream_id: u64) -> Option<StreamView> {
        self.streams.get(&stream_id).map(|s| StreamView {
            withdrawable: U128(accrued_now(s).saturating_sub(s.withdrawn.0)),
            stream: s.clone(),
        })
    }

    pub fn list_streams(&self) -> Vec<Stream> {
        self.streams.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const S: u64 = NANOS_PER_SECOND;

    #[test]
    fn linear_accrual_and_clamp() {
        assert_eq!(accrued_amount(1000, 0, 100, 0, None), 0);
        assert_eq!(accrued_amount(1000, 0, 100, 25 * S, None), 250);
        assert_eq!(accrued_amount(1000, 0, 100, 500 * S, None), 1000);
    }

    #[test]
    fn never_exceeds_total_and_no_overflow() {
        let huge = u128::MAX / 3;
        for s in 0..=10u64 {
            assert!(accrued_amount(999, 0, 7, s * S, None) <= 999);
            assert!(accrued_amount(huge, 0, 7, s * S, None) <= huge);
        }
    }

    #[test]
    fn heartbeat_freezes_and_resumes() {
        let frozen = accrued_amount(1000, 0, 100, 90 * S, Some((0, 30)));
        assert_eq!(frozen, 300);
        assert_eq!(accrued_amount(1000, 0, 100, 1000 * S, Some((0, 30))), 300);
        assert_eq!(accrued_amount(1000, 0, 100, 90 * S, Some((90 * S, 30))), 900);
    }

    #[test]
    fn verified_time_excludes_outage_and_pre_quorum_time() {
        // first quorum attestation at 5s: 0..5s is never paid
        assert_eq!(credit_for_attestation(0, 5 * S, 0, 20), 0);
        // 30s verified, 60s outage, recovery: only verified stretches count
        let attests = [5u64, 10, 15, 20, 25, 30, 35, 95, 100];
        let verified: u64 = attests.windows(2).map(|w| credit_for_attestation(w[0] * S, w[1] * S, 0, 20)).sum();
        assert_eq!(verified, 35 * S);
        assert_eq!(verified_accrued(1000, verified, 100), 350);
        assert_eq!(verified_accrued(1000, 500 * S, 100), 1000);
    }

    #[test]
    fn k_of_n() {
        assert_eq!(effective_attested_at(&[10, 50, 30], 1), 50);
        assert_eq!(effective_attested_at(&[10, 50, 30], 2), 30);
        // one rogue verifier alone can't keep a 2-of-3 stream alive
        let hb = Some((effective_attested_at(&[100 * S, 0, 0], 2), 20));
        assert_eq!(accrued_amount(1000, 0, 100, 100 * S, hb), 200);
        // one silent verifier alone can't freeze it
        let hb = Some((effective_attested_at(&[95 * S, 95 * S, 0], 2), 20));
        assert_eq!(accrued_amount(1000, 0, 100, 100 * S, hb), 1000);
    }
}
