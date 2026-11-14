import "./polyfills";
import { formatNearAmount, parseNearAmount } from "near-api-js";
import "./style.css";
import { CONTRACT_ID } from "./config";
import {
  callChange,
  getActiveAccountId,
  initNear,
  listStreams,
  onAccountChange,
  showWalletModal,
  signOut,
  type RawStream,
} from "./near";
import { accruedAmount, type Heartbeat } from "./stream-math";

const app = document.querySelector<HTMLDivElement>("#app")!;

let accountId: string | null = null;
let streams: RawStream[] = [];
let statusMessage = "";
let busyStreamId: number | null = null;

function near(amountYocto: string): string {
  return `${formatNearAmount(amountYocto, 4)} NEAR`;
}

function heartbeatOf(stream: RawStream): Heartbeat {
  if (!stream.verifier || !stream.heartbeatSeconds || !stream.lastAttestedAt) return null;
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
  // Uses the browser clock as a stand-in for the chain's block timestamp so the UI can
  // tick between RPC reads; the contract always recomputes from the real block time on
  // withdraw/cancel, so this is a display estimate only, never the source of truth.
  const accrued = accruedAmount(
    {
      totalAmount: BigInt(stream.totalAmount),
      startTime: BigInt(stream.startTime),
      durationSeconds: BigInt(stream.durationSeconds),
    },
    BigInt(Date.now()) * 1_000_000n,
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

function streamCard(stream: RawStream): string {
  const youAreReceiver = accountId === stream.receiver;
  const youAreSender = accountId === stream.sender;
  const youAreVerifier = accountId === stream.verifier;
  const withdrawable = withdrawableNow(stream);
  const busy = busyStreamId === stream.id;
  const guarded = heartbeatOf(stream) !== null;
  const stalled = guarded && !stream.closed && isStalled(stream);

  const actions: string[] = [];
  if (youAreReceiver && !stream.closed && withdrawable > 0n) {
    actions.push(
      `<button data-action="withdraw" data-id="${stream.id}" ${busy ? "disabled" : ""}>Withdraw ${near(withdrawable.toString())}</button>`,
    );
  }
  if (youAreSender && !stream.closed) {
    actions.push(`<button data-action="cancel" data-id="${stream.id}" class="secondary" ${busy ? "disabled" : ""}>Cancel &amp; refund remainder</button>`);
  }
  if (youAreVerifier && !stream.closed) {
    actions.push(`<button data-action="attest" data-id="${stream.id}" ${busy ? "disabled" : ""}>Attest (keep streaming)</button>`);
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
        <span class="stream-id">Stream #${stream.id}</span>
        ${statusBadge}
      </header>
      <div class="parties">
        <div><label>From</label><span>${stream.sender}</span></div>
        <div><label>To</label><span>${stream.receiver}</span></div>
        ${guarded ? `<div><label>Verifier</label><span>${stream.verifier}</span></div>` : ""}
      </div>
      <div class="progress-track">
        <div class="progress-fill ${stalled ? "stalled" : ""}" style="width:${progressPct(stream)}%"></div>
      </div>
      <div class="amounts">
        <span>${near(stream.totalAmount)} total</span>
        <span>${near((BigInt(stream.withdrawn) + withdrawable).toString())} unlocked</span>
      </div>
      ${
        guarded
          ? `<p class="hint guard-hint">${
              stalled
                ? "No attestation within the heartbeat window — payout is frozen, protecting the sender. An attestation will release the real elapsed amount immediately."
                : `Requires an attestation from the verifier at least every ${stream.heartbeatSeconds}s, or payout freezes.`
            }</p>`
          : ""
      }
      ${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}
    </article>
  `;
}

function render() {
  app.innerHTML = `
    <div class="page">
      <header class="topbar">
        <h1>NEAR Stream <span class="tagline">pay-per-second</span></h1>
        ${
          accountId
            ? `<div class="account">
                 <span>${accountId}</span>
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
          <li><strong>Optional:</strong> gate it on a verifier's heartbeat — built for paying an AI agent
            or contractor only while their work is still being vouched for. Miss a heartbeat and payout
            freezes automatically, no dispute needed; the sender can safely cancel at the frozen amount.</li>
        </ol>
        <p class="hint">
          Testnet demo — no real funds. Contract: <code>${CONTRACT_ID}</code>
        </p>
      </section>

      ${
        accountId
          ? `<section class="card">
               <h2>Start a new stream</h2>
               <form id="create-form">
                 <label>Receiver account id
                   <input name="receiver" type="text" placeholder="alice.testnet" required />
                 </label>
                 <label>Total amount (NEAR)
                   <input name="amount" type="number" step="0.0001" min="0.0001" placeholder="1" required />
                 </label>
                 <label>Duration (seconds)
                   <input name="duration" type="number" step="1" min="1" placeholder="3600" required />
                 </label>
                 <fieldset class="verifier-fields">
                   <legend>Optional: gate it on a verifier's heartbeat</legend>
                   <label>Verifier account id
                     <input name="verifier" type="text" placeholder="leave blank for an unguarded stream" />
                   </label>
                   <label>Heartbeat window (seconds)
                     <input name="heartbeat" type="number" step="1" min="1" placeholder="e.g. 300" />
                   </label>
                 </fieldset>
                 <button type="submit">Create stream</button>
               </form>
             </section>`
          : `<p class="hint">Connect a wallet above to start or receive a stream.</p>`
      }

      ${statusMessage ? `<p class="status">${statusMessage}</p>` : ""}

      <section class="streams">
        <h2>Streams</h2>
        ${streams.length ? streams.map(streamCard).join("") : '<p class="hint">No streams yet.</p>'}
      </section>
    </div>
  `;

  document.querySelector("#connect")?.addEventListener("click", () => showWalletModal());
  document.querySelector("#sign-out")?.addEventListener("click", async () => {
    await signOut();
    accountId = null;
    render();
  });
  document.querySelector("#create-form")?.addEventListener("submit", onCreateStream);
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => onStreamAction(button.dataset.action!, Number(button.dataset.id)));
  });
}

async function onCreateStream(event: Event) {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  const receiver = String(data.get("receiver")).trim();
  const amount = String(data.get("amount")).trim();
  const duration = Number(data.get("duration"));
  const verifier = String(data.get("verifier") ?? "").trim();
  const heartbeat = String(data.get("heartbeat") ?? "").trim();

  const depositYocto = parseNearAmount(amount as `${number}`);
  if (!depositYocto || depositYocto === "0") {
    statusMessage = "Enter a valid NEAR amount.";
    render();
    return;
  }
  if (Boolean(verifier) !== Boolean(heartbeat)) {
    statusMessage = "Set both the verifier account and the heartbeat window, or leave both blank.";
    render();
    return;
  }

  const args: Record<string, unknown> = { receiver_id: receiver, duration_seconds: duration };
  if (verifier && heartbeat) {
    args.verifier_id = verifier;
    args.heartbeat_seconds = Number(heartbeat);
  }

  statusMessage = "Confirm the transaction in your wallet…";
  render();
  try {
    await callChange("create_stream", args, depositYocto);
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
    await callChange(action, { stream_id: streamId }, "0");
    const labels: Record<string, string> = { withdraw: "Withdrawal", cancel: "Cancellation", attest: "Attestation" };
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
}

async function boot() {
  await initNear();
  accountId = await getActiveAccountId();
  onAccountChange((next) => {
    accountId = next;
    render();
  });
  await refreshStreams();
  render();

  // Live-tick the withdrawable/progress display between chain reads.
  setInterval(() => {
    if (streams.length) render();
  }, 1000);

  // Re-sync with chain periodically in case another tab/account changed state.
  setInterval(refreshStreams, 15000);
}

boot();
