// Mainnet deployment of NEAR Stream. Keys live OUTSIDE the repo in
// ~/.near-stream-mainnet/keys.json (mode 600), so they can never be committed.
//
//   node scripts/mainnet-setup.mjs keys     -> create keys, print the address to fund
//   node scripts/mainnet-setup.mjs deploy   -> (after funding) deploy + set up accounts + create demo stream
//   node scripts/mainnet-setup.mjs cancel <stream_id>
//
// All accounts are NEAR implicit accounts (64-hex ids derived from their keys).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../agent/package.json"));
const { Account, KeyPair, JsonRpcProvider, parseNearAmount, formatNearAmount } = require("near-api-js");

// DRY_RUN=1 runs the identical flow on testnet with separate keys/evidence files.
const DRY_RUN = process.env.DRY_RUN === "1";
const RPC = DRY_RUN ? "https://test.rpc.fastnear.com" : "https://rpc.mainnet.fastnear.com";
const DIR = DRY_RUN && process.env.DRY_RUN_DIR ? process.env.DRY_RUN_DIR : join(homedir(), DRY_RUN ? ".near-stream-testnet-dryrun" : ".near-stream-mainnet");
const KEYS = join(DIR, "keys.json");
const EVIDENCE = DRY_RUN
  ? join(DIR, "evidence.json")
  : join(dirname(fileURLToPath(import.meta.url)), "../mainnet-evidence.json");
// The Rust build (contract-rs/) needs ~1.5 NEAR of storage vs ~5.6 for the JS one; same methods and JSON.
const WASM = process.env.WASM_PATH ?? join(dirname(fileURLToPath(import.meta.url)), "../contract-rs/target/near/near_stream.wasm");
// 1.85 = 1.51 deploy-time storage need + 0.23 for the accounts + ~0.1 buffer (measured on testnet)
const MIN_FUNDING = parseNearAmount(process.env.MIN_FUNDING_NEAR ?? "1.85");

// Per-account funding (NEAR), overridable via env; defaults are sized from the measured testnet rehearsal.
const FUND = {
  sender: process.env.FUND_SENDER ?? "0.16", // 0.05 stream + 0.1 gas reserve for the guardian's cancel
  verifier: process.env.FUND_VERIFIER ?? "0.06", // 0.03 gas reserve + ~0.000187 per attest
  receiver: process.env.FUND_RECEIVER ?? "0.01",
  watchdogAllowance: process.env.WATCHDOG_ALLOWANCE ?? "0.5",
  guardianAllowance: process.env.GUARDIAN_ALLOWANCE ?? "0.5",
};

async function keyExists(accountId, publicKey) {
  try {
    await new JsonRpcProvider({ url: RPC }).viewAccessKey({ accountId, publicKey });
    return true;
  } catch {
    return false;
  }
}

const implicitId = (kp) => Buffer.from(kp.getPublicKey().data).toString("hex");
const hashOf = (r) => r?.transaction?.hash ?? r?.transaction_outcome?.id ?? "?";

function loadKeys() {
  if (!existsSync(KEYS)) throw new Error("no keys yet — run: node scripts/mainnet-setup.mjs keys");
  return JSON.parse(readFileSync(KEYS, "utf8"));
}
const accountOf = (k) => new Account(k.accountId, RPC, k.secretKey);

function ensureGuardianKey(keys) {
  if (keys.guardian) return keys;
  const kp = KeyPair.fromRandom("ed25519");
  keys.guardian = { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() }; // added to the sender account
  writeFileSync(KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

function makeKeys() {
  if (existsSync(KEYS)) return ensureGuardianKey(loadKeys());
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const keys = {};
  for (const role of ["contract", "sender", "receiver", "verifier", "watchdog"]) {
    const kp = KeyPair.fromRandom("ed25519");
    keys[role] = { accountId: implicitId(kp), publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
  }
  delete keys.watchdog.accountId; // the watchdog key is added to the verifier account, not its own account
  writeFileSync(KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return ensureGuardianKey(keys);
}

async function balance(accountId) {
  const provider = new JsonRpcProvider({ url: RPC });
  try {
    const state = await provider.viewAccount({ accountId });
    return BigInt(state.amount);
  } catch {
    return 0n;
  }
}

function record(entry) {
  const log = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, "utf8")) : { network: DRY_RUN ? "testnet" : "mainnet", steps: [] };
  log.steps.push({ at: new Date().toISOString(), ...entry });
  writeFileSync(EVIDENCE, JSON.stringify(log, null, 2));
  console.log(`  ✓ ${entry.step}  ${entry.tx ?? ""}`);
}

const [command, arg] = process.argv.slice(2);

if (command === "keys") {
  const keys = makeKeys();
  const have = await balance(keys.contract.accountId);
  console.log(`Fund this mainnet address with ~7.5 NEAR (NEAR network only):\n\n  ${keys.contract.accountId}\n`);
  console.log(`Current balance: ${formatNearAmount(have.toString(), 4)} NEAR`);
} else if (command === "deploy") {
  const keys = makeKeys();
  const have = await balance(keys.contract.accountId);
  if (have < BigInt(MIN_FUNDING)) {
    console.error(`contract account has ${formatNearAmount(have.toString(), 4)} NEAR; needs >= ${formatNearAmount(MIN_FUNDING, 2)} NEAR. Not deploying.`);
    process.exit(1);
  }
  const contract = accountOf(keys.contract);
  const ids = Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, k.accountId]));
  if (!existsSync(EVIDENCE)) {
    writeFileSync(EVIDENCE, JSON.stringify({ network: DRY_RUN ? "testnet" : "mainnet", accounts: ids, watchdogKey: keys.watchdog.publicKey, guardianKey: keys.guardian.publicKey, steps: [] }, null, 2));
  }

  // Resumable: every step is skipped if already done, so a failed run can simply be re-run.
  // Deploy first so the contract's storage is locked before any funds go elsewhere.
  const deployed = await contract.deployContract(new Uint8Array(readFileSync(WASM)));
  record({ step: "deploy contract", tx: hashOf(deployed) });

  for (const [role, near] of [["sender", FUND.sender], ["verifier", FUND.verifier], ["receiver", FUND.receiver]]) {
    if ((await balance(keys[role].accountId)) >= BigInt(parseNearAmount(near))) continue;
    const r = await contract.transfer({ receiverId: keys[role].accountId, amount: parseNearAmount(near) });
    record({ step: `fund ${role} with ${near} NEAR`, tx: hashOf(r) });
  }

  if (!(await keyExists(keys.verifier.accountId, keys.watchdog.publicKey))) {
    const keyTx = await accountOf(keys.verifier).addFunctionCallAccessKey({
      publicKey: keys.watchdog.publicKey,
      contractId: keys.contract.accountId,
      methodNames: ["attest"],
      // allowance is checked against each call's full prepaid gas at a pessimistic price (~0.03 NEAR for 30 Tgas)
      allowance: parseNearAmount(FUND.watchdogAllowance),
    });
    record({ step: "register attest-only watchdog key on verifier", tx: hashOf(keyTx) });
  }

  if (!(await keyExists(keys.sender.accountId, keys.guardian.publicKey))) {
    const guardianKeyTx = await accountOf(keys.sender).addFunctionCallAccessKey({
      publicKey: keys.guardian.publicKey,
      contractId: keys.contract.accountId,
      methodNames: ["cancel"],
      allowance: parseNearAmount(FUND.guardianAllowance),
    });
    record({ step: "register cancel-only guardian key on sender", tx: hashOf(guardianKeyTx) });
  }

  const created = await accountOf(keys.sender).callFunctionRaw({
    contractId: keys.contract.accountId,
    methodName: "create_stream",
    args: { receiver_id: keys.receiver.accountId, duration_seconds: 3600, verifier_id: keys.verifier.accountId, heartbeat_seconds: 20 },
    deposit: parseNearAmount("0.05"),
  });
  record({ step: "create_stream 0.05 NEAR / 1h, verifier-gated, 20s heartbeat", tx: hashOf(created) });

  console.log(`\nWatchdog env for mainnet:\n  NEAR_ACCOUNT_ID=${keys.verifier.accountId}\n  CONTRACT_ID=${keys.contract.accountId}\n  RPC_URL=${RPC}\n  STREAM_ID=0`);
} else if (command === "watchdog") {
  // Runs agent/watchdog.mjs against this network, passing the scoped key via env only.
  const { spawn } = await import("node:child_process");
  const keys = loadKeys();
  const agentDir = join(dirname(fileURLToPath(import.meta.url)), "../agent");
  spawn(process.execPath, ["watchdog.mjs"], {
    cwd: agentDir,
    stdio: "inherit",
    env: {
      ...process.env,
      NEAR_ACCOUNT_ID: keys.verifier.accountId,
      NEAR_PRIVATE_KEY: keys.watchdog.secretKey,
      CONTRACT_ID: keys.contract.accountId,
      RPC_URL: RPC,
      STREAM_ID: arg ?? "0",
    },
  });
} else if (command === "guardian") {
  const { spawn } = await import("node:child_process");
  const keys = loadKeys();
  const agentDir = join(dirname(fileURLToPath(import.meta.url)), "../agent");
  spawn(process.execPath, ["guardian.mjs"], {
    cwd: agentDir,
    stdio: "inherit",
    env: {
      ...process.env,
      GUARDIAN_ACCOUNT_ID: keys.sender.accountId,
      GUARDIAN_PRIVATE_KEY: keys.guardian.secretKey,
      CONTRACT_ID: keys.contract.accountId,
      RPC_URL: RPC,
      GRACE_SECONDS: process.env.GRACE_SECONDS ?? "15",
    },
  });
} else if (command === "cancel") {
  const keys = loadKeys();
  const r = await accountOf(keys.sender).callFunctionRaw({
    contractId: keys.contract.accountId,
    methodName: "cancel",
    args: { stream_id: Number(arg) },
  });
  record({ step: `cancel stream ${arg} while stalled`, tx: hashOf(r) });
} else {
  console.error("usage: node scripts/mainnet-setup.mjs keys | deploy | cancel <stream_id>");
  process.exit(1);
}
