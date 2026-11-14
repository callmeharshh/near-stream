// Generates the watchdog's signing key and writes it to agent/.env (gitignored).
// The key is registered on-chain as a FUNCTION-CALL access key that can only call
// `attest` on the stream contract — it can never transfer or withdraw funds.
import { writeFileSync, existsSync } from "node:fs";
import { KeyPair } from "near-api-js";

const [verifierId, contractId] = process.argv.slice(2);
if (!verifierId || !contractId) {
  console.error("usage: node keygen.mjs <verifier-account-id> <contract-id>");
  process.exit(1);
}
if (existsSync(".env")) {
  console.error(".env already exists — refusing to overwrite an existing key.");
  process.exit(1);
}

const key = KeyPair.fromRandom("ed25519");
writeFileSync(
  ".env",
  [
    `NEAR_ACCOUNT_ID=${verifierId}`,
    `NEAR_PRIVATE_KEY=${key.toString()}`,
    `CONTRACT_ID=${contractId}`,
    `RPC_URL=https://test.rpc.fastnear.com`,
    `WORKER_URL=http://localhost:8787/work`,
    `CHECK_INTERVAL_SECONDS=5`,
    `STREAM_ID=`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

const publicKey = key.getPublicKey().toString();
console.log(`Wrote .env. Register the key on-chain (scoped to attest only) with:\n`);
console.log(
  `near account add-key ${verifierId} grant-function-call-access --allowance '0.25 NEAR' ` +
    `--contract-account-id ${contractId} --function-names 'attest' ` +
    `use-manually-provided-public-key ${publicKey} network-config testnet sign-with-keychain send`,
);
