// Autonomous verifier: polls the paid service and calls `attest` on the stream
// contract only while the service is verifiably delivering. Signs with a
// function-call access key scoped to `attest` — if this process or its host is
// compromised, the key still cannot move funds.
import { Account } from "near-api-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { checkDelivery, classifyError, nextDelayMs } from "./check.mjs";

const {
  NEAR_ACCOUNT_ID,
  NEAR_PRIVATE_KEY,
  CONTRACT_ID,
  RPC_URL = "https://test.rpc.fastnear.com",
  WORKER_URL = "http://localhost:8787/work",
  CHECK_INTERVAL_SECONDS = "5",
  STREAM_ID,
  // independent endpoint used to check that the service's data is real
  REFERENCE_RPC = "https://archival-rpc.testnet.fastnear.com",
} = process.env;

for (const [name, value] of Object.entries({ NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY, CONTRACT_ID, STREAM_ID })) {
  if (!value) {
    console.error(`missing ${name} (see agent/.env, created by keygen.mjs)`);
    process.exit(1);
  }
}

const intervalMs = Number(CHECK_INTERVAL_SECONDS) * 1000;
const maxStalenessMs = Math.max(15_000, intervalMs * 2); // finalized blocks lag the head by a few seconds
const streamId = Number(STREAM_ID);
const account = new Account(NEAR_ACCOUNT_ID, RPC_URL, NEAR_PRIVATE_KEY);
// Last attested height, persisted so a restart can't be used to replay older data.
const STATE_DIR = new URL("./.watchdog-state/", import.meta.url);
const stateFile = new URL(`${NEAR_ACCOUNT_ID}-${CONTRACT_ID}-${STREAM_ID}.json`, STATE_DIR);
let lastHeight = null;
try {
  lastHeight = JSON.parse(readFileSync(stateFile, "utf8")).lastHeight ?? null;
} catch {
  // first run for this stream
}
const saveHeight = (h) => {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ lastHeight: h }));
};

async function referenceBlock(height) {
  try {
    const res = await fetch(REFERENCE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { block_id: height } }),
      signal: AbortSignal.timeout(4000),
    });
    const header = (await res.json()).result?.header;
    return header ? { hash: header.hash, timestampNanos: header.timestamp_nanosec } : null;
  } catch {
    return null;
  }
}

const time = () => new Date().toISOString().slice(11, 19);

async function tick() {
  let body = null;
  try {
    const res = await fetch(WORKER_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) body = await res.json();
  } catch {
    // unreachable worker is just a failed check
  }

  const reference = Number.isInteger(body?.height) ? await referenceBlock(body.height) : null;
  // DISHONEST=1 simulates a compromised/bribed watchdog that attests no matter what. It
  // exists only to demonstrate that k-of-n quorum stops one bad verifier from paying.
  const verdict = process.env.DISHONEST === "1"
    ? { ok: true, reason: "DISHONEST: attesting without checking" }
    : checkDelivery(body, reference, Date.now(), lastHeight, maxStalenessMs);
  if (!verdict.ok) {
    console.log(`${time()}  ✗ not attesting: ${body ? verdict.reason : "service unreachable"}`);
    return;
  }
  if (process.env.DISHONEST !== "1") {
    lastHeight = body.height;
    saveHeight(lastHeight);
  }

  try {
    const outcome = await account.callFunctionRaw({
      contractId: CONTRACT_ID,
      methodName: "attest",
      args: { stream_id: streamId },
    });
    const hash = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? "?";
    console.log(`${time()}  ✓ attested stream ${streamId} (${verdict.reason})  tx ${hash}`);
    rpcFailures = 0;
  } catch (err) {
    const message = err.message.split("\n")[0];
    if (classifyError(err.message) === "permanent") {
      console.log(`${time()}  ■ stopping: ${message}`);
      process.exit(0);
    }
    rpcFailures += 1;
    console.log(`${time()}  ! attest failed (retrying in ${nextDelayMs(intervalMs, rpcFailures) / 1000}s): ${message}`);
  }
}
let rpcFailures = 0;

console.log(`watchdog: verifying ${WORKER_URL} every ${CHECK_INTERVAL_SECONDS}s for stream ${streamId} as ${NEAR_ACCOUNT_ID}`);
// Sequential, not setInterval: overlapping ticks would sign two transactions with the
// same access key concurrently and collide on its nonce.
for (;;) {
  const started = Date.now();
  await tick();
  const delay = nextDelayMs(intervalMs, rpcFailures);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay - (Date.now() - started))));
}
