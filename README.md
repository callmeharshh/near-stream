# NEAR Stream

**Pay AI agents and APIs per second, only while they're verifiably delivering.**

Built at NEAR HACKATHON 2026 · Tracks: Real-World Money, Agent Economy,
Autonomous Business, AI Security & Defense · Runs on NEAR **testnet**.

| | |
|---|---|
| Live app (no install) | https://callmeharshh.github.io/near-stream/ |
| Verify every on-chain claim (read-only) | `npm run verify` → **26/26 PASS** ([what it checks](./EVIDENCE.md)) |
| Tests | `npm run install:all && npm test` → **22 passing** |
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
3. **Watchdog agents verify delivery.** Every few seconds a watchdog checks the
   paid service (is new, valid work being produced?) and, if so, calls `attest`
   on-chain. A stream can require **k of n** independent watchdogs (e.g. 2 of 3).
4. **No attestation → payout freezes.** If fewer than k watchdogs attest within
   the heartbeat window, the contract stops counting time. This catches the
   server going down *and* the server staying up but quietly producing nothing.
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

All on testnet, re-checked by `npm run verify`. Full transaction list in
[`EVIDENCE.md`](./EVIDENCE.md).

| Feature | Proof |
|---|---|
| Per-second streams: create, withdraw, cancel | balances reconciled across contract, sender, receiver |
| Freeze when attestations stop | stalled stream paid out exactly the frozen amount (0.025 of 0.5 NEAR) |
| Autonomous watchdog | attests on its own; stops when the service stalls; resumes when it recovers |
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
gives an agent a policy-bound wallet: budgets, allowed destinations, schedules, a
timelock, owner approval and an emergency freeze. In its documented policy we
found no rule for *"keep paying only while independent verifiers confirm the work
is still being delivered."* That conditional, per-second payment is what this
contract adds. The agents here only need to sign one method each, which a native
function-call key does without extra infrastructure. The Agent API is also a
mainnet-only beta; this project runs on testnet. It would fit well on the payer's
side (funding streams from an Agent API wallet), but that is **not built**.

## Try it

**No NEAR account needed:**
```bash
npm run install:all
npm test          # 22 unit tests (accrual, freeze, k-of-n, agent rules)
npm run verify    # re-checks 26 on-chain claims, read-only
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
contract/   smart contract (TypeScript, near-sdk-js); money math in stream-math.ts
agent/      watchdog.mjs  verifies a service, attests (attest-only key)
            guardian.mjs  cancels frozen streams (cancel-only key)
            worker.mjs    demo "paid service" you can stall or kill
            check.mjs     the delivery check + guardian rule (no LLM; unit-tested)
frontend/   web app (Vite + TypeScript), reads the contract directly; no backend
scripts/    verify-evidence.mjs (read-only verifier), mainnet-setup.mjs (deploy script)
```

## Honest limitations

- **Testnet only.** Mainnet needs ~7.5 NEAR (~5.7 of it storage deposit for the
  contract) that we didn't have.
  `scripts/mainnet-setup.mjs` deploys everything in one command and was dry-run on
  testnet (its transactions are in `evidence/` and verified).
- **Token streams were proven with wNEAR, not USDC.** We couldn't mint testnet
  USDC; the code is token-agnostic NEP-141, so USDC uses the same calls.
- **The watchdog only sees what's observable.** It checks that work is fresh,
  well-formed and progressing; a provider faking that output would fool it. Real
  use would plug in a domain-specific check.
- **Gas:** each `attest` costs ~0.0013 NEAR (JavaScript contracts are gas-heavy).
  The demo attests every 5s for visibility; real use would attest every few minutes.
- **Single-machine demo:** worker, watchdogs and guardian ran on one computer. In
  real use they'd be run by different parties.
- **A bug we found and fixed:** `withdraw` originally ignored cancellation, so after
  a healthy stream was cancelled the receiver could withdraw post-cancel accrual
  from pooled funds (testnet only, never exploited). Cancel now records
  `settledAt` and accrual never passes it; the verifier checks the fix.

## Roadmap (not built)

Paid verification (a share of each stream for the watchdogs that attested), a Rust
port of the contract to cut gas, mainnet with USDC, and Agent API wallets on the
payer side.

## Disclosures

Written during the hackathon (13–14 Nov 2026) with Claude Code (Anthropic); no
pre-existing code. The frontend started from the public Vite `vanilla-ts` template
(boilerplate removed). Open-source libraries, unmodified: near-sdk-js,
near-api-js, @near-js/transactions, @near-wallet-selector (core, modal-ui,
bitte-wallet, here-wallet, meteor-wallet), typescript, vite, buffer.

MIT License — see [`LICENSE`](./LICENSE).
