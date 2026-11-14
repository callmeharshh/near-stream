// Read-only re-check of every on-chain claim in the README. Sends nothing, signs
// nothing. Prints PASS/FAIL per check and exits non-zero if any check fails.
//   node scripts/verify-evidence.mjs
const RPC = process.env.RPC_URL ?? "https://test.rpc.fastnear.com";
const CONTRACT = "near-stream-contract-1794591135.testnet";
const SENDER = "near-stream-sender-1794591135.testnet";
const RECEIVER = "near-stream-receiver-1794591135.testnet";
const VERIFIER = "near-stream-verifier-1794591135.testnet";
const WATCHDOG_KEY = "ed25519:7f5SKkkXzjvvsNbVc2wws62QFkpQHTHbgAyPuytcXbUg";
const GUARDIAN_KEY = "ed25519:ByaLcyWJrG6qrNiAicC7jjW6NZHVd1EuDNhAFcbdxnwU";
const GUARDIAN_CANCEL_TX = "4pq5Hmd2WCvWhjU9xGWafmxHTjiozd5518oBsUFF49D4";

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

check("guardian key is scoped on-chain: FunctionCall, `cancel` only, this contract only", async () => {
  const key = await rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: SENDER,
    public_key: GUARDIAN_KEY,
  });
  const fc = key.permission?.FunctionCall;
  return Boolean(fc) && fc.receiver_id === CONTRACT && fc.method_names.length === 1 && fc.method_names[0] === "cancel";
});

check("guardian auto-cancel of frozen stream 8 succeeded AND was signed by the cancel-only key", async () => {
  const t = await tx(GUARDIAN_CANCEL_TX, SENDER);
  return succeeded(t) && t.transaction.public_key === GUARDIAN_KEY && t.transaction.actions[0]?.FunctionCall?.method_name === "cancel";
});

check("stream 8 closed with the receiver paid only for verified time (rest auto-refunded)", async () => {
  const s = await view("get_stream", { stream_id: 8 });
  return s.closed && BigInt(s.withdrawn) > 0n && BigInt(s.withdrawn) < BigInt(s.totalAmount) / 10n;
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

check("stream 9 is gated 2-of-3 on three distinct verifiers, each with its own attest-only key", async () => {
  const s = await view("get_stream", { stream_id: 9 });
  if (s.threshold !== 2 || s.verifiers.length !== 3 || new Set(s.verifiers).size !== 3) return false;
  for (const account_id of s.verifiers) {
    const { keys } = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id });
    const scoped = keys.some((k) => {
      const fc = k.access_key.permission?.FunctionCall;
      return fc && fc.receiver_id === CONTRACT && fc.method_names.length === 1 && fc.method_names[0] === "attest";
    });
    if (!scoped) return false;
  }
  return true;
});

check("2-of-3: a lone watchdog's successful attest did NOT keep stream 9 paid (effective attestation stayed older)", async () => {
  const LONE_ATTEST = "FxVsiwXa8MNGekgBWBy1tipv4qrD2DddJ8URTkhWSbe3"; // verifier A, after B and C were stopped
  const t = await tx(LONE_ATTEST, VERIFIER);
  const block = await rpc("block", { block_id: t.transaction_outcome.block_hash });
  const attestedAtNs = BigInt(block.header.timestamp_nanosec);
  const s = await view("get_stream", { stream_id: 9 });
  const deadlineNs = BigInt(s.lastAttestedAt) + BigInt(s.heartbeatSeconds) * 1_000_000_000n;
  return succeeded(t) && t.transaction.actions[0]?.FunctionCall?.method_name === "attest" && deadlineNs < attestedAtNs;
});

check("mainnet deploy script's DRY_RUN on testnet: every recorded tx succeeded (evidence/mainnet-script-dryrun-testnet.json)", async () => {
  const { readFileSync } = await import("node:fs");
  const file = new URL("../evidence/mainnet-script-dryrun-testnet.json", import.meta.url);
  const dry = JSON.parse(readFileSync(file, "utf8"));
  const signers = Object.values(dry.accounts);
  for (const { tx: hash } of dry.steps) {
    let found = false;
    for (const sender of signers) {
      try {
        if (succeeded(await tx(hash, sender))) {
          found = true;
          break;
        }
      } catch {
        // wrong sender for this tx; try the next one
      }
    }
    if (!found) return false;
  }
  return dry.steps.length > 0;
});

check("withdraw-after-cancel fix: cancelled stream 2 reports nothing withdrawable", async () => {
  const s = await view("get_stream", { stream_id: 2 });
  return s.closed && s.withdrawable === "0";
});

check("NEP-141 stream 10 was created by ft_transfer_call on wrap.testnet", async () => {
  const t = await tx("GfbgZCLa3a9vXvS2BQokPdpaNa39jFpoNWi51Qtt7we5", SENDER);
  const s = await view("get_stream", { stream_id: 10 });
  return succeeded(t) && t.transaction.receiver_id === "wrap.testnet" && s.token === "wrap.testnet" && BigInt(s.totalAmount) === 10n ** 23n;
});

check("token stream 10: receiver withdrew in wNEAR, then the guardian auto-cancelled it (cancel-only key)", async () => {
  const w = await tx("6qUDfArfVn3mp5CNNQ3sY5txiLQxe8JgE2E8rxVBTdKx", RECEIVER);
  const c = await tx("DWsicM5hsh58gfMx8jSZbWy5YrG2ihQPkfJVUezwKyG1", SENDER);
  const s = await view("get_stream", { stream_id: 10 });
  return succeeded(w) && succeeded(c) && c.transaction.public_key === GUARDIAN_KEY && s.closed && Boolean(s.settledAt) && s.withdrawable === "0";
});

check("token solvency: contract holds at least what its open wNEAR streams still owe", async () => {
  const streams = await view("list_streams", {});
  const owed = streams
    .filter((s) => s.token === "wrap.testnet")
    .reduce((sum, s) => sum + (s.closed ? 0n : BigInt(s.totalAmount) - BigInt(s.withdrawn)) + BigInt(s.refundOwed ?? "0"), 0n);
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: "wrap.testnet",
    method_name: "ft_balance_of",
    args_base64: Buffer.from(JSON.stringify({ account_id: CONTRACT })).toString("base64"),
  });
  return BigInt(JSON.parse(Buffer.from(result.result).toString())) >= owed;
});

check("verified-time accounting (stream 12): a 45s outage was NOT paid; payout = verified time only", async () => {
  const created = await tx("47hURAZRoq6o7fZjizzpdkN1dZKXZeVpyQtnaGmVa2J5", SENDER);
  const cancelled = await tx("4STyBK5mQVZCXgMCr84k47zyCbUdGGSWJDJvS6jZ41Jv", SENDER);
  const s = await view("get_stream", { stream_id: 12 });
  const wallNanos = BigInt(s.settledAt) - BigInt(s.startTime);
  const verified = BigInt(s.verifiedNanos);
  const expectedPaid = (BigInt(s.totalAmount) * verified) / (BigInt(s.durationSeconds) * 1_000_000_000n);
  return (
    succeeded(created) &&
    succeeded(cancelled) &&
    s.closed &&
    verified + 45_000_000_000n < wallNanos && // at least the outage was excluded
    BigInt(s.withdrawn) === expectedPaid
  );
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
