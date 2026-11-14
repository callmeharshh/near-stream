# Decisions and gotchas

Non-obvious calls made while building this, kept here instead of in code comments
scattered across files.

## The contract lives on its own dedicated account, not the sender's

Deploying to the same account as one of the two parties makes every balance check
during testing ambiguous — "sender's balance" and "escrowed funds" become the same
number. The contract is deployed to `near-stream-contract-1794591135.testnet`,
distinct from both `near-stream-sender-1794591135.testnet` and
`near-stream-receiver-1794591135.testnet`. This is also the architecturally correct
shape: an escrow contract should never be the same account as either counterparty.

## `cancel()` cannot return a joint (`.and()`) promise

NEAR's runtime rejects a function call whose *returned* promise is a joint
(`NearPromise.and()`) promise — confirmed by a failed live testnet transaction
(`ExecutionError("Returning joint promise is currently prohibited.")`), not from
reading the docs first. `cancel()` needs to pay out two different accounts (refund
to sender, remaining accrual to receiver). Fix: the refund to the sender is fired
via `NearPromise.build()` (scheduled on the transaction, but not part of the
function's return value), and only the payout to the receiver is `return`ed as the
single top-level promise. See `contract/src/index.ts`.

## TypeScript is pinned to 5.9.3, not the newest major

`near-sdk-js@2.0.0`'s build pipeline shells out to `tsc` with a hardcoded
`--moduleResolution node` flag for its pre-build typecheck. TypeScript 7 removed
`moduleResolution=node` (`node10`) entirely, so the build fails with `TS5108`
before any contract code is even considered. Pinning `contract/package.json`'s
`typescript` devDependency to `5.9.3` fixes it; this is an near-sdk-js/TypeScript
compatibility gap, not a bug in this contract.

## Apple Silicon needs Rosetta 2 for `near-sdk-js build`

`near-sdk-js`'s bundled WASI C toolchain (`node_modules/near-sdk-js/lib/cli/deps/wasi-sdk`)
ships x86_64-only binaries. On an arm64 Mac without Rosetta 2 installed, the build
fails with `bad CPU type in executable`. Installing Rosetta
(`softwareupdate --install-rosetta --agree-to-license`) resolves it; this is a
one-time, machine-level setup step, not something the project can work around.

## MyNearWallet dropped mid-hackathon; three wallet modules wired up instead

`@near-wallet-selector/my-near-wallet` was the first choice (no extension, redirect-
based, lowest friction for a first-time user) but manual testing on 2026-11-13
showed MyNearWallet now refuses new app connections entirely ("MyNearWallet is
being retired... choose another wallet"). Swapped to three modules instead of a
single replacement, since wallet availability for a brand-new testnet user is an
external, moving target during this event: `bitte-wallet` (redirect-based, no
extension — same low-friction shape MyNearWallet used to have), `here-wallet`
(mobile/QR), and `meteor-wallet` (extension, the wallet MyNearWallet's own
retirement notice pointed users toward). See `frontend/src/near.ts`.

## Bitte/Here/Meteor need Node globals Vite doesn't polyfill by default

Adding those three wallet modules threw, in order as each was fixed: `Cannot read
properties of undefined (reading 'from')` (needs `Buffer`), `global is not defined`,
then `process is not defined`. Vite 8 no longer auto-polyfills Node globals for
browser bundles. Fixed with a minimal manual shim in `frontend/src/polyfills.ts`
(imported first, before any near-wallet-selector module) rather than pulling in a
full polyfill plugin for three globals.

## The watchdog signs with a function-call access key, not a full-access key

The verifier agent runs unattended on a server, which makes its key the most
exposed secret in the system. It gets a NEAR function-call access key restricted to
`attest` on the stream contract only, with a 0.25 NEAR gas allowance. NEAR enforces
that scope itself. Tested on testnet: the key's attempts to transfer NEAR
(`Access key requires full access`), call `cancel`, or call any other contract are
all rejected by the chain. A stolen watchdog key can at worst keep a stream alive
that should freeze. It can never move money.

The verifier *account* still has a full-access key, but that key lives only in the
operator's local keychain and is never given to the watchdog. The watchdog host's
`.env` holds only the attest-only key. Deleting the full-access key would make the
account permanently unmanageable (no way to rotate the watchdog key); for a
production verifier you'd keep it on a hardware wallet. The verifier script checks
that every watchdog transaction was signed by the attest-only key specifically.

## k-of-n verification via one stored number

Multi-verifier streams store each verifier's latest attestation, but the stream's
`lastAttestedAt` is recomputed on every `attest` as the **k-th most recent**
attestation. Everything downstream (the freeze math, the guardian, the frontend
countdown, the evidence checks) already keys off `lastAttestedAt`, so k-of-n needed
no changes outside `create_stream`/`attest`. The value can only move forward, since
each verifier's own time only increases. Streams created before this upgrade have
a single `verifier` field and keep working as 1-of-1; the upgrade was deployed over
live state, and all 19 existing evidence checks still passed afterwards.

## Watchdog keys need a gas allowance sized for their runtime

A function-call key's allowance is spent by the gas its transactions burn, and each
`attest` on this JavaScript contract burns ~13 Tgas (≈0.0013 NEAR, measured). The
original 0.25 NEAR allowance would have run out after ~190 attests (~16 minutes at
5s checks). A stray watchdog left running against a closed stream had already spent
40% of it, which could have killed the demo mid-recording. The testnet watchdog key
was re-registered (same public key, same scope) with a 2 NEAR allowance; the mainnet
script uses 0.5 NEAR.

## Why `cancel` is safe to hand to an unattended agent

The guardian gets a function-call key for `cancel` on the payer's account. That's
safe because of how the contract defines `cancel`: it requires the caller to be the
stream's sender, pays the receiver only what was verified, and refunds the rest to
the sender. There's no parameter that can redirect funds. A stolen guardian key can
at worst end a stream early (the receiver still gets every verified second); it can
never move money to a third party. The guardian also can't *create* streams, and it
couldn't even if it were given that method: function-call keys can't attach NEAR
deposits, and `create_stream` is payable.

## The delivery check is deterministic; no LLM in the attest path

`agent/check.mjs` attests only on fresh, well-formed, progressing output. An LLM
judging work quality would be a natural extension, but putting a model directly in
the path that releases money adds a prompt-injection surface and a flaky external
dependency for a live demo. Business rules stay in plain code.

## Frontend RPC switched to FastNEAR

`rpc.testnet.near.org` began returning `429 ... THIS ENDPOINT IS DEPRECATED` and
failing browser CORS preflights on 2026-11-14, which made the frontend unable to
read any streams. Lava's testnet endpoint returns `410 discontinued`. Switched the
frontend and agent to `https://test.rpc.fastnear.com` (CORS `*`, verified working);
the wallet selector already defaults to FastNEAR for testnet.

## The heartbeat freeze is a cap, not a true pause

When a verifier-gated stream's heartbeat lapses, `accruedAmount` clamps the
*effective* clock to `lastAttestedAt + heartbeatSeconds` instead of continuing to
the real time (`contract/src/stream-math.ts`). The alternative — tracking
cumulative paused duration so the stream's finish line itself shifts forward by
however long it was stalled — is arguably more "correct" (the receiver wouldn't get
backdated credit for unverified time) but needs extra state and more edge cases for
a feature that has to be built, tested, and verified live in the hours available.
The chosen semantics: the cap is a **cancel-time safety guarantee** for the sender
(money beyond the frozen point is never at risk while unverified, confirmed live on
testnet — see README's "stalled stream" cancel transaction), not a permanent
reduction of what the receiver is owed. The instant a fresh attestation arrives, the
real elapsed amount releases immediately rather than ticking back up gradually. This
is simpler and still gives the core value (the payer is never exposed to paying for
unverified time), it just doesn't also penalize the receiver's eventual total.
