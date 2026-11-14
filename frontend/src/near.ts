import { setupWalletSelector, type WalletSelector, type WalletModuleFactory } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupBitteWallet } from "@near-wallet-selector/bitte-wallet";
import { setupHereWallet } from "@near-wallet-selector/here-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { JsonRpcProvider } from "near-api-js";
import { actionCreators } from "@near-js/transactions";
import { CONTRACT_ID, DEFAULT_GAS, NETWORK_ID, RPC_URL } from "./config";

import "@near-wallet-selector/modal-ui/styles.css";

export type RawStream = {
  id: number;
  sender: string;
  receiver: string;
  totalAmount: string;
  startTime: string;
  durationSeconds: string;
  withdrawn: string;
  closed: boolean;
  // Absent on streams created before the verifier/heartbeat feature shipped.
  verifier?: string | null; // legacy single verifier
  verifiers?: string[] | null; // k-of-n verifiers
  threshold?: number | null;
  token?: string | null; // NEP-141 contract (e.g. USDC); null/absent = native NEAR
  settledAt?: string | null;
  refundOwed?: string;
  heartbeatSeconds?: string | null;
  lastAttestedAt?: string;
  verifiedNanos?: string | null; // verified-time accounting (newer gated streams)
};

let selector: WalletSelector | null = null;
let modal: WalletSelectorModal | null = null;

export const provider = new JsonRpcProvider({ url: RPC_URL });

export async function initNear(): Promise<WalletSelector> {
  selector = await setupWalletSelector({
    network: NETWORK_ID,
    // my-near-wallet is retired for new app connections (Nov 2026); these three
    // cover a redirect-based web wallet (Bitte, no extension needed), a QR/mobile
    // flow (HERE), and an extension wallet (Meteor) for users who already have one.
    modules: [setupBitteWallet(), setupHereWallet(), setupMeteorWallet()] as WalletModuleFactory[],
  });
  modal = setupModal(selector, {
    contractId: CONTRACT_ID,
    description: "Connect a testnet wallet to send or receive a stream.",
  });
  return selector;
}

function getSelector(): WalletSelector {
  if (!selector) throw new Error("NEAR wallet selector not initialized yet");
  return selector;
}

export function showWalletModal() {
  modal?.show();
}

export function onAccountChange(callback: (accountId: string | null) => void): void {
  getSelector().subscribeOnAccountChange((account) => callback(account || null));
}

export function isSignedIn(): boolean {
  return getSelector().isSignedIn();
}

export async function getActiveAccountId(): Promise<string | null> {
  const sel = getSelector();
  if (!sel.isSignedIn()) return null;
  const wallet = await sel.wallet();
  const accounts = await wallet.getAccounts();
  return accounts[0]?.accountId ?? null;
}

export async function signOut(): Promise<void> {
  const wallet = await getSelector().wallet();
  await wallet.signOut();
}

export async function callChange(
  methodName: string,
  args: Record<string, unknown>,
  depositYocto: string,
  opts: { receiverId?: string; gas?: bigint } = {},
): Promise<void> {
  const accountId = await getActiveAccountId();
  if (!accountId) throw new Error("Not signed in");
  const wallet = await getSelector().wallet();
  await wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: opts.receiverId ?? CONTRACT_ID,
    actions: [actionCreators.functionCall(methodName, args, opts.gas ?? BigInt(DEFAULT_GAS), BigInt(depositYocto))],
  });
}

export async function listStreams(): Promise<RawStream[]> {
  const result = await provider.callFunction<RawStream[]>({
    contractId: CONTRACT_ID,
    method: "list_streams",
    args: {},
  });
  return result ?? [];
}

export type TokenMeta = { symbol: string; decimals: number };

export async function fetchTokenMeta(token: string): Promise<TokenMeta> {
  const meta = await provider.callFunction<{ symbol: string; decimals: number }>({
    contractId: token,
    method: "ft_metadata",
    args: {},
  });
  if (!meta) throw new Error(`${token} is not a NEP-141 token`);
  return { symbol: meta.symbol, decimals: meta.decimals };
}
