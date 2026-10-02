// Non-secure-context compatibility layer.
// Outside a secure context (https / localhost) — e.g. a phone reaching the page over http://<LAN-IP> —
// the browser does not provide crypto.randomUUID or crypto.subtle. They are marked
// [SecureContext] by the web standard; accessed from an http page they are undefined, and calling them throws TypeError.
// Because the top-level `new AppEngine()` flows down into BrowserSignaling's field initialization,
// that throw would fail the entire entry module's evaluation → the page shows only its <title> (blank screen, hard to diagnose).
// So every random/digest entry point goes through this module.

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
  subtle?: SubtleCrypto;
}

function cryptoObj(): CryptoLike | undefined {
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

// Whether WebCrypto digest capability is available (SHA-256 depends on it). False in an http non-secure context.
// Note: getRandomValues is not subject to this restriction; it works in non-secure contexts too.
export const hasSubtle: boolean = !!cryptoObj()?.subtle;

// RFC 4122 v4 UUID. Prefer the native randomUUID; fall back to assembling it from getRandomValues when missing.
export function uuid(): string {
  const c = cryptoObj();
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
