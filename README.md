# NEAR Stream

**Pay AI agents and APIs per second, only while they're verifiably delivering.**

Built at NEAR HACKATHON 2026 · Tracks: Real-World Money, Agent Economy,
Autonomous Business, AI Security & Defense · **Live on NEAR mainnet** (real NEAR) and testnet.

| | |
|---|---|
| **Mainnet contract** | [`85401b22…5d98`](https://explorer.near.org/accounts/85401b220a3d58edb6f98a7ddbc48598ee373314ae17ae1399f7cf2462c45d98): full agent flow ran with real NEAR ([transactions](./EVIDENCE.md#near-mainnet-real-near)) |
| Live app (testnet, no install) | https://callmeharshh.github.io/near-stream/ |
| Verify every on-chain claim (read-only) | `npm run verify` → **32/32 PASS** (incl. 5 mainnet checks) ([what it checks](./EVIDENCE.md)) |
| Tests | `npm run install:all && npm test` → **29 passing** (+5 Rust: `cd contract-rs && cargo test`) |
| All transactions | [`EVIDENCE.md`](./EVIDENCE.md) |
| Design decisions & gotchas | [`DECISIONS.md`](./DECISIONS.md) |

## The problem

When a business pays for ongoing work (an API, an AI agent, a contractor), it
either prepays and hopes, or pays later and argues. Nothing stops the money at
the moment the work stops, and with agents running 24/7, nobody is watching.

## What NEAR Stream does

1. **The payer locks funds** (NEAR or any NEP-141 token, e.g. USDC) in a stream
   to a receiver over a set duration.
2. **Money accrues per second.** The receiver can withdraw what has accrued at any
   time.
3. **Watchdog agents verify delivery.** In the demo the paid service is a **NEAR RPC
   data provider**. Every few seconds the watchdog fetches its latest block and calls
   `attest` on-chain only if the data is **correct** (block hash matches an
   independent reference RPC), **fresh** (recent, not future-dated) and **advancing**.
   A stream can require **k of n** independent watchdogs (e.g. 2 of 3).
4. **Only verified time is paid.** The contract pays for a stretch of time only if it
   lies between two consecutive quorum attestations no more than one heartbeat apart.
   Time before the first attestation and outages are **never** paid, even after the
   service recovers. This catches the service going down, serving stale data while
   still answering HTTP 200, and serving forged data.
5. **A guardian agent pulls the money back.** If a stream stays frozen past a
   grace period, the payer's guardian cancels it: the receiver keeps exactly what
   was verified, the rest is refunded.
6. **No agent key can steal.** Each agent signs with a NEAR **function-call
   access key** limited to one method on one contract: watchdogs can only
   `attest`, the guardian can only `cancel` (which only ever refunds the payer).

## How it compares

| | Pays for | Stops when the work stops? |
|---|---|---|
| Invoices / prepayment | a period or deliverable | no, you dispute later |
| Time-based streaming (e.g. Sablier, Superfluid) | elapsed time | no |
| Per-request payments (e.g. x402) | each call | per call; not built for continuous work |
| SLA escrows | refunds *after* an outage | no |
| **NEAR Stream** | **verified elapsed time** | **yes, within the heartbeat window** |

## What's built and verified

Re-checked by `npm run verify`. Full transaction list in [`EVIDENCE.md`](./EVIDENCE.md).

| Feature | Proof |
|---|---|
| **The whole loop on mainnet, with real NEAR** | watchdog verified real mainnet blocks and attested with its attest-only key → service stalled → guardian auto-cancelled with its cancel-only key; 120s wall-clock, 44.7s verified, only verified time paid; both keys' theft attempts rejected by mainnet |
| Per-second streams: create, withdraw, cancel | balances reconciled across contract, sender, receiver |
| **Only verified time is paid** | stream 12: 166s of wall-clock time, 64.1s verified → provider paid 0.0641 NEAR; a 45s outage and the pre-attestation start were excluded (the old clock model would have paid ~0.166) |
| Real service, checked for correctness | watchdog verified live NEAR blocks against a reference RPC; rejected stale data, a forged block hash, and future timestamps |
| Autonomous watchdog | attests on its own; stops when the service fails; resumes when it recovers |
| k-of-n watchdogs | 2-of-3 stream kept paying with one watchdog down, froze with two down |
| Guardian auto-cancel | cancelled a frozen stream with no human; refund returned to payer |
| Scoped agent keys | both agents' keys were rejected by the protocol when trying to transfer funds or call other methods |
| NEP-141 token streams | wNEAR stream: withdraw + guardian cancel; payouts sum to exactly the stream total |
| Failed token payouts roll back | payout to an unregistered receiver failed, stayed claimable, succeeded after registration |

## NEAR technology used

| Component | Where | Used for |
|---|---|---|
| Smart contract (near-sdk-js → WASM) | `contract/src/index.ts` | holds funds; accrual, freeze, k-of-n, cancel |
| Function-call access keys | `agent/watchdog.mjs`, `agent/guardian.mjs`, `scripts/mainnet-setup.mjs` | single-method, single-contract agent keys |
| NEP-141 fungible tokens | `ft_on_transfer` / `ft_transfer` in the contract | streams in USDC-standard tokens |
| Cross-contract promises + callback | `payout` / `on_payout` in the contract | token payouts with rollback on failure |
| NEAR Wallet Selector (Bitte, HERE, Meteor) | `frontend/src/near.ts` | signing in the web app |
| near-api-js + FastNEAR RPC | `frontend/`, `agent/`, `scripts/` | reads and transactions |

**Not used:** NEAR Intents/1Click, Chain Signatures, NEAR AI Cloud, the Agent API,
meta-transactions.

### Why not the Agent API?

The [Agent API](https://docs.agentsonintents.com/integration/agent-api/overview)
gives *one party's* agent a policy-bound wallet: budgets, allowed destinations,
schedules, a timelock, owner approval and an emergency freeze. In its documented
policy we found no rule that conditions payment on third-party verification. What
this contract adds:

1. **Payment conditioned on delivery evidence:** money accrues only for time covered
   by a quorum of independent attestations; unverified time is never payable.
2. **Escrow that protects both sides:** the provider can withdraw verified earnings
   at any time and the payer can't claw them back; the payer is guaranteed every
   unverified coin back. A spending policy on the payer's own wallet can't give the
   provider that guarantee.
3. **No extra custody:** each agent needs to sign exactly one method, which a native
   function-call key does on its own.

The Agent API is also a mainnet-only beta; this project runs on testnet. It would
fit on the payer's side (funding streams from an Agent API wallet); that is **not built**.

## Try it

**No NEAR account needed:**
```bash
npm run install:all
npm test          # 29 unit tests (verified-time accounting, k-of-n, delivery check, agents)
npm run verify    # re-checks 32 on-chain claims (testnet + mainnet), read-only
```
Or open the [live app](https://callmeharshh.github.io/near-stream/): it reads the
real contract; stream #6 keeps ticking until Nov 19.

**Run the agents yourself** (needs free testnet accounts from the NEAR faucet):
the step-by-step demo, including stalling the service and watching the freeze and
auto-cancel, is in [`DEMO.md`](./DEMO.md). Agent setup: `cd agent`,
`node keygen.mjs <verifier>.testnet <contract-id>` writes a gitignored `.env` and
prints the `near` command that registers the attest-only key; then
`npm run worker`, `npm run watchdog`, `npm run guardian`.

The contract builds with `cd contract && npm run build` (Apple Silicon needs
Rosetta 2; see `DECISIONS.md`).

## Architecture

```
contract/   smart contract (TypeScript, near-sdk-js; live on testnet); money math in stream-math.ts
contract-rs/ Rust port for mainnet (native-NEAR streams; 148 KB vs 556 KB of storage)
agent/      watchdog.mjs  verifies a service, attests (attest-only key)
            guardian.mjs  cancels frozen streams (cancel-only key)
            worker.mjs    the paid service: serves live NEAR block data; POST /stall, /tamper, /resume
            check.mjs     the delivery check + guardian rule (no LLM; unit-tested)
frontend/   web app (Vite + TypeScript), reads the contract directly; no backend
scripts/    verify-evidence.mjs (read-only verifier), mainnet-setup.mjs (deploy script)
```

## Honest limitations

- **Mainnet runs the Rust port, native NEAR only.** The JS contract would need ~5.6
  NEAR of storage on mainnet; the Rust port (`contract-rs/`) needs ~1.48, so mainnet
  uses it (deployed with `scripts/mainnet-setup.mjs`, rehearsed twice on testnet with
  exactly 1.85 NEAR first). Token (NEP-141) streams are only in the JS contract on
  testnet. The mainnet run used small amounts (a 0.05 NEAR stream).
- **Token streams were proven with wNEAR, not USDC.** We couldn't mint testnet
  USDC; the code is token-agnostic NEP-141, so USDC uses the same calls.
- **What the watchdog can verify is domain-specific.** For the demo's RPC service it
  checks correctness against a reference RPC. The reference is a separate FastNEAR
  endpoint, not a different company; real use should pick an independent provider.
- **Detection latency:** a failure is caught at the next check, so up to about one
  check interval (5s in the demo) can be paid after a failure starts.
- **Streams 0–11 on testnet use the earlier clock-based model** (an outage was paid
  after recovery). Verified-time accounting applies to streams created after the
  upgrade (stream 12 onward); the contract keeps old streams' recorded behavior.
- **Gas:** each `attest` costs ~0.0013 NEAR (JavaScript contracts are gas-heavy).
  The demo attests every 5s for visibility; real use would attest every few minutes.
- **Single-machine demo:** worker, watchdogs and guardian ran on one computer. In
  real use they'd be run by different parties.
- **A bug we found and fixed:** `withdraw` originally ignored cancellation, so after
  a healthy stream was cancelled the receiver could withdraw post-cancel accrual
  from pooled funds (testnet only, never exploited). Cancel now records
  `settledAt` and accrual never passes it; the verifier checks the fix.

## Roadmap (not built)

Paid verification (a share of each stream for the watchdogs that attested), token
(USDC) streams in the Rust contract so they can run on mainnet too, and Agent API
wallets on the payer side.

## Disclosures

Written during the hackathon (13–14 Nov 2026) with Claude Code (Anthropic); no
pre-existing code. The frontend started from the public Vite `vanilla-ts` template
(boilerplate removed). Open-source libraries, unmodified: near-sdk-js,
near-api-js, @near-js/transactions, @near-wallet-selector (core, modal-ui,
bitte-wallet, here-wallet, meteor-wallet), typescript, vite, buffer.

MIT License — see [`LICENSE`](./LICENSE).
