// One complete, team-run payment loop on NEAR testnet, reconciled from transaction receipts.
//
//   node scripts/full-loop.mjs        (needs the testnet keys in the near-cli keychain + agent/.env)
//
// Disclosure: every account here is run by the NEAR Stream team. The "operator" runs the
// RPC wrapper (agent/worker.mjs) and receives the money; the "consumer" pays for it and reads
// data from it. The wrapper proxies FastNEAR's public testnet RPC; FastNEAR is not a party and
// is not paid. No external customer is involved.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RPC = "https://test.rpc.fastnear.com";
const CONTRACT = "near-stream-contract-1794591135.testnet";
const CONSUMER = "near-stream-sender-1794591135.testnet";
const OPERATOR = "near-stream-receiver-1794591135.testnet";
const VERIFIER = "near-stream-verifier-1794591135.testnet";
const PORT = 8788;
const WRAPPER = `http://localhost:${PORT}/work`;
const TOTAL = "0.3", DURATION = 300, HEARTBEAT = 15;

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${msg}`);

async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}
const getStream = async (id) => {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: "get_stream",
    args_base64: Buffer.from(JSON.stringify({ stream_id: id })).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};

// Signs with the account's key from the near-cli keychain; returns { tx, output }.
function call(signer, method, args, deposit = "0 NEAR") {
  const r = spawnSync("near", ["contract", "call-function", "as-transaction", CONTRACT, method, "json-args", JSON.stringify(args),
    "prepaid-gas", "150 Tgas", "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-keychain", "send"], { encoding: "utf8" });
  const output = r.stdout + r.stderr;
  const tx = output.match(/Transaction ID: (\w+)/)?.[1];
  if (r.status !== 0 || !tx) throw new Error(`${method} failed:\n${output}`);
  return { tx, output };
}

const procs = [];
function run(name, script, env) {
  const p = spawn(process.execPath, ["--env-file=.env", script], { cwd: ROOT + "agent", env: { ...process.env, ...env } });
  const lines = [];
  p.stdout.on("data", (d) => lines.push(...d.toString().trim().split("\n")));
  p.stderr.on("data", (d) => lines.push(...d.toString().trim().split("\n")));
  procs.push(p);
  return lines;
}
process.on("exit", () => procs.forEach((p) => p.kill()));

// Transfers the contract sent in a transaction, from its receipts (only successful ones count).
async function transfersIn(tx, signer) {
  const t = await rpc("EXPERIMENTAL_tx_status", { tx_hash: tx, sender_account_id: signer, wait_until: "FINAL" });
  const ok = new Map(t.receipts_outcome.map((o) => [o.id, "SuccessValue" in o.outcome.status || "SuccessReceiptId" in o.outcome.status]));
  const logs = t.receipts_outcome.flatMap((o) => o.outcome.logs);
  const out = [];
  for (const r of t.receipts) {
    if (r.predecessor_id !== CONTRACT) continue;
    for (const a of r.receipt.Action?.actions ?? []) {
      if (a.Transfer) out.push({ to: r.receiver_id, yocto: a.Transfer.deposit, succeeded: ok.get(r.receipt_id) });
    }
  }
  return { out, logs };
}

// 1. The operator starts its RPC wrapper; the consumer starts using it.
const workerLog = run("worker", "worker.mjs", { WORKER_PORT: String(PORT) });
await sleep(3);
const consumed = [];
let consuming = true;
(async () => {
  while (consuming) {
    try {
      const block = await (await fetch(WRAPPER)).json();
      consumed.push({ atS: (Date.now() - t0) / 1000, height: block.height });
    } catch {}
    await sleep(2);
  }
})();

// 2. The consumer opens a stream to the operator, gated on the watchdog's attestations.
const created = call(CONSUMER, "create_stream", { receiver_id: OPERATOR, duration_seconds: DURATION, verifier_ids: [VERIFIER], threshold: 1, heartbeat_seconds: HEARTBEAT }, `${TOTAL} NEAR`);
const streamId = Number(created.output.match(/Stream (\d+) created/)[1]);
log(`stream ${streamId} created: ${CONSUMER} pays ${OPERATOR} ${TOTAL} NEAR over ${DURATION}s  tx ${created.tx}`);
const watchdogLog = run("watchdog", "watchdog.mjs", { STREAM_ID: String(streamId), WORKER_URL: WRAPPER, CHECK_INTERVAL_SECONDS: "5" });

// 3. Healthy service earns; the operator withdraws its earnings mid-stream.
await sleep(45);
const healthy = await getStream(streamId);
const withdrawal = call(OPERATOR, "withdraw", { stream_id: streamId });
log(`healthy: ${Number(healthy.verifiedNanos) / 1e9}s verified; operator withdrew  tx ${withdrawal.tx}`);
await sleep(10);

// 4. The service goes stale (still HTTP 200). New credit must stop.
await fetch(`http://localhost:${PORT}/stall`, { method: "POST" });
const stalledAtS = (Date.now() - t0) / 1000;
log("service stalled: still answering HTTP 200, but the data is stale");
await sleep(HEARTBEAT + 10);
const frozenA = await getStream(streamId);
await sleep(15);
const frozenB = await getStream(streamId);
log(`frozen: verified ${Number(frozenA.verifiedNanos) / 1e9}s → ${Number(frozenB.verifiedNanos) / 1e9}s over 15s of stale service`);

// 5. The consumer's guardian cancels; the operator keeps verified time, the rest is refunded.
const guardianLog = run("guardian", "guardian.mjs", { GUARDIAN_STREAM_IDS: String(streamId), GRACE_SECONDS: "5" });
let final;
for (let i = 0; i < 30 && !(final = await getStream(streamId)).closed; i++) await sleep(3);
consuming = false;
const cancelTx = guardianLog.join("\n").match(/cancelled stream \d+ .*tx (\w+)/)?.[1];
if (!final.closed || !cancelTx) throw new Error(`guardian did not cancel:\n${guardianLog.join("\n")}`);
log(`guardian cancelled  tx ${cancelTx}`);
await sleep(5);
final = await getStream(streamId);

// 6. Reconcile every coin from the receipts.
const w = await transfersIn(withdrawal.tx, OPERATOR);
const c = await transfersIn(cancelTx, CONSUMER);
const transfers = [...w.out, ...c.out];
const sum = (to) => transfers.filter((t) => t.to === to && t.succeeded).reduce((s, t) => s + BigInt(t.yocto), 0n);
const total = BigInt(final.totalAmount);
const paidOperator = sum(OPERATOR), refundedConsumer = sum(CONSUMER);
const verifiedOwed = (total * BigInt(final.verifiedNanos)) / (BigInt(DURATION) * 1_000_000_000n);
const beforeStall = consumed.filter((c) => c.atS < stalledAtS).map((c) => c.height);
const afterStall = consumed.filter((c) => c.atS > stalledAtS + 3).map((c) => c.height);

const checks = {
  "consumer read fresh, advancing blocks from the wrapper while healthy": new Set(beforeStall).size > 5,
  "consumer got only stale data after the stall": afterStall.length > 0 && new Set(afterStall).size === 1,
  "operator earned and withdrew during healthy service": BigInt(healthy.verifiedNanos) > 0n && w.out.some((t) => t.to === OPERATOR && t.succeeded),
  "no new credit while the service was stale": frozenA.verifiedNanos === frozenB.verifiedNanos,
  "all payouts succeeded (no rollback)": transfers.every((t) => t.succeeded) && ![...w.logs, ...c.logs].some((l) => l.includes("failed")),
  "operator was paid exactly the verified time": paidOperator === BigInt(final.withdrawn) && paidOperator === verifiedOwed,
  "paid to operator + refunded to consumer = deposit": paidOperator + refundedConsumer === total,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);

const fmt = (y) => `${(Number(y) / 1e24).toFixed(6)} NEAR`;
writeFileSync(`${ROOT}evidence/full-loop-testnet.json`, JSON.stringify({
  disclosure: "Team-run demonstration. Consumer, operator, watchdog and guardian accounts are all controlled by the NEAR Stream team. The wrapper proxies FastNEAR's public testnet RPC; FastNEAR was not paid and is not a party. No external customer.",
  network: "testnet", contract: CONTRACT, streamId,
  roles: { consumer: CONSUMER, operator: OPERATOR, watchdog: VERIFIER, guardianSignsAs: CONSUMER, wrapper: WRAPPER },
  txs: { create: created.tx, operatorWithdraw: withdrawal.tx, guardianCancel: cancelTx },
  verifiedSeconds: { atWithdraw: Number(healthy.verifiedNanos) / 1e9, stallPlus25s: Number(frozenA.verifiedNanos) / 1e9, stallPlus40s: Number(frozenB.verifiedNanos) / 1e9, final: Number(final.verifiedNanos) / 1e9 },
  money: { deposit: fmt(total), paidToOperator: fmt(paidOperator), refundedToConsumer: fmt(refundedConsumer),
    yocto: { deposit: total.toString(), paidToOperator: paidOperator.toString(), refundedToConsumer: refundedConsumer.toString() } },
  transfers,
  consumer: { requests: consumed.length, distinctBlocksBeforeStall: new Set(beforeStall).size, distinctBlocksAfterStall: new Set(afterStall).size, stalledAtS },
  checks,
  logs: { worker: workerLog.slice(-5), watchdog: watchdogLog.slice(-8), guardian: guardianLog.slice(-4) },
}, null, 2) + "\n");
console.log(`\nevidence/full-loop-testnet.json written`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
