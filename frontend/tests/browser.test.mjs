// Browser regressions for the built app (run: npm run test:browser).
// The chain is mocked at the RPC layer with hostile data: anyone can create a stream naming
// any "receiver" string, and any token contract can return any `symbol`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4179;
const URL_ = `http://localhost:${PORT}/`;
const now = (BigInt(Date.now()) * 1_000_000n).toString();
const hostileStreams = [
  {
    id: 0, sender: "alice.testnet", receiver: `<img src=x onerror="window.__pwned='receiver'">`,
    totalAmount: "1000000000000000000000000", startTime: now, durationSeconds: "3600", withdrawn: "0",
    closed: false, verifier: null, heartbeatSeconds: null, lastAttestedAt: now, token: null,
  },
  {
    id: 1, sender: "alice.testnet", receiver: "bob.testnet", totalAmount: "5000000", startTime: now,
    durationSeconds: "3600", withdrawn: "0", closed: false, verifier: null, heartbeatSeconds: "60",
    lastAttestedAt: now, verifiers: [`<b id="injected">v</b>`, "w.testnet"], threshold: 1,
    attestations: {}, token: "evil-token.testnet", verifiedNanos: "0",
  },
  {
    id: 2, sender: "alice.testnet", receiver: "bob.testnet", totalAmount: "5000000", startTime: now,
    durationSeconds: "3600", withdrawn: "0", closed: false, verifier: null, heartbeatSeconds: null,
    lastAttestedAt: now, token: `<svg onload="window.__pwned='token-id'">`,
  },
];
const hostileMeta = { symbol: `<img src=x onerror="window.__pwned='symbol'">`, decimals: 6 };

let server, browser, page;
const errors = [];

before(async () => {
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(URL_).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/test.rpc.fastnear.com/**", async (route) => {
    const body = route.request().postDataJSON?.();
    const p = body?.params;
    if (body?.method === "query" && p?.request_type === "call_function") {
      const value = p.method_name === "list_streams" ? hostileStreams : p.method_name === "ft_metadata" ? hostileMeta : null;
      const bytes = [...Buffer.from(JSON.stringify(value))];
      return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: { result: bytes, logs: [], block_height: 1, block_hash: "1" } } });
    }
    return route.continue();
  });
  await page.goto(URL_);
  await page.waitForSelector(".stream-card");
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test("chain-controlled strings render as text, never as markup", async () => {
  await page.waitForTimeout(1500); // token metadata fetch + a few live ticks
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator("#stream-list img, #stream-list svg, #injected").count(), 0);
  const text = await page.locator("#stream-list").innerText();
  assert.match(text, /<img src=x onerror=/); // shown literally
  assert.match(text, /<b id="injected">v<\/b>/);
  assert.deepEqual(errors, []);
});

test("form input survives live re-renders", async () => {
  const receiver = page.locator('input[name="receiver"]');
  await receiver.fill("carol.testnet");
  await receiver.focus();
  await page.waitForTimeout(2500); // the stream list re-renders every second
  assert.equal(await receiver.inputValue(), "carol.testnet");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("name")), "receiver");
});
