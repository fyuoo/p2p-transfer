export const PROTOCOL_VERSION = 2;
export const CHUNK_SIZE = 256 * 1024;
export const MAX_CONTROL = 256 * 1024;
export const MAX_MANIFEST = MAX_CONTROL / 2;
// Unit of the receive-window tiers (1/4/8 MiB) and the baseline the scheduler budgets against.
// Do NOT change this to "tune the default": validWindow() and scheduler memory math are built on it.
export const RECEIVE_WINDOW = 1024 * 1024;
// Default tier actually used when neither side configures one. 4 MiB matches the native (Rust)
// receiver default (app/windows/src/native/transfer.rs WINDOW), so both ends behave alike.
export const DEFAULT_RECEIVE_WINDOW = 1 * RECEIVE_WINDOW;
export function validWindow(n: unknown): n is number { return [1,4,8].some(m => n === m * RECEIVE_WINDOW); }
import type { TestMode } from '../transfer/diagnostics';
import { hasSubtle, uuid } from '../crypto-compat';
export interface FileMeta { fileIndex: number; fileId: string; name: string; size: number; mime: string; blocks: number; diagnosticMode?: TestMode; }
export interface InviteFile { name: string; size: number; diagnosticMode?: TestMode; }
export type ControlMsg = { version: number; transferId: string; attemptId: string } & (
  | { type: 'manifest'; files: FileMeta[]; blockSize: number; frameBytes?: number; sourceKind?: 'file'|'memory' }
  | { type: 'ready' | 'credit'; grant: number; windowBytes?: number }
  | { type: 'window'; windowBytes: number }
  | { type: 'file-finish'; fileIndex: number; hash: string; size: number; blocks: number }
  | { type: 'file-committed'; fileIndex: number; hash: string }
  | { type: 'transfer-result' | 'result-ack' }
  | { type: 'cancel' | 'error'; reason: string }
);
export function validateFiles(value: unknown): asserts value is InviteFile[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error('INVALID_MANIFEST');
  let total = 0;
  for (const f of value) {
    if (f.diagnosticMode !== undefined && !['full','network','hash','disk'].includes(f.diagnosticMode)) throw new Error('INVALID_TEST_MODE');
    if ((f.diagnosticMode ?? 'full') !== (value[0].diagnosticMode ?? 'full')) throw new Error('MIXED_TEST_MODES');
    if (!f || typeof f.name !== 'string' || !f.name.length || f.name.length > 240 ||
      /[\\/\x00-\x1f]/.test(f.name) || f.name === '.' || f.name === '..' ||
      !Number.isSafeInteger(f.size) || f.size < 0) throw new Error('INVALID_FILE');
    total += f.size;
    if (!Number.isSafeInteger(total)) throw new Error('INVALID_TOTAL_SIZE');
  }
  if (JSON.stringify(value).length > MAX_MANIFEST) throw new Error('MANIFEST_TOO_LARGE');
}
export function parseControl(raw: string): ControlMsg {
  if (raw.length > MAX_CONTROL) throw new Error('CONTROL_TOO_LARGE');
  const m = JSON.parse(raw);
  if (!m || m.version !== PROTOCOL_VERSION) throw new Error('VERSION_MISMATCH');
  if (typeof m.transferId !== 'string' || m.transferId.length > 100 || typeof m.attemptId !== 'string' || m.attemptId.length > 100) throw new Error('INVALID_ID');
  const integer = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (m.type === 'manifest') {
    if (m.frameBytes !== undefined && ![16384,32768,65536].includes(m.frameBytes)) throw new Error('INVALID_FRAME_SIZE');
    if (m.sourceKind !== undefined && !['file','memory'].includes(m.sourceKind)) throw new Error('INVALID_SOURCE');
    validateFiles(m.files);
    if (m.blockSize !== CHUNK_SIZE) throw new Error('BLOCK_SIZE_MISMATCH');
    m.files.forEach((f: FileMeta, i: number) => {
      if (f.fileIndex !== i || f.fileId !== `${m.transferId}:${i}` || f.blocks !== Math.ceil(f.size / CHUNK_SIZE) || typeof f.mime !== 'string' || f.mime.length > 256) throw new Error('INVALID_MANIFEST');
    });
  } else if (m.type === 'ready' || m.type === 'credit') {
    if (!integer(m.grant)) throw new Error('INVALID_CREDIT');
    if (m.windowBytes !== undefined && !validWindow(m.windowBytes)) throw new Error('INVALID_WINDOW');
  } else if (m.type === 'window') {
    if (!validWindow(m.windowBytes)) throw new Error('INVALID_WINDOW');
  } else if (m.type === 'file-finish' || m.type === 'file-committed') {
    if (!integer(m.fileIndex) || typeof m.hash !== 'string' || !/^[a-f0-9]{64}$/.test(m.hash)) throw new Error('INVALID_FINISH');
    if (m.type === 'file-finish' && (!integer(m.size) || !integer(m.blocks))) throw new Error('INVALID_FINISH');
  } else if (m.type === 'cancel' || m.type === 'error') {
    if (typeof m.reason !== 'string' || m.reason.length > 512) throw new Error('INVALID_ERROR');
  } else if (m.type !== 'transfer-result' && m.type !== 'result-ack') throw new Error('UNKNOWN_CONTROL');
  return m;
}
export function encodeChunk(fileIndex: number, offset: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(12 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, fileIndex, true); dv.setBigUint64(4, BigInt(offset), true);
  out.set(payload, 12); return out.buffer;
}
export function decodeChunk(buf: ArrayBuffer) {
  if (buf.byteLength <= 12 || buf.byteLength > 65536) throw new Error('INVALID_FRAME');
  const dv = new DataView(buf); const offset = Number(dv.getBigUint64(4, true));
  if (!Number.isSafeInteger(offset)) throw new Error('INVALID_OFFSET');
  return { fileIndex: dv.getUint32(0, true), offset, payload: new Uint8Array(buf, 12) };
}
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // Under an insecure http context crypto.subtle is undefined; throw a readable reason instead of "undefined is not an object".
  if (!hasSubtle) throw new Error('CRYPTO_UNAVAILABLE');
  // Hand over a contiguous buffer copy, not the raw view.
  // 2026-09-21 retrospective: passing the view straight to WebCrypto (to skip one copy per block) made a 3 GiB transfer
  // slower in practice — callers mostly pass reused-buffer subarrays, and the browser still copies by range, so this copy is unavoidable;
  // keeping it explicit at least makes the path predictable. The upside was only tens of microseconds per block, not worth the uncertainty.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer));
}
export function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export async function sha256(data: Uint8Array): Promise<string> { return hex(await sha256Bytes(data)); }
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; } return out;
}
// Ordered logical-block commitment with O(1) digest memory; not ordinary file SHA-256.
export async function rootSeed(size: number): Promise<Uint8Array> {
  return sha256Bytes(new TextEncoder().encode(`p2p:sha256-chain-v2:${size}:${CHUNK_SIZE}`));
}
export async function rootStep(root: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
  return sha256Bytes(concatBytes([root, await sha256Bytes(block)]));
}
export function genId(): string { return uuid(); }
