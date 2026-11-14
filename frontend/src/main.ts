import "./polyfills";
import { formatNearAmount, parseNearAmount } from "near-api-js";
import "./style.css";
import { CONTRACT_ID } from "./config";
import {
  callChange,
  fetchTokenMeta,
  getActiveAccountId,
  initNear,
  listStreams,
  onAccountChange,
  showWalletModal,
  signOut,
  type RawStream,
  type TokenMeta,
} from "./near";
import { accruedAmount, verifiedAccrued, type Heartbeat } from "./stream-math";

const app = document.querySelector<HTMLDivElement>("#app")!;

let accountId: string | null = null;
let streams: RawStream[] = [];
let statusMessage = "";
let busyStreamId: number | null = null;
const tokenMeta = new Map<string, TokenMeta>();
const PAYOUT_GAS = 150_000_000_000_000n; // up to two payouts, each with a rollback callback

// Every string from the chain (account ids, token ids, token metadata) or from errors is
// attacker-controlled: anyone can create a stream naming any "receiver" string.
function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function near(amountYocto: string): string {
  return `${formatNearAmount(amountYocto, 6)} NEAR`;
}

function formatUnits(amount: string, decimals: number, digits = 6): string {
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const frac = (value % base).toString().padStart(decimals, "0").slice(0, Math.min(digits, decimals)).replace(/0+$/, "");
  return frac ? `${value / base}.${frac}` : `${value / base}`;
}

function parseUnits(amount: string, decimals: number): string | null {
  if (!/^\d+(\.\d+)?$/.test(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) return null;
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

// Amount in the stream's own unit: NEAR, or the token's symbol/decimals. Returns escaped HTML.
function money(stream: RawStream, amount: string): string {
  if (!stream.token) return near(amount);
  const meta = tokenMeta.get(stream.token);
  return esc(meta ? `${formatUnits(amount, meta.decimals)} ${meta.symbol}` : `${amount} (${stream.token})`);
}

function verifiersOf(stream: RawStream): string[] {
  if (stream.verifiers?.length) return stream.verifiers;
  return stream.verifier ? [stream.verifier] : [];
}

function heartbeatOf(stream: RawStream): Heartbeat {
  if (verifiersOf(stream).length === 0 || !stream.heartbeatSeconds || !stream.lastAttestedAt) return null;
  return {
    lastAttestedAt: BigInt(stream.lastAttestedAt),
    heartbeatSeconds: BigInt(stream.heartbeatSeconds),
  };
}

function isStalled(stream: RawStream): boolean {
  const heartbeat = heartbeatOf(stream);
  if (!heartbeat) return false;
  const deadlineNanos = heartbeat.lastAttestedAt + heartbeat.heartbeatSeconds * 1_000_000_000n;
  return BigInt(Date.now()) * 1_000_000n > deadlineNanos;
}

function withdrawableNow(stream: RawStream): bigint {
  // Closed without a settle time = final (fully withdrawn, or cancelled before settledAt existed).
  if (stream.closed && !stream.settledAt) return 0n;
  if (heartbeatOf(stream) && stream.verifiedNanos != null) {
    // verified-time stream: only attested time is payable, exactly as the contract computes it
    const owed = verifiedAccrued(BigInt(stream.totalAmount), BigInt(stream.verifiedNanos), BigInt(stream.durationSeconds));
    return owed > BigInt(stream.withdrawn) ? owed - BigInt(stream.withdrawn) : 0n;
  }
  // Uses the browser clock as a stand-in for the chain's block timestamp so the UI can
  // tick between RPC reads; the contract always recomputes from the real block time on
  // withdraw/cancel, so this is a display estimate only, never the source of truth.
  const accrued = accruedAmount(
    {
      totalAmount: BigInt(stream.totalAmount),
      startTime: BigInt(stream.startTime),
      durationSeconds: BigInt(stream.durationSeconds),
    },
    stream.settledAt ? BigInt(stream.settledAt) : BigInt(Date.now()) * 1_000_000n,
    heartbeatOf(stream),
  );
  const withdrawable = accrued - BigInt(stream.withdrawn);
  return withdrawable > 0n ? withdrawable : 0n;
}

function progressPct(stream: RawStream): number {
  const total = BigInt(stream.totalAmount);
  if (total === 0n) return 100;
  const done = BigInt(stream.withdrawn) + withdrawableNow(stream);
  const pct = Number((done * 1000n) / total) / 10;
  return Math.min(100, pct);
}

function heartbeatReadout(stream: RawStream, stalled: boolean): string {
  const sinceAttest = Math.max(0, Math.floor((Date.now() - Number(BigInt(stream.lastAttestedAt!) / 1_000_000n)) / 1000));
  const window = Number(stream.heartbeatSeconds);
  const detail = stalled
    ? stream.verifiedNanos != null
      ? `<strong>Payout frozen</strong> — no attestation for ${sinceAttest}s (window ${window}s). This unverified time will never be paid; payout resumes from the next attestation.`
      : `<strong>Payout frozen</strong> — no attestation for ${sinceAttest}s (window ${window}s). The sender can cancel at the frozen amount; the next attestation releases the real elapsed amount.`
    : `Last attestation ${sinceAttest}s ago · payout freezes in <strong>${window - sinceAttest}s</strong> unless ${
        verifiersOf(stream).length > 1 ? `${esc(stream.threshold)} of ${verifiersOf(stream).length} verifiers attest` : "the verifier attests"
      } again.`;
  return `<p class="hint guard-hint ${stalled ? "frozen" : ""}">${detail}</p>`;
}

function streamCard(stream: RawStream): string {
  const youAreReceiver = accountId === stream.receiver;
  const youAreSender = accountId === stream.sender;
  const youAreVerifier = accountId !== null && verifiersOf(stream).includes(accountId);
  const withdrawable = withdrawableNow(stream);
  const busy = busyStreamId === stream.id;
  const id = Number(stream.id);
  const guarded = heartbeatOf(stream) !== null;
  const stalled = guarded && !stream.closed && isStalled(stream);

  const actions: string[] = [];
  if (youAreReceiver && withdrawable > 0n) {
    actions.push(
      `<button data-action="withdraw" data-id="${id}" ${busy ? "disabled" : ""}>Withdraw ${money(stream, withdrawable.toString())}</button>`,
    );
  }
  if (youAreSender && BigInt(stream.refundOwed ?? "0") > 0n) {
    actions.push(`<button data-action="claim_refund" data-id="${id}" ${busy ? "disabled" : ""}>Claim ${money(stream, stream.refundOwed!)} refund</button>`);
  }
  if (youAreSender && !stream.closed) {
    actions.push(`<button data-action="cancel" data-id="${id}" class="secondary" ${busy ? "disabled" : ""}>Cancel &amp; refund remainder</button>`);
  }
  if (youAreVerifier && !stream.closed) {
    actions.push(`<button data-action="attest" data-id="${id}" ${busy ? "disabled" : ""}>Attest (keep streaming)</button>`);
  }

  let statusBadge: string;
  if (stream.closed) {
    statusBadge = '<span class="badge">closed</span>';
  } else if (stalled) {
    statusBadge = '<span class="badge stalled">stalled — accrual frozen</span>';
  } else if (guarded) {
    statusBadge = '<span class="badge live">verified &amp; streaming</span>';
  } else {
    statusBadge = '<span class="badge live">streaming</span>';
  }

  return `
    <article class="stream-card ${stream.closed ? "closed" : ""}">
      <header>
        <span class="stream-id">Stream #${id}</span>
        ${statusBadge}
      </header>
      <div class="parties">
        <div><label>From</label><span>${esc(stream.sender)}</span></div>
        <div><label>To</label><span>${esc(stream.receiver)}</span></div>
        ${
          guarded
            ? verifiersOf(stream).length > 1
              ? `<div class="wide"><label>Verifiers — ${esc(stream.threshold)} of ${verifiersOf(stream).length} must attest</label><span>${verifiersOf(stream).map(esc).join("<br>")}</span></div>`
              : `<div><label>Verifier</label><span>${esc(verifiersOf(stream)[0])}</span></div>`
            : ""
        }
      </div>
      <div class="progress-track">
        <div class="progress-fill ${stalled ? "stalled" : ""}" style="width:${progressPct(stream)}%"></div>
      </div>
      <div class="amounts">
        <span>${money(stream, stream.totalAmount)} total</span>
        <span>${money(stream, (BigInt(stream.withdrawn) + withdrawable).toString())} unlocked</span>
      </div>
      ${guarded && !stream.closed ? heartbeatReadout(stream, stalled) : ""}
      ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    </article>
  `;
}

// The page shell (header, form) is built only when the account changes, so typing in the
// form survives the 1s live tick; render() refreshes just the status line and stream list.
function renderShell() {
  app.innerHTML = `
    <div class="page">
      <header class="topbar">
        <h1>NEAR Stream <span class="tagline">pay-per-second</span></h1>
        ${
          accountId
            ? `<div class="account">
                 <span>${esc(accountId)}</span>
                 <button id="sign-out" class="secondary">Disconnect</button>
               </div>`
            : `<button id="connect">Connect wallet</button>`
        }
      </header>

      <section class="hero">
        <p class="lede">
          Instead of paying a lump sum and trusting the other side to deliver,
          NEAR Stream pays <strong>continuously, second by second</strong>.
          The receiver can pull out whatever has accrued at any moment; the
          sender can cancel anytime and get back whatever hasn't streamed yet.
        </p>
        <ol class="how-it-works">
          <li>Sender locks NEAR, naming a receiver and a duration.</li>
          <li>The unlocked amount grows every second — watch it tick below.</li>
          <li>Receiver withdraws anytime; sender can cancel anytime for a refund of the remainder.</li>
          <li><strong>Optional:</strong> gate it on verifiers' heartbeats (one, or any k of n) — e.g. autonomous
            watchdog agents that check the paid service and attest while it's really delivering, each with a NEAR key
            that can call <code>attest</code> and nothing else. Delivery stops → attestations stop → payout
            freezes automatically. A payer-side guardian agent (with a cancel-only key) then cancels and
            returns the unverified money. No human on either side.</li>
        </ol>
        <p class="hint">
          Testnet demo — no real funds. Contract: <code>${CONTRACT_ID}</code>
        </p>
      </section>

      <section class="card">
               <h2>Start a new stream</h2>
               <form id="create-form">
                 <label>Receiver account id
                   <input name="receiver" type="text" placeholder="alice.testnet" required />
                 </label>
                 <label>Pay in (NEP-141 token contract, or blank for NEAR)
                   <input name="token" type="text" placeholder="blank = NEAR · e.g. wrap.testnet or a USDC contract" />
                 </label>
                 <label>Total amount
                   <input name="amount" type="text" inputmode="decimal" placeholder="1" required />
                 </label>
                 <label>Duration (seconds)
                   <input name="duration" type="number" step="1" min="1" placeholder="3600" required />
                 </label>
                 <fieldset class="verifier-fields">
                   <legend>Optional: gate it on a verifier's heartbeat</legend>
                   <label>Verifier account id(s), comma-separated
                     <input name="verifier" type="text" placeholder="leave blank for an unguarded stream" />
                   </label>
                   <label>How many must attest (k of n)
                     <input name="threshold" type="number" step="1" min="1" placeholder="1" />
                   </label>
                   <label>Heartbeat window (seconds)
                     <input name="heartbeat" type="number" step="1" min="1" placeholder="e.g. 300" />
                   </label>
                 </fieldset>
                 <button type="submit">${accountId ? "Create stream" : "Connect wallet to create"}</button>
               </form>
             </section>

      <div id="status"></div>

      <section class="streams">
        <h2>Streams</h2>
        <div id="stream-list"></div>
      </section>
    </div>
  `;

  document.querySelector("#connect")?.addEventListener("click", () => showWalletModal());
  document.querySelector("#sign-out")?.addEventListener("click", async () => {
    await signOut();
    accountId = null;
    renderShell();
  });
  document.querySelector("#create-form")?.addEventListener("submit", onCreateStream);
  document.querySelector("#stream-list")!.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    if (button && !button.disabled) onStreamAction(button.dataset.action!, Number(button.dataset.id));
  });
  render();
}

function render() {
  document.querySelector("#status")!.innerHTML = statusMessage ? `<p class="status">${esc(statusMessage)}</p>` : "";
  document.querySelector("#stream-list")!.innerHTML = streams.length
    ? streams.map(streamCard).join("")
    : '<p class="hint">No streams yet.</p>';
}

async function onCreateStream(event: Event) {
  event.preventDefault();
  if (!accountId) return showWalletModal();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  const receiver = String(data.get("receiver")).trim();
  const amount = String(data.get("amount")).trim();
  const duration = Number(data.get("duration"));
  const verifiers = String(data.get("verifier") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const verifier = verifiers.join(",");
  const heartbeat = String(data.get("heartbeat") ?? "").trim();
  const threshold = Number(String(data.get("threshold") ?? "").trim() || "1");

  const token = String(data.get("token") ?? "").trim();
  let meta: TokenMeta | null = null;
  if (token) {
    try {
      meta = await fetchTokenMeta(token);
      tokenMeta.set(token, meta);
    } catch {
      statusMessage = `${token} doesn't look like a NEP-141 token contract.`;
      render();
      return;
    }
  }
  const depositYocto = meta ? parseUnits(amount, meta.decimals) : parseNearAmount(amount as `${number}`);
  if (!depositYocto || depositYocto === "0") {
    statusMessage = `Enter a valid ${meta ? meta.symbol : "NEAR"} amount.`;
    render();
    return;
  }
  if (Boolean(verifier) !== Boolean(heartbeat)) {
    statusMessage = "Set both the verifier account and the heartbeat window, or leave both blank.";
    render();
    return;
  }

  if (verifiers.length && (!Number.isInteger(threshold) || threshold < 1 || threshold > verifiers.length)) {
    statusMessage = `"How many must attest" must be between 1 and ${verifiers.length}.`;
    render();
    return;
  }

  const args: Record<string, unknown> = { receiver_id: receiver, duration_seconds: duration };
  if (verifiers.length && heartbeat) {
    args.verifier_ids = verifiers;
    args.threshold = threshold;
    args.heartbeat_seconds = Number(heartbeat);
  }

  statusMessage = "Confirm the transaction in your wallet…";
  render();
  try {
    if (token) {
      // NEP-141: send the tokens to the stream contract with the stream params as `msg`.
      // Requires 1 yoctoNEAR; the stream contract must be storage-registered on the token.
      await callChange(
        "ft_transfer_call",
        { receiver_id: CONTRACT_ID, amount: depositYocto, msg: JSON.stringify(args) },
        "1",
        { receiverId: token, gas: 200_000_000_000_000n },
      );
    } else {
      await callChange("create_stream", args, depositYocto);
    }
    statusMessage = "Stream created.";
    await refreshStreams();
  } catch (err) {
    statusMessage = `Failed to create stream: ${(err as Error).message}`;
  }
  render();
}

async function onStreamAction(action: string, streamId: number) {
  busyStreamId = streamId;
  statusMessage = "Confirm the transaction in your wallet…";
  render();
  try {
    await callChange(action, { stream_id: streamId }, "0", action !== "attest" ? { gas: PAYOUT_GAS } : {});
    const labels: Record<string, string> = { withdraw: "Withdrawal", cancel: "Cancellation", attest: "Attestation", claim_refund: "Refund" };
    statusMessage = `${labels[action] ?? "Action"} confirmed.`;
    await refreshStreams();
  } catch (err) {
    statusMessage = `Failed: ${(err as Error).message}`;
  }
  busyStreamId = null;
  render();
}

async function refreshStreams() {
  streams = await listStreams();
  for (const token of new Set(streams.map((s) => s.token).filter((t): t is string => Boolean(t)))) {
    if (!tokenMeta.has(token)) {
      try {
        tokenMeta.set(token, await fetchTokenMeta(token));
      } catch {
        // unknown token: amounts fall back to raw units
      }
    }
  }
}

async function boot() {
  await initNear();
  accountId = await getActiveAccountId();
  onAccountChange((next) => {
    accountId = next;
    renderShell();
  });
  renderShell();
  await refreshStreams();
  render();

  // Live-tick the withdrawable/progress display between chain reads.
  setInterval(() => {
    if (streams.length) render();
  }, 1000);

  // Re-sync with chain often: an off-page watchdog agent attests every few seconds, and a
  // refresh slower than the heartbeat window would show a falsely "frozen" stream.
  setInterval(() => refreshStreams().catch(() => {}), 4000);
}

boot();
