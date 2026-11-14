# NEAR Stream — verified pay-per-second payments

Built for **NEAR HACKATHON 2026**, tracks: **Real-World Money**, **Agent
Economy**, **AI Security & Defense**.

Lump-sum payroll and invoicing require trust: the payer has to trust the payee
delivered before paying, or the payee has to trust the payer will pay at all.
NEAR Stream removes that by streaming NEAR continuously, second by second,
into a contract the receiver can withdraw from at any time, with the sender
always able to cancel and reclaim whatever hasn't streamed yet.

That alone is a known pattern (think Sablier/Superfluid, but on NEAR). The
part that doesn't exist elsewhere: **a stream can be gated on a verifier's
heartbeat.** Point this at an AI agent getting paid for ongoing work, or a
contractor on a retainer, and name a verifier (an oracle, a DAO vote, another
agent, anything that can sign a transaction) who must periodically attest the
work is still good. Stop delivering — the verifier stops attesting — and the
payout **freezes automatically**, no dispute process, no human in the loop.
Start delivering again and attestation releases the real elapsed amount
immediately. The sender can cancel at any moment and is guaranteed a refund of
everything beyond the last-attested-safe point — a real, enforced spending
circuit breaker for autonomous agents, not just a progress bar.

## How it works

1. A sender locks NEAR into the contract, naming a receiver and a duration.
2. **Optionally**, the sender also names a `verifier` and a `heartbeat`
   window. If set, the verifier must call `attest` at least that often.
3. The contract computes, on every call, how much has "unlocked": normally
   `totalAmount * elapsedSeconds / durationSeconds`; if a heartbeat is
   configured and has lapsed, elapsed time is capped at the last attestation's
   deadline instead of the real clock — the number simply stops growing.
4. The receiver can withdraw their unlocked balance at any time.
5. The sender can cancel at any time — the receiver is paid everything accrued
   (frozen amount included) up to that moment, and the sender gets the rest
   back, in the same transaction.

## Why NEAR

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
            directly over the public testnet RPC (no backend server)
```

- **Contract** (`contract/src/index.ts`): one `UnorderedMap<Stream>`, four
  `@call` methods (`create_stream`, `attest`, `withdraw`, `cancel`) and two
  `@view` methods (`get_stream`, `list_streams`). Accrual math — including the
  heartbeat-freeze logic — lives in `contract/src/stream-math.ts`, unit-tested
  (8 tests) in isolation from the SDK.
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

## Setup — contract

```bash
cd contract
npm install
npm test            # unit tests for the accrual + heartbeat-freeze math (8 tests)
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
- A stream has at most one verifier; no support for multi-party attestation
  (e.g. 2-of-3 oracles) in this version.
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
