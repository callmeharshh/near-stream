# Demo video script (~2 min, keep under 2:20 for X)

## Before you hit record (5 min)

Each take uses up its stream (the guardian cancels it at the end), so **create a
fresh stream for every take**:

```bash
cd "/Users/harsh/orca/workspaces/NEAR HACKATHON/NEAR-HCKTHN"
near contract call-function as-transaction near-stream-contract-1794591135.testnet create_stream \
  json-args '{"receiver_id":"near-stream-receiver-1794591135.testnet","duration_seconds":10800,"verifier_id":"near-stream-verifier-1794591135.testnet","heartbeat_seconds":20}' \
  prepaid-gas '30 Tgas' attached-deposit '1 NEAR' \
  sign-as near-stream-sender-1794591135.testnet network-config testnet sign-with-keychain send
```

It prints `Stream N created`. Use that **N** below. (Stream 7 is already created for
your first take.)

Arrange 4 terminals + the browser (`https://callmeharshh.github.io/near-stream/`,
scrolled to stream N), all `cd agent`:

| Terminal | Command | When |
|---|---|---|
| A | `npm run worker` | first |
| B | `STREAM_ID=N npm run watchdog` | second; wait for `✓ attested` and the card to show **verified & streaming** |
| C | `GUARDIAN_STREAM_IDS=N npm run guardian` | **only after** the card is green (it would cancel a frozen stream right away) |
| D | `curl -X POST localhost:8787/stall` | type it, don't press Enter yet |

## Script

**0:00–0:15 — The problem.**
"When you pay an AI agent or an API for ongoing work, you either prepay and hope,
or invoice later and argue. Nothing enforces 'pay only while it's actually working.'"

**0:15–0:35 — What it is.** (browser)
"NEAR Stream pays per second. This stream pays 1 NEAR over 3 hours; watch it
tick. It's gated: a verifier has to keep vouching for the work, or payout freezes.
See the countdown keep resetting."

**0:35–0:50 — Agent one: the watchdog.** (terminal B)
"The service we're paying is a NEAR data provider. The verifier isn't a person: this
watchdog agent checks every block it serves against an independent node. Correct,
fresh and advancing? It attests on NEAR. Each line is a real transaction."

**0:50–1:00 — Agent two: the guardian.** (terminal C)
"On the payer's side, a guardian agent watches the stream, ready to pull the money
back if it freezes."

**1:00–1:40 — Break it.** (press Enter in terminal D)
"Now the service stalls. It's still up and still returns 200, so an uptime monitor
would keep paying. But its data is going stale." (B: `✗ stale data`)
"The watchdog goes silent…" (card turns pink: **stalled — accrual frozen**)
"…and the payment freezes on its own." (C: `frozen 5s… 10s…`, then `✓ cancelled`)
"And there's the guardian. It cancelled the stream. The provider keeps exactly what
was verified, and every unverified coin went back to the payer. Nobody pressed a
button. And unverified time is never paid, even if the service comes back."

**1:40–2:00 — Why NEAR.**
"Why this is safe: each agent holds a NEAR key that can do exactly one thing. The
watchdog's key can only attest. The guardian's can only cancel, which can only
send money back to the payer. We tried to steal funds with both keys, and the
chain rejected every attempt. Scoped keys like that are part of the NEAR account
model itself."

**2:00–2:10 — Close.**
"NEAR Stream: pay agents per second, only while they deliver. It's live, and every
claim is re-checkable on-chain with one command."

## X post draft (you must post it yourself)

> Built at NEAR HACKATHON: NEAR Stream 🔁
>
> Pay AI agents & APIs per second, only while they actually deliver.
> A watchdog agent attests on-chain. Service stalls → payment freezes → a guardian agent pulls the unverified money back. No human anywhere.
>
> Each agent's NEAR key can do exactly one thing. Even a hacked agent can't move a coin.
>
> Try it live: callmeharshh.github.io/near-stream
> Code + on-chain proof: github.com/callmeharshh/near-stream
>
> @NEARProtocol #NEARHackathon @NearBuilders @NearLegion
> [attach video]
