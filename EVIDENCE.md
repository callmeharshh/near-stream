# Evidence

Every row below is a real NEAR **testnet** transaction or on-chain read.
`npm run verify` (`scripts/verify-evidence.mjs`) re-checks all of it read-only and
checks properties, not just existence (e.g. which key signed a tx, exact payout
amounts, that a frozen stream stays frozen). Last run: **27/27 PASS**.

Contract: [`near-stream-contract-1794591135.testnet`](https://explorer.testnet.near.org/accounts/near-stream-contract-1794591135.testnet)

## Core stream lifecycle (native NEAR)

| What | Transaction |
|---|---|
| `create_stream` (0.2 NEAR over 30s) | [`56GLoZrM64...`](https://explorer.testnet.near.org/transactions/56GLoZrM64ppufo65en5xU58uVB7eZ2Dge57BSv4Jz3a) |
| `withdraw` (partial, ~12s in) | [`xrrEZ8a9AS...`](https://explorer.testnet.near.org/transactions/xrrEZ8a9ASQeFxnm2L31VC5aMihXwkqF1Fu1rAba4MV) |
| `cancel` (splits accrued vs. refund) | [`6AQ7u1TBWk...`](https://explorer.testnet.near.org/transactions/6AQ7u1TBWkXviBJyNk1bB6wFxuaobEzzVtbPzry6qgwn) |
| `create_stream` with a verifier + 8s heartbeat | [`3KKJjtGZor...`](https://explorer.testnet.near.org/transactions/3KKJjtGZorNT2TRRDuGJAcy8X5NmfuWz7StahZF69C8H) |
| `attest` by the verifier (a non-verifier was rejected) | [`BpPdVRPkMw...`](https://explorer.testnet.near.org/transactions/BpPdVRPkMw6CYE5fti6EkJS2PRt5ijtFZCdAwEp46TFy) |
| `cancel` on a **stalled** stream: receiver got only the frozen 5s amount (0.025 of 0.5 NEAR), sender got 0.475 back, although ~20s of real time had passed with no attestation | [`5wUiwTkQ3e...`](https://explorer.testnet.near.org/transactions/5wUiwTkQ3estn7PpdQbH6aXUu5xTQLjiFogjPJ2X5L98) |

## Verified-time accounting (stream 12, created after the upgrade)

| What | Evidence |
|---|---|
| Stream created (1 NEAR over 1000s, 15s heartbeat); before any attestation: **0 payable** after 18s | [`47hURAZRoq...`](https://explorer.testnet.near.org/transactions/47hURAZRoq6o7fZjizzpdkN1dZKXZeVpyQtnaGmVa2J5) |
| Watchdog verified live NEAR blocks against a reference RPC and attested | e.g. [`42xppiabtT...`](https://explorer.testnet.near.org/transactions/42xppiabtTQ3DxLtYaQ9WjtEBfEyHFdYBoe5YPDSJwwW) |
| 45s outage (stale data, HTTP 200) → rejected as stale; after recovery payout continued from where it stopped | watchdog log + `get_stream` reads |
| Forged block hash → rejected (`doesn't match the reference`) | watchdog log |
| Settled: 166s wall-clock, **64.1s verified**, provider paid **0.0641 NEAR** (= exactly verified time × rate) | [`4STyBK5mQV...`](https://explorer.testnet.near.org/transactions/4STyBK5mQVZCXgMCr84k47zyCbUdGGSWJDJvS6jZ41Jv) |

Streams 0–11 below predate this upgrade and use the earlier clock-based model.

## Watchdog agent (attest-only key)

| What | Evidence |
|---|---|
| Key registered on the verifier: `attest` only, this contract only | [`Fbq7a2aYNo...`](https://explorer.testnet.near.org/transactions/Fbq7a2aYNoQ5fWQBnhh3xxc1PpJxyycGoLP26gRUNywc) |
| Watchdog attesting on its own | [`59MdeFRME5...`](https://explorer.testnet.near.org/transactions/59MdeFRME5GXgLb5WQzYn4USzSRhnrFSZFHS6V7JNsGD), [`2HtMF5s9WY...`](https://explorer.testnet.near.org/transactions/2HtMF5s9WYvgbmJn5wTZn4UCvcpMrXmwJySTEJt87Wna) |
| Worker stalled (still answering HTTP 200) → watchdog stopped attesting → `withdrawable` identical in two reads 8s apart | watchdog log + `get_stream` reads |
| Worker resumed → watchdog attested → payout resumed | [`CTtAbSqAHP...`](https://explorer.testnet.near.org/transactions/CTtAbSqAHPRxkh3ZHY5d2zFb7oLFCmhvYeEMkKXEVnQS) |
| Same key tries to transfer NEAR / call `cancel` / call another contract | all rejected by the protocol (`Access key requires full access`, `does not allow method cancel`, `receiver ... does not match`) |

## Guardian agent (cancel-only key)

| What | Evidence |
|---|---|
| Stream 8: stalled → payout froze → **guardian cancelled 19s into the freeze**. Receiver kept 0.0143 NEAR (43s verified); 0.1857 NEAR returned to the payer | [`4pq5Hmd2WC...`](https://explorer.testnet.near.org/transactions/4pq5Hmd2WCvWhjU9xGWafmxHTjiozd5518oBsUFF49D4), signed by the cancel-only key |
| Same key tries to transfer NEAR / call `withdraw` / call `create_stream` | all rejected by the protocol |

## k-of-n watchdogs (stream 9: 2 of 3)

| What | Evidence |
|---|---|
| Stream gated on three verifier accounts, each with its own attest-only key | [`8km39Ea36D...`](https://explorer.testnet.near.org/transactions/8km39Ea36DyVkEmMksLnnrps2YBRk95FP9E3xquqgRJN) |
| All three attesting | [`JAE3whzjg5...`](https://explorer.testnet.near.org/transactions/JAE3whzjg5VgBEem7xL9T8wa7PjuRzFuthYcnhduLCFt), [`39BQq8EibG...`](https://explorer.testnet.near.org/transactions/39BQq8EibGuDLdRnS29z91zYHMWYRmpqCfef3SSeSv6c), [`6wxpKF8eEy...`](https://explorer.testnet.near.org/transactions/6wxpKF8eEy2drqC35rwC7AJ35DteUhWsi6yZuSdTKbwG) |
| Killed one watchdog → payment kept flowing (0.00967 → 0.01067 NEAR) | `get_stream` reads |
| Killed a second → froze, although the third kept attesting successfully | [`FxVsiwXa8M...`](https://explorer.testnet.near.org/transactions/FxVsiwXa8MNGekgBWBy1tipv4qrD2DddJ8URTkhWSbe3) landed after the effective deadline (checked by the verifier) |

## Token stream (NEP-141, `wrap.testnet`)

| What | Evidence |
|---|---|
| Stream 10 created via `ft_transfer_call` (0.1 wNEAR, verifier-gated) | [`GfbgZCLa3a...`](https://explorer.testnet.near.org/transactions/GfbgZCLa3a9vXvS2BQokPdpaNa39jFpoNWi51Qtt7we5) |
| Receiver withdrew 0.026667 wNEAR | [`6qUDfArfVn...`](https://explorer.testnet.near.org/transactions/6qUDfArfVn3mp5CNNQ3sY5txiLQxe8JgE2E8rxVBTdKx) |
| Stalled → guardian auto-cancelled: receiver +0.041667, sender refunded 0.031667. 0.026667 + 0.041667 + 0.031667 = exactly 0.1 | [`DWsicM5hsh...`](https://explorer.testnet.near.org/transactions/DWsicM5hsh58gfMx8jSZbWy5YrG2ihQPkfJVUezwKyG1) |
| Payout to an unregistered receiver failed → rolled back → succeeded after registration | integration test on the dry-run contract (see `DECISIONS.md`) |
| Contract's wNEAR balance covers all open token streams | checked by the verifier |

## Mainnet deploy script, dry run on testnet

`DRY_RUN=1 node scripts/mainnet-setup.mjs deploy` broadcasts the identical mainnet flow
to testnet. Its 13 transactions are in
[`evidence/mainnet-script-dryrun-testnet.json`](./evidence/mainnet-script-dryrun-testnet.json),
all re-checked by the verifier.
