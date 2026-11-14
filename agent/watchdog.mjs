// Autonomous verifier: polls the paid service and calls `attest` on the stream
// contract only while the service is verifiably delivering. Signs with a
// function-call access key scoped to `attest` — if this process or its host is
// compromised, the key still cannot move funds.
import { Account } from "near-api-js";
import { checkDelivery } from "./check.mjs";

const {
  NEAR_ACCOUNT_ID,
  NEAR_PRIVATE_KEY,
  CONTRACT_ID,
  RPC_URL = "https://test.rpc.fastnear.com",
  WORKER_URL = "http://localhost:8787/work",
  CHECK_INTERVAL_SECONDS = "5",
  STREAM_ID,
} = process.env;

for (const [name, value] of Object.entries({ NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, CONTRACT_ID, STREAM_ID })) {
  if (!value) {
    console.error(`missing ${name} (see agent/.env, created by keygen.mjs)`);
    process.exit(1);
  }
}

const intervalMs = Number(CHECK_INTERVAL_SECONDS) * 1000;
const maxStalenessMs = intervalMs * 2;
const streamId = Number(STREAM_ID);
const account = new Account(NEAR_ACCOUNT_ID, RPC_URL, NEAR_PRIVATE_KEY);
let lastSequence = null;

const time = () => new Date().toISOString().slice(11, 19);

async function tick() {
  let body = null;
  try {
    const res = await fetch(WORKER_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) body = await res.json();
  } catch {
    // unreachable worker is just a failed check
  }

  const verdict = checkDelivery(body, Date.now(), lastSequence, maxStalenessMs);
  if (!verdict.ok) {
    console.log(`${time()}  ✗ not attesting: ${body ? verdict.reason : "worker unreachable"}`);
    return;
  }
  lastSequence = body.sequence;

  try {
    const outcome = await account.callFunctionRaw({
      contractId: CONTRACT_ID,
      methodName: "attest",
      args: { stream_id: streamId },
    });
    const hash = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? "?";
    console.log(`${time()}  ✓ attested stream ${streamId} (${verdict.reason})  tx ${hash}`);
  } catch (err) {
    console.log(`${time()}  ! attest failed: ${err.message.split("\n")[0]}`);
  }
}

console.log(`watchdog: verifying ${WORKER_URL} every ${CHECK_INTERVAL_SECONDS}s for stream ${streamId} as ${NEAR_ACCOUNT_ID}`);
// Sequential, not setInterval: overlapping ticks would sign two transactions with the
// same access key concurrently and collide on its nonce.
for (;;) {
  const started = Date.now();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - started))));
}
