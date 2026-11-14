// Demo "paid service": stands in for an AI agent / API being paid per second.
// It produces a fresh unit of work every 2s. Two ways to break it for the demo:
//   - kill the process (outage)
//   - POST /stall (server still answers 200, but work stops being produced —
//     the failure a plain uptime check misses; the watchdog's freshness check catches it)
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.WORKER_PORT ?? 8787);
let stalled = false;
let sequence = 0;
let latest = null;

function produceWork() {
  if (stalled) return;
  sequence += 1;
  const producedAt = new Date().toISOString();
  const output = createHash("sha256").update(`${sequence}:${producedAt}`).digest("hex");
  latest = { sequence, producedAt, output };
}
produceWork();
setInterval(produceWork, 2000);

createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/work") return send(200, latest);
  if (req.method === "POST" && req.url === "/stall") {
    stalled = true;
    console.log("worker: STALLED (still answering 200, but no new work)");
    return send(200, { stalled });
  }
  if (req.method === "POST" && req.url === "/resume") {
    stalled = false;
    produceWork();
    console.log("worker: resumed");
    return send(200, { stalled });
  }
  send(404, { error: "not found" });
}).listen(PORT, () => console.log(`worker: producing work on http://localhost:${PORT}/work`));
