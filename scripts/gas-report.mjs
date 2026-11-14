// Gas actually paid on NEAR mainnet, read from transaction receipts (tokens_burnt),
// for every transaction in mainnet-evidence.json. Read-only.
//   node scripts/gas-report.mjs
import { readFileSync } from "node:fs";

const RPC = "https://rpc.mainnet.fastnear.com";
const evidence = JSON.parse(readFileSync(new URL("../mainnet-evidence.json", import.meta.url), "utf8"));
const signer = (step) =>
  /watchdog attest|attest-only watchdog key/.test(step) ? "verifier" : /guardian|create_stream/.test(step) ? "sender" : "contract";

async function tx(hash, sender) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" } }),
  });
  return (await res.json()).result;
}

const byKind = {};
for (const { step, tx: hash } of evidence.steps) {
  const t = await tx(hash, evidence.accounts[signer(step)]);
  const outcomes = [t.transaction_outcome, ...t.receipts_outcome];
  const burnt = outcomes.reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n);
  const gas = outcomes.reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
  const kind = step.replace(/\s*\(.*\)$/, "").replace(/ with [\d.]+ NEAR/, "");
  (byKind[kind] ??= []).push({ burnt, gas });
}

console.log("kind".padEnd(48), "count", "avg Tgas", "avg NEAR burnt");
for (const [kind, rows] of Object.entries(byKind)) {
  const avgBurnt = rows.reduce((s, r) => s + r.burnt, 0n) / BigInt(rows.length);
  const avgGas = rows.reduce((s, r) => s + r.gas, 0n) / BigInt(rows.length);
  console.log(kind.padEnd(48), String(rows.length).padStart(5), (Number(avgGas) / 1e12).toFixed(2).padStart(8), (Number(avgBurnt) / 1e24).toFixed(6).padStart(14));
}
