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
const DIR = join(homedir(), DRY_RUN ? ".near-stream-testnet-dryrun" : ".near-stream-mainnet");
const KEYS = join(DIR, "keys.json");
const EVIDENCE = DRY_RUN
  ? join(DIR, "evidence.json")
  : join(dirname(fileURLToPath(import.meta.url)), "../mainnet-evidence.json");
const WASM = join(dirname(fileURLToPath(import.meta.url)), "../contract/build/contract.wasm");
const MIN_FUNDING = parseNearAmount("6.5");

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
  const log = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, "utf8")) : { network: "mainnet", steps: [] };
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
    console.error(`contract account has ${formatNearAmount(have.toString(), 4)} NEAR; needs >= 6.5 NEAR. Not deploying.`);
    process.exit(1);
  }
  const contract = accountOf(keys.contract);
  const ids = Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, k.accountId]));
  writeFileSync(EVIDENCE, JSON.stringify({ network: "mainnet", accounts: ids, watchdogKey: keys.watchdog.publicKey, steps: [] }, null, 2));

  for (const [role, near] of [["sender", "0.15"], ["verifier", "0.3"], ["receiver", "0.01"]]) {
    const r = await contract.transfer({ receiverId: keys[role].accountId, amount: parseNearAmount(near) });
    record({ step: `fund ${role} with ${near} NEAR`, tx: hashOf(r) });
  }

  const deployed = await contract.deployContract(new Uint8Array(readFileSync(WASM)));
  record({ step: "deploy contract", tx: hashOf(deployed) });

  const keyTx = await accountOf(keys.verifier).addFunctionCallAccessKey({
    publicKey: keys.watchdog.publicKey,
    contractId: keys.contract.accountId,
    methodNames: ["attest"],
    // each attest burns ~13 Tgas (~0.0013 NEAR): 0.5 NEAR allowance ≈ 380 attests ≈ 30 min at 5s checks
    // (the verifier's 0.3 NEAR balance, which pays the burnt gas, is the tighter limit: ≈ 19 min)
    allowance: parseNearAmount("0.5"),
  });
  record({ step: "register attest-only watchdog key on verifier", tx: hashOf(keyTx) });

  const guardianKeyTx = await accountOf(keys.sender).addFunctionCallAccessKey({
    publicKey: keys.guardian.publicKey,
    contractId: keys.contract.accountId,
    methodNames: ["cancel"],
    allowance: parseNearAmount("0.05"),
  });
  record({ step: "register cancel-only guardian key on sender", tx: hashOf(guardianKeyTx) });

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
