# Demo video script (~2 min)

## Before you hit record (5 min)

1. Three windows side by side: browser on `http://localhost:5173`, terminal A, terminal B.
2. Fresh stream with the watchdog as verifier, 20s heartbeat, long duration so the
   number visibly ticks:
   ```bash
   near contract call-function as-transaction near-stream-contract-1794591135.testnet create_stream \
     json-args '{"receiver_id":"near-stream-receiver-1794591135.testnet","duration_seconds":1800,"verifier_id":"near-stream-verifier-1794591135.testnet","heartbeat_seconds":20}' \
     prepaid-gas '30 Tgas' attached-deposit '1 NEAR' \
     sign-as near-stream-sender-1794591135.testnet network-config testnet sign-with-keychain send
   ```
   Put the printed stream id into `agent/.env` as `STREAM_ID=`.
3. Terminal A: `cd agent && npm run worker`. Terminal B: `cd agent && npm run watchdog`.
   Wait for two `✓ attested` lines.

## Script

**0:00–0:15 — The problem.**
"When you pay an AI agent or an API for ongoing work, you either prepay and hope,
or invoice later and argue. Nothing in between enforces 'pay only while it's
actually working.'"

**0:15–0:35 — What it is.** (browser, point at the stream card)
"NEAR Stream pays per second. This stream is paying 1 NEAR over 30 minutes. Watch
the unlocked amount tick. It's gated: a verifier has to keep attesting, or payout
freezes. See the countdown — it keeps resetting."

**0:35–0:50 — The agent.** (terminal B)
"The verifier isn't a person. It's this watchdog agent. Every 5 seconds it checks
the service's actual output. Fresh, valid, progressing? It attests on-chain. Each
line here is a real NEAR transaction."

**0:50–1:15 — Break it.** (new terminal: `curl -X POST localhost:8787/stall`)
"Now the service stalls. The server is still up and still returns 200, so a normal
uptime monitor would keep paying. But no new work is coming out." (terminal B shows
`✗ stale work`) "The watchdog notices and goes silent…" (wait for the card to flip)
"…and the payment freezes. Nobody filed a dispute. The money just stopped."

**1:15–1:30 — Recover.** (`curl -X POST localhost:8787/resume`)
"Service recovers, the watchdog attests, payment resumes. If I were the payer and
didn't want to wait, I could cancel right now and get back everything past the
frozen point."

**1:30–1:50 — Why NEAR.**
"The part that makes this safe: the watchdog signs with a NEAR function-call access
key that can only call `attest` on this one contract. We tried to use it to transfer
funds, call `cancel`, and hit another contract. The protocol rejected all three. A
hacked watchdog can't steal anything. Scoped keys like that are part of the NEAR
account model itself."

**1:50–2:00 — Close.**
"NEAR Stream: pay agents per second, only while they deliver. Contract and agent are
live on testnet, and the repo has every transaction hash."

## X post draft (must be posted by you)

> Built at NEAR HACKATHON: NEAR Stream 🔁
>
> Pay AI agents & APIs per second, only while they actually deliver.
> An autonomous watchdog attests on-chain. Service stalls → payment freezes. No disputes, no invoices.
>
> The watchdog's NEAR key can only call `attest`. Even if it's hacked, it can't move a coin.
>
> Try it live: callmeharshh.github.io/near-stream
> Code + on-chain proof: github.com/callmeharshh/near-stream
>
> @NEARProtocol #NEARHackathon @NearBuilders @NearLegion
> [attach video]
