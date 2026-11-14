// Read-only re-check of every on-chain claim in the README. Sends nothing, signs
// nothing. Prints PASS/FAIL per check and exits non-zero if any check fails.
//   node scripts/verify-evidence.mjs
const RPC = process.env.RPC_URL ?? "https://test.rpc.fastnear.com";
const CONTRACT = "near-stream-contract-1794591135.testnet";
const SENDER = "near-stream-sender-1794591135.testnet";
const RECEIVER = "near-stream-receiver-1794591135.testnet";
const VERIFIER = "near-stream-verifier-1794591135.testnet";
const WATCHDOG_KEY = "ed25519:7f5SKkkXzjvvsNbVc2wws62QFkpQHTHbgAyPuytcXbUg";

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(JSON.stringify(body.error).slice(0, 200));
  return body.result;
}

async function view(methodName, args) {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

const tx = (hash, sender) => rpc("tx", { tx_hash: hash, sender_account_id: sender, wait_until: "NONE" });
const succeeded = (t) => t.status && ("SuccessValue" in t.status || "SuccessReceiptId" in t.status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yocto = (near) => BigInt(Math.round(near * 1e6)) * 10n ** 18n;

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("contract code is deployed", async () => {
  const account = await rpc("query", { request_type: "view_account", finality: "final", account_id: CONTRACT });
  return account.code_hash !== "11111111111111111111111111111111";
});

for (const [label, hash, sender] of [
  ["create_stream", "56GLoZrM64ppufo65en5xU58uVB7eZ2Dge57BSv4Jz3a", SENDER],
  ["withdraw", "xrrEZ8a9ASQeFxnm2L31VC5aMihXwkqF1Fu1rAba4MV", RECEIVER],
  ["cancel (split)", "6AQ7u1TBWkXviBJyNk1bB6wFxuaobEzzVtbPzry6qgwn", SENDER],
  ["create_stream with verifier", "3KKJjtGZorNT2TRRDuGJAcy8X5NmfuWz7StahZF69C8H", SENDER],
  ["manual attest", "BpPdVRPkMw6CYE5fti6EkJS2PRt5ijtFZCdAwEp46TFy", VERIFIER],
  ["cancel on stalled stream", "5wUiwTkQ3estn7PpdQbH6aXUu5xTQLjiFogjPJ2X5L98", SENDER],
  ["register attest-only key", "Fbq7a2aYNoQ5fWQBnhh3xxc1PpJxyycGoLP26gRUNywc", VERIFIER],
  ["long-running live stream", "BNpaf5WQieKEmMotPzh9P9RwAgCf53jxVnsrmxQ4xvxL", SENDER],
]) {
  check(`tx succeeded: ${label}`, async () => succeeded(await tx(hash, sender)));
}

for (const hash of [
  "59MdeFRME5GXgLb5WQzYn4USzSRhnrFSZFHS6V7JNsGD",
  "2HtMF5s9WYvgbmJn5wTZn4UCvcpMrXmwJySTEJt87Wna",
  "CTtAbSqAHPRxkh3ZHY5d2zFb7oLFCmhvYeEMkKXEVnQS",
]) {
  check(`watchdog attest ${hash.slice(0, 8)}… succeeded AND was signed by the attest-only key`, async () => {
    const t = await tx(hash, VERIFIER);
    const action = t.transaction.actions[0]?.FunctionCall;
    return succeeded(t) && t.transaction.public_key === WATCHDOG_KEY && action?.method_name === "attest";
  });
}

check("watchdog key is scoped on-chain: FunctionCall, `attest` only, this contract only", async () => {
  const { keys } = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: VERIFIER });
  const perm = keys.find((k) => k.public_key === WATCHDOG_KEY)?.access_key.permission;
  const fc = perm?.FunctionCall;
  return Boolean(fc) && fc.receiver_id === CONTRACT && fc.method_names.length === 1 && fc.method_names[0] === "attest";
});

check("stalled-stream cancel paid the receiver only the frozen 5s cap (0.025 of 0.5 NEAR)", async () => {
  const s = await view("get_stream", { stream_id: 4 });
  return s.closed && BigInt(s.withdrawn) === yocto(0.025) && BigInt(s.totalAmount) === yocto(0.5);
});

check("stream 3 is permanently frozen below its total, long after its duration ended", async () => {
  const s = await view("get_stream", { stream_id: 3 });
  const durationEndedMs = Number(BigInt(s.startTime) / 1_000_000n) + Number(s.durationSeconds) * 1000;
  const unlocked = BigInt(s.withdrawn) + BigInt(s.withdrawable);
  return Date.now() > durationEndedMs && unlocked < BigInt(s.totalAmount);
});

check("ungated live stream 6 accrues in real time (two reads 4s apart)", async () => {
  const a = BigInt((await view("get_stream", { stream_id: 6 })).withdrawable);
  await sleep(4000);
  const b = BigInt((await view("get_stream", { stream_id: 6 })).withdrawable);
  return b > a;
});

let failed = 0;
for (const { name, fn } of checks) {
  let ok = false;
  let note = "";
  try {
    ok = await fn();
  } catch (err) {
    note = ` (${err.message})`;
  }
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed against ${RPC}`);
process.exit(failed ? 1 : 0);
