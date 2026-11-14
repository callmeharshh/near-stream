// The paid service: a NEAR RPC data provider. It serves the latest finalized block
// (height, hash, timestamp) from its upstream RPC. The payer streams money to it only
// while the watchdog can verify that data is correct and fresh.
//
// Ways to break it for the demo (all still answer HTTP 200):
//   POST /stall   keeps serving the last block: stale data, height stops advancing
//   POST /tamper  serves the real height with a forged block hash: wrong data
//   POST /resume  back to honest, live data
// Or kill the process for a plain outage.
import { createServer } from "node:http";

const PORT = Number(process.env.WORKER_PORT ?? 8787);
const UPSTREAM = process.env.UPSTREAM_RPC ?? "https://test.rpc.fastnear.com";
let mode = "live"; // live | stalled | tampered
let latest = null;

async function refresh() {
  if (mode === "stalled") return;
  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }),
      signal: AbortSignal.timeout(4000),
    });
    const header = (await res.json()).result.header;
    latest = { height: header.height, hash: header.hash, timestampNanos: header.timestamp_nanosec };
  } catch {
    // keep the previous block; the watchdog will see it go stale
  }
}
await refresh();
setInterval(refresh, 2000);

createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/work") {
    if (!latest) return send(503, { error: "no data yet" });
    // forged hash: same length/format as a real one, but not the real block
    return send(200, mode === "tampered" ? { ...latest, hash: "1".repeat(latest.hash.length) } : latest);
  }
  if (req.method === "POST" && ["/stall", "/tamper", "/resume"].includes(req.url)) {
    mode = { "/stall": "stalled", "/tamper": "tampered", "/resume": "live" }[req.url];
    console.log(`service: now ${mode.toUpperCase()} (still answering HTTP 200)`);
    return send(200, { mode });
  }
  send(404, { error: "not found" });
}).listen(PORT, () => console.log(`service: serving live NEAR block data from ${UPSTREAM} on http://localhost:${PORT}/work`));
