/** Shared signaling contract. Runtime checks are required at the trust boundary. */
export const SIGNAL_VERSION = 1;
export const MAX_MESSAGE = 256 * 1024;
export type Engine = 'browser-v2' | 'windows-native-v1';
export type Capabilities = { wireProtocol: 'transfer-v2'; send: boolean; receive: boolean; resume: boolean; folder: boolean; maxFrameSize: number };
export type Peer = { id: string; name: string; engine: Engine; capabilities?: Capabilities };
export type Message = Record<string, unknown> & { version: 1; type: string; requestId: string };
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
export function parseClient(value: unknown): Message {
  if (!record(value) || value.version !== SIGNAL_VERSION || !validId(value.requestId) ||
      !['hello','signal','invite','accept','reject'].includes(String(value.type))) throw new Error('INVALID_MESSAGE');
  if (value.type === 'hello') {
    if (typeof value.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.sessionKey) ||
        !text(value.name,64) || !validId(value.room) || !['browser-v2','windows-native-v1'].includes(String(value.engine)) ||
        (value.token !== undefined && (typeof value.token !== 'string' || value.token.length>512)) ||
        (value.capabilities !== undefined && !validCapabilities(value.capabilities))) throw new Error('INVALID_HELLO');
  } else {
    if (!validId(value.to)) throw new Error('INVALID_TARGET');
    if (value.type === 'signal') { if (!record(value.data)) throw new Error('INVALID_SIGNAL'); }
    else if (!validId(value.transferId)) throw new Error('INVALID_TRANSFER');
    if (value.type === 'invite' && !validFiles(value.files)) throw new Error('INVALID_FILES');
  }
  return value as Message;
}
export function validCapabilities(value: unknown): value is Capabilities {
  return record(value) && typeof value.send === 'boolean' && typeof value.receive === 'boolean' &&
    typeof value.resume === 'boolean' && typeof value.folder === 'boolean' &&
    value.wireProtocol === 'transfer-v2' && Number.isSafeInteger(value.maxFrameSize) && Number(value.maxFrameSize) >= 16384 && Number(value.maxFrameSize) <= 65535;
}
export function validFiles(value: unknown): boolean {
  return Array.isArray(value) && value.length>0 && value.length<=1000 && value.every(f =>
    record(f) && text(f.name,240) && !/[\\/\x00-\x1f]/.test(f.name) &&
    Number.isSafeInteger(f.size) && Number(f.size)>=0);
}
