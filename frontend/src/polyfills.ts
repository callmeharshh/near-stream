// @near-wallet-selector/bitte-wallet's crypto deps expect Node's `Buffer` and
// `global`, which Vite no longer polyfills by default. Must be imported before
// any near-wallet-selector module.
import { Buffer } from "buffer";

const g = globalThis as typeof globalThis & {
  Buffer: typeof Buffer;
  global: typeof globalThis;
  process: { env: Record<string, string> };
};
g.Buffer = Buffer;
g.global = globalThis;
g.process ??= { env: {} };
