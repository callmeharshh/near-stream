// Payer-side agent: watches the payer's verifier-gated streams and cancels any whose
// payout has stayed frozen past a grace period, returning unverified funds to the
// payer with no human involved. Signs with a function-call access key scoped to
// `cancel` — which in this contract can only refund the sender and pay the receiver
// what was already verified, so a stolen guardian key can't redirect money.
import { Account, JsonRpcProvider } from "near-api-js";
import { shouldCancel, classifyError, nextDelayMs } from "./check.mjs";

const {
  GUARDIAN_ACCOUNT_ID,
  GUARDIAN_PRIVATE_KEY,
  CONTRACT_ID,
  RPC_URL = "https://test.rpc.fastnear.com",
  GRACE_SECONDS = "30",
  CHECK_INTERVAL_SECONDS = "5",
  GUARDIAN_STREAM_IDS = "", // optional comma list; empty = every stream this account sent
} = process.env;
const onlyIds = new Set(GUARDIAN_STREAM_IDS.split(",").filter(Boolean).map(Number));

for (const [name, value] of Object.entries({ GUARDIAN_ACCOUNT_ID, GUARDIAN_PRIVATE_KEY, CONTRACT_ID })) {
  if (!value) {
    console.error(`missing ${name} (see agent/.env)`);
    process.exit(1);
  }
}

const provider = new JsonRpcProvider({ url: RPC_URL });
const account = new Account(GUARDIAN_ACCOUNT_ID, RPC_URL, GUARDIAN_PRIVATE_KEY);
const grace = Number(GRACE_SECONDS);
const intervalMs = Number(CHECK_INTERVAL_SECONDS) * 1000;
const time = () => new Date().toISOString().slice(11, 19);
const lastReported = new Map();
const giveUp = new Set(); // streams that hit a permanent error (e.g. already closed)
let rpcFailures = 0;

async function tick() {
  const streams = (await provider.callFunction({ contractId: CONTRACT_ID, method: "list_streams", args: {} })) ?? [];
  for (const stream of streams) {
    if (onlyIds.size && !onlyIds.has(stream.id)) continue;
    if (giveUp.has(stream.id)) continue;
    const decision = shouldCancel(stream, GUARDIAN_ACCOUNT_ID, Date.now(), grace);
    if (!decision.cancel) {
      if (decision.frozenForS > 0 && lastReported.get(stream.id) !== decision.frozenForS) {
        lastReported.set(stream.id, decision.frozenForS);
        console.log(`${time()}  … stream ${stream.id} frozen ${decision.frozenForS}s (cancelling at ${grace}s)`);
      }
      continue;
    }
    try {
      const outcome = await account.callFunctionRaw({ contractId: CONTRACT_ID, methodName: "cancel", args: { stream_id: stream.id } });
      const hash = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? "?";
      console.log(`${time()}  ✓ cancelled stream ${stream.id} after ${decision.frozenForS}s frozen; unverified funds returned  tx ${hash}`);
    } catch (err) {
      const message = err.message.split("\n")[0];
      if (classifyError(err.message) === "permanent") {
        giveUp.add(stream.id);
        console.log(`${time()}  ■ not retrying stream ${stream.id}: ${message}`);
      } else {
        console.log(`${time()}  ! cancel failed for stream ${stream.id} (will retry): ${message}`);
      }
    }
  }
}

console.log(`guardian: protecting streams sent by ${GUARDIAN_ACCOUNT_ID}; cancels after ${grace}s frozen`);
for (;;) {
  const started = Date.now();
  try {
    await tick();
    rpcFailures = 0;
  } catch (err) {
    rpcFailures += 1;
    console.log(`${time()}  ! could not read streams (retrying in ${nextDelayMs(intervalMs, rpcFailures) / 1000}s): ${err.message.split("\n")[0]}`);
  }
  const delay = nextDelayMs(intervalMs, rpcFailures);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay - (Date.now() - started))));
}
