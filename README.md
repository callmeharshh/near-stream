# NEAR Stream — verified pay-per-second payments

Built for **NEAR HACKATHON 2026**, tracks: **Real-World Money**, **Agent
Economy**, **Autonomous Business** (procurement: a business that pays for
services only while they're delivered, with an agent that cuts them off), and
**AI Security & Defense**.

> **Pay agents and APIs per second, only while they deliver.** A watchdog agent
> attests on-chain while work is really happening; when it stops, payment
> freezes by itself, and a guardian agent cancels and brings the unverified
> money home. No human in the loop on either side. Each agent's NEAR key can do
> exactly one safe thing, so even a hacked agent can't move a coin.

| | |
|---|---|
| **Live app** (testnet, no install) | **https://callmeharshh.github.io/near-stream/** — stream #6 ticks live through Nov 19 |
| **Verify every claim** (read-only, ~15s) | `node scripts/verify-evidence.mjs` → **21/21 PASS** |
| **All tests** | `npm run install:all && npm test` → 20 passing (11 contract math, 9 agent rules) |
| **Demo script** | [`DEMO.md`](./DEMO.md) |
| **Mainnet** | Not deployed yet (needs ~7.5 NEAR of storage deposit). `scripts/mainnet-setup.mjs` deploys the whole system (contract, scoped watchdog + guardian keys, demo stream) in one command, and has been run end to end with `DRY_RUN=1` on testnet. |

**For reviewers, with no NEAR account needed:** `npm run install:all && npm test`
(20 unit tests), `npm run verify` (re-checks all 21 on-chain claims, read-only), and
the hosted app above. Running the live agents yourself (watchdog, guardian) needs free
testnet accounts from the faucet; see *Setup — the autonomous watchdog*.

### Where this fits

| | Pays for | Stops paying when the work stops? | Who stops it |
|---|---|---|---|
| Invoices / prepayment | a period or a deliverable | no; you dispute afterwards | humans, later |
| Time-based streaming (Sablier, Superfluid) | elapsed time | no; time passing is enough | the payer, manually |
| Per-request payments (e.g. x402) | each call | yes, per call; not suited to continuous work | n/a |
| Outage compensation (SLA escrows) | nothing extra; refunds *after* an outage | no; pays out afterwards | oracles, after the fact |
| **NEAR Stream** | **verified elapsed time** | **yes, within the heartbeat window** | **k of n watchdogs going silent freezes it; the guardian cancels it** |

Lump-sum payroll and invoicing require trust: the payer has to trust the payee
delivered before paying, or the payee has to trust the payer will pay at all.
NEAR Stream removes that by streaming NEAR continuously, second by second,
into a contract the receiver can withdraw from at any time, with the sender
always able to cancel and reclaim whatever hasn't streamed yet.

That alone is a known pattern (think Sablier/Superfluid, but on NEAR). The
part that doesn't exist elsewhere: **a stream can be gated on a verifier's
heartbeat, and the verifier is an autonomous agent.**

The included **SLA watchdog** (`agent/`) checks a paid service every few
seconds. While the service is verifiably delivering (fresh, well-formed,
progressing work), the watchdog calls `attest` on-chain. When delivery stops —
the server dies, *or* the server stays up and answers `200` but quietly stops
producing work (the failure a plain uptime check misses) — the watchdog stops
attesting and the payout **freezes automatically**. No dispute, no invoice, no
human in the loop. Delivery resumes, attestation resumes, payout resumes. The
sender can cancel at any moment and is guaranteed a refund of everything
beyond the last-attested-safe point.

**No single watchdog to trust.** A stream can require **any k of n independent
watchdogs** (e.g. 2 of 3) to keep attesting. One watchdog that's down, buggy, or
malicious can't freeze a healthy stream on its own, and one that's colluding with
the provider can't keep a dead stream paid on its own. Both are verified live on
testnet below.

On the payer's side, the **guardian** (`agent/guardian.mjs`) watches the
payer's streams. If one stays frozen past a grace period, it cancels it: the
receiver keeps exactly what was verified, and the rest returns to the payer.
Nobody has to notice, decide, or press a button.

**Why this needs NEAR specifically:** each agent signs with a NEAR
**function-call access key** scoped to exactly one method on exactly one
contract. The watchdog's key can only `attest`; the guardian's can only
`cancel`, and this contract's `cancel` can only refund the payer and pay the
receiver for verified time. NEAR enforces those scopes at the protocol level.
Verified on testnet (below): both keys' attempts to transfer NEAR, call other
methods, or touch other contracts are rejected by the chain itself. These are
sandboxed agent wallets with hard boundaries, built from a native NEAR account
primitive, not a smart-contract wrapper.

## How it works

1. A sender locks NEAR into the contract, naming a receiver and a duration.
2. **Optionally**, the sender also names verifiers (one, or k of n) and a
   `heartbeat` window. The stream counts as attested at time T once at least k
   distinct verifiers have attested at or after T.
3. The contract computes, on every call, how much has "unlocked": normally
   `totalAmount * elapsedSeconds / durationSeconds`; if a heartbeat is
   configured and has lapsed, elapsed time is capped at the last attestation's
   deadline instead of the real clock — the number simply stops growing.
4. The receiver can withdraw their unlocked balance at any time.
5. The sender can cancel at any time — the receiver is paid everything accrued
   (frozen amount included) up to that moment, and the sender gets the rest
   back, in the same transaction.

## Why NEAR

- **Function-call access keys** (above) give the verifier agent a
  protocol-enforced, single-method, non-custodial key. That's the security model
  for letting an autonomous agent touch a payment stream at all.
- Sub-cent gas costs make per-second, many-small-transaction settlement
  actually practical (a stream with thousands of partial withdrawals would be
  uneconomical on most other chains).
- Wallet Selector's `Bitte Wallet` module gives a first-time user a working
  wallet in a few clicks via a browser redirect, no extension required —
  important for a payroll tool aimed at people who've never touched crypto
  before. `Here Wallet` (mobile/QR) and `Meteor Wallet` (extension) are also
  wired up as alternatives. (`MyNearWallet` was dropped after it stopped
  accepting new app connections mid-hackathon — see `DECISIONS.md`.)

## Architecture

```
contract/   near-sdk-js (TypeScript) smart contract, compiled to WASM
frontend/   Vite + TypeScript, NEAR Wallet Selector, talks to the contract
            directly over a public testnet RPC (no backend server)
agent/      worker.mjs   — demo paid service (produces work every 2s)
            watchdog.mjs — autonomous verifier; attests via an attest-only key
            guardian.mjs — payer-side agent; cancels frozen streams via a cancel-only key
            check.mjs    — the deterministic delivery check + guardian rule (unit-tested)
```

```
 paid service ──(GET /work every 5s)──▶ watchdog ──attest() via scoped key──▶ stream contract
                                            │                                     │
                     fresh + valid + progressing?  no ──▶ stays silent ──▶ payout freezes
                                                                                  ▼
                                                                  frontend reads state, shows countdown
```

- **Agent** (`agent/`): the delivery check is deterministic, with no LLM in the
  path. It attests only if the payload is well-formed, the latest work is fresh
  (≤ 2× the check interval old), and the sequence number advanced since the
  last attestation. Checks run sequentially, never overlapping, because two
  concurrent transactions from one access key would collide on its nonce.

- **Contract** (`contract/src/index.ts`): one `UnorderedMap<Stream>`, four
  `@call` methods (`create_stream`, `attest`, `withdraw`, `cancel`) and two
  `@view` methods (`get_stream`, `list_streams`). Accrual math — including the
  heartbeat-freeze logic — lives in `contract/src/stream-math.ts`, unit-tested
  (11 tests, including k-of-n) in isolation from the SDK.
- **Frontend** (`frontend/src/`): `near.ts` wraps Wallet Selector + a
  `JsonRpcProvider` for reads; `main.ts` renders the UI and ticks the
  displayed "withdrawable" amount client-side between chain reads (always
  re-verified against the contract's own accrual math on every action).

See [`DECISIONS.md`](./DECISIONS.md) for the non-obvious calls made along the
way (a NEAR runtime restriction on joint promises, a TypeScript/near-sdk-js
version conflict, an Apple Silicon toolchain requirement).

## Verified on testnet (real transactions, real balance movement)

Contract: [`near-stream-contract-1794591135.testnet`](https://explorer.testnet.near.org/accounts/near-stream-contract-1794591135.testnet)

Every one of these was executed for real and reconciled against on-chain
account balances before/after, across three independent accounts (contract,
sender, receiver) — not just checked via a success/failure status:

| Action | Transaction |
|---|---|
| `create_stream` (0.2 NEAR over 30s) | [`56GLoZrM64...`](https://explorer.testnet.near.org/transactions/56GLoZrM64ppufo65en5xU58uVB7eZ2Dge57BSv4Jz3a) |
| `withdraw` (partial, ~12s in) | [`xrrEZ8a9AS...`](https://explorer.testnet.near.org/transactions/xrrEZ8a9ASQeFxnm2L31VC5aMihXwkqF1Fu1rAba4MV) |
| `cancel` (splits remaining accrual vs. refund) | [`6AQ7u1TBWk...`](https://explorer.testnet.near.org/transactions/6AQ7u1TBWkXviBJyNk1bB6wFxuaobEzzVtbPzry6qgwn) |
| `create_stream` with a verifier + 8s heartbeat | [`3KKJjtGZor...`](https://explorer.testnet.near.org/transactions/3KKJjtGZorNT2TRRDuGJAcy8X5NmfuWz7StahZF69C8H) |
| `attest` (verifier-only; confirmed a non-verifier account is rejected) | [`BpPdVRPkMw...`](https://explorer.testnet.near.org/transactions/BpPdVRPkMw6CYE5fti6EkJS2PRt5ijtFZCdAwEp46TFy) |
| `cancel` on a **stalled** stream — receiver got only the frozen 5s-cap amount (0.025 NEAR), sender got the rest back (0.475 NEAR), despite ~20s of real time having passed with zero attestation | [`5wUiwTkQ3e...`](https://explorer.testnet.near.org/transactions/5wUiwTkQ3estn7PpdQbH6aXUu5xTQLjiFogjPJ2X5L98) |

That last one is the actual proof of the circuit-breaker claim: the sender was
protected from paying for ~15 unverified seconds, recovering 95% of the stream
instead of the ~80% a plain linear split would have given back.

`node scripts/verify-evidence.mjs` re-checks all of this read-only. It doesn't
just confirm the transactions exist: it checks the *properties*. Examples: the
stalled cancel paid out exactly the frozen 0.025 NEAR; stream 3 is still frozen
below its total long after its duration ended; and each watchdog `attest` was
signed by the attest-only key.

### The autonomous watchdog, verified

| What | Evidence |
|---|---|
| Scoped key registered on the verifier: `attest` only, on the stream contract only | [`Fbq7a2aYNo...`](https://explorer.testnet.near.org/transactions/Fbq7a2aYNoQ5fWQBnhh3xxc1PpJxyycGoLP26gRUNywc) |
| Watchdog attesting stream 5 on its own (no human) | [`59MdeFRME5...`](https://explorer.testnet.near.org/transactions/59MdeFRME5GXgLb5WQzYn4USzSRhnrFSZFHS6V7JNsGD), [`2HtMF5s9WY...`](https://explorer.testnet.near.org/transactions/2HtMF5s9WYvgbmJn5wTZn4UCvcpMrXmwJySTEJt87Wna) |
| Worker `POST /stall` (still answering 200) → watchdog logged `stale work`, stopped attesting → `withdrawable` identical across two on-chain reads 8s apart | watchdog log + `get_stream` reads |
| Worker `POST /resume` → watchdog attested again → payout resumed | [`CTtAbSqAHP...`](https://explorer.testnet.near.org/transactions/CTtAbSqAHPRxkh3ZHY5d2zFb7oLFCmhvYeEMkKXEVnQS) |
| Same key tries to **transfer NEAR** (even 0.001) | rejected by protocol: `Access key requires full access` |
| Same key tries to call **`cancel`** | rejected by protocol: `Access key does not allow method cancel` |
| Same key tries to call another contract | rejected by protocol: `Access key receiver ... does not match transaction receiver` |

### The guardian, verified

| What | Evidence |
|---|---|
| Guardian key on the payer account: `cancel` only, on the stream contract only | on-chain `view_access_key` (checked by the verifier script) |
| Stream 8: watchdog attested, worker stalled, payout froze, and **the guardian cancelled it 19s into the freeze, with no human involved**. Receiver kept 0.0143 NEAR for 43s of verified work; **0.1857 NEAR returned to the payer automatically.** | [`4pq5Hmd2WC...`](https://explorer.testnet.near.org/transactions/4pq5Hmd2WCvWhjU9xGWafmxHTjiozd5518oBsUFF49D4) (signed by the cancel-only key) |
| Guardian key tries to **transfer NEAR** | rejected by protocol: `Access key requires full access` |
| Guardian key tries to call **`withdraw`** / **`create_stream`** | rejected by protocol: `Access key does not allow method ...` |

### k-of-n watchdogs, verified (stream 9: 2 of 3)

| What | Evidence |
|---|---|
| Stream gated 2-of-3 on three separate verifier accounts, each with its own attest-only key | [`8km39Ea36D...`](https://explorer.testnet.near.org/transactions/8km39Ea36DyVkEmMksLnnrps2YBRk95FP9E3xquqgRJN) + key scopes checked by the verifier script |
| All three watchdogs attesting independently | e.g. [`JAE3whzjg5...`](https://explorer.testnet.near.org/transactions/JAE3whzjg5VgBEem7xL9T8wa7PjuRzFuthYcnhduLCFt), [`39BQq8EibG...`](https://explorer.testnet.near.org/transactions/39BQq8EibGuDLdRnS29z91zYHMWYRmpqCfef3SSeSv6c), [`6wxpKF8eEy...`](https://explorer.testnet.near.org/transactions/6wxpKF8eEy2drqC35rwC7AJ35DteUhWsi6yZuSdTKbwG) |
| Killed watchdog C → **payment kept flowing** (`withdrawable` 0.00967 → 0.01067 NEAR across reads) | `get_stream` reads |
| Killed watchdog B too → **froze**, even though watchdog A kept attesting successfully | A's still-succeeding attest: [`FxVsiwXa8M...`](https://explorer.testnet.near.org/transactions/FxVsiwXa8MNGekgBWBy1tipv4qrD2DddJ8URTkhWSbe3); the verifier script checks it landed *after* the stream's effective deadline |

## Setup — contract

```bash
cd contract
npm install
npm test            # unit tests for accrual, heartbeat freeze and k-of-n math (11 tests)
npm run build        # -> build/contract.wasm
```

Requires Rosetta 2 on Apple Silicon Macs (`softwareupdate --install-rosetta
--agree-to-license`) — see `DECISIONS.md`.

To redeploy under your own testnet account:

```bash
near account create-account sponsor-by-faucet-service <your-account>.testnet \
  autogenerate-new-keypair save-to-keychain network-config testnet create
near contract deploy <your-account>.testnet use-file build/contract.wasm \
  without-init-call network-config testnet sign-with-keychain send
```

## Setup — frontend

```bash
cd frontend
npm install
npm run dev           # -> http://localhost:5173
```

The dev server talks to the already-deployed testnet contract above by
default — no `.env` or config needed to try it. To point it at your own
deployment, edit `CONTRACT_ID` in `frontend/src/config.ts`.

**Try it:** open the app, click "Connect wallet" → pick Bitte, Here, or
Meteor Wallet (each can create a free testnet wallet if you don't have one),
then create a stream to any other testnet account and watch the "unlocked"
amount tick upward live. To see the circuit breaker: fill in the optional
"Verifier account id" + "Heartbeat window" fields with a third account, then
just don't attest — watch the stream card flip to "stalled — accrual frozen"
once the window lapses, and sign in as the verifier to send an `attest` and
watch it release.

## Setup — the autonomous watchdog (the main demo)

Needs a verifier account you control in near CLI's keychain (any testnet account
other than the stream's receiver).

```bash
cd agent
npm install
npm test                                        # 9 tests: delivery check + guardian rule
node keygen.mjs <verifier>.testnet <contract-id>  # writes .env (gitignored), prints a command
# run the printed `near account add-key ... grant-function-call-access ...` command
#   -> registers the key as attest-only on that one contract
```

Create a stream with that verifier (UI or CLI; use a heartbeat of ~20s), put
its id in `agent/.env` as `STREAM_ID=`, then in two terminals:

```bash
npm run worker      # the paid service
npm run watchdog    # the autonomous verifier
```

**Do → See:**
- Watch the stream in the frontend → "verified & streaming", with a live
  "payout freezes in Ns" countdown that keeps resetting.
- `curl -X POST localhost:8787/stall` → the watchdog prints `✗ not attesting:
  stale work`; within the heartbeat window the card flips to **"stalled —
  accrual frozen"** and the unlocked amount stops moving.
- `curl -X POST localhost:8787/resume` → `✓ attested`, the card goes back to
  streaming, and the amount jumps to the real elapsed value.
- Kill the worker with Ctrl-C → same freeze, from an outage instead of a stall.

**Add the guardian** (payer side). Generate a key, register it on the *sender*
account as cancel-only, and put it in `agent/.env`:

```bash
near account add-key <sender>.testnet grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id <contract-id> --function-names 'cancel' \
  use-manually-provided-public-key <guardian-public-key> network-config testnet sign-with-keychain send
# agent/.env: GUARDIAN_ACCOUNT_ID=<sender>.testnet  GUARDIAN_PRIVATE_KEY=ed25519:...  GRACE_SECONDS=15
GUARDIAN_STREAM_IDS=<stream-id> npm run guardian   # omit the filter to guard all of the sender's streams
```

- Stall the worker and don't resume → the guardian logs `… frozen Ns`, then
  `✓ cancelled stream N … unverified funds returned`, and the card shows
  **closed** with only the verified amount paid out.

## Sustainability and roadmap

**Who pays for verification today:** each watchdog pays its own gas (~0.0013 NEAR per
attest, measured), and the payer runs the guardian. That's workable for a payer
protecting its own spend, but there's no built-in incentive for *independent* watchdogs
yet. The items below are **not built**; they're the path from hackathon project to
something that sustains itself.

- **Paid verification:** reserve a small, sender-chosen share of each stream for the
  watchdogs that attested, so k-of-n verification is a service operators are paid to run.
- **Stablecoin streams (NEP-141, e.g. USDC):** businesses budget in dollars; NEAR-only
  streams are fine for a demo but not for real procurement.
- **Rust contract port:** cut the ~13 Tgas attest cost several-fold, which makes
  minute-level heartbeats nearly free.
- **Mainnet:** the deploy script is ready and dry-run tested (`scripts/mainnet-setup.mjs`).

**What keeps the codebase maintainable:** the money math is isolated in pure functions
with unit tests, every on-chain claim is re-checkable with one command, and
`DECISIONS.md` records each non-obvious design call.

## Known limitations

- The live-ticking "withdrawable" number in the UI uses the browser's clock
  between chain reads, for a smooth display; the contract always recomputes
  from the real block timestamp on `withdraw`/`cancel`, so the UI number is a
  display estimate, never the source of truth (see comment in
  `frontend/src/main.ts`).
- The heartbeat freeze is a cancel-time safety cap, not a reduction of what's
  owed: a resumed attestation immediately releases the full real-elapsed
  amount rather than "catching up" gradually from the freeze point (see
  `DECISIONS.md`). There's no dispute/arbitration step beyond that — it's a
  binary attest/don't-attest signal, not a partial-quality score.
- **Gas economics:** each `attest` burns ~13 Tgas (≈0.0013 NEAR), since a
  JavaScript (QuickJS) contract is gas-heavy. The demo checks every 5s for
  visibility; real deployments would attest every 1–5 minutes (≈0.4–1.9
  NEAR/day per watchdog). A Rust port of the contract would cut that several-fold.
  Watchdog keys need a gas allowance sized for their runtime (`DECISIONS.md`).
- The watchdog can only verify what's observable from outside. A worker that
  fakes fresh, progressing output would fool it. The demo check is freshness +
  progress + format; real deployments would swap in a domain check (e.g.
  verifying an output against a known answer, or an oracle feed).
- The demo worker and watchdog run on one machine; in production they'd be
  operated by different parties (the watchdog by the payer or a neutral third
  party).
- The frontend uses FastNEAR's public testnet RPC: `rpc.testnet.near.org` is
  deprecated and rejects browser requests as of Nov 2026.
- Three wallet modules (Bitte, Here, Meteor) are wired up; Wallet Selector
  supports more, but none beyond that are configured for this demo.
- No storage-deposit accounting for a very large number of concurrent
  streams — out of scope for a hackathon demo.

## Disclosures

- All code in `contract/` and `frontend/` was written during the hackathon
  window (2026-11-13), via Claude Code (Anthropic). No pre-existing codebase
  or private template was used.
- The frontend was scaffolded from the public `npm create vite@latest --
  template vanilla-ts` starter; its demo boilerplate (counter, default
  styling) was removed and replaced entirely.
- Open-source libraries used, unmodified: `near-sdk-js`, `near-api-js`,
  `@near-js/transactions`,
  `@near-wallet-selector/{core,modal-ui,bitte-wallet,here-wallet,meteor-wallet}`,
  `typescript`, `vite`, `buffer`. No proprietary or paid services.

## License

MIT — see [`LICENSE`](./LICENSE).
