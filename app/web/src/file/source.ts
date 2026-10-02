// File read/write abstraction: the desktop (Tauri) can read any path; browsers use <input>/download.
// Tauri modules are imported dynamically so the same front-end code also loads in a pure browser.

import { FileReader, FileWriter } from "../webrtc/channel";
import { FileMeta } from "../webrtc/protocol";
import { uuid } from "../crypto-compat";
import { canSaveToFolder } from "../env";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------------- Browser implementation ----------------
// Once the browser picks a file it is a File object; slice() reads any range directly (streaming, not the whole file in memory).
export class BrowserFileReader implements FileReader {
  constructor(private file: File) {}
  get name() { return this.file.name; }
  get size() { return this.file.size; }
  get mime() { return this.file.type || "application/octet-stream"; }
  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.file.slice(offset, offset + length);
    return new Uint8Array(await slice.arrayBuffer());
  }
}

// ---------------- Tauri implementation ----------------
export class TauriFileReader implements FileReader {
  name: string;
  size: number;
  mime: string;
  private handle: any = null;
  constructor(private path: string, name: string, size: number, mime = "application/octet-stream") {
    this.name = name;
    this.size = size;
    this.mime = mime;
  }
  private async handle_(): Promise<any> {
    if (!this.handle) {
      const fs = await import("@tauri-apps/plugin-fs");
      this.handle = await fs.open(this.path, { read: true });
    }
    return this.handle;
  }
  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const fs = await import("@tauri-apps/plugin-fs");
    const h = await this.handle_();
    await h.seek(offset, fs.SeekMode.Start);
    const buf = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const n = await h.read(buf.subarray(read));
      if (!n) throw new Error('SOURCE_CHANGED_OR_SHORT_READ');
      read += n;
    }
    return buf;
  }
  async close(): Promise<void> { if (this.handle) { await this.handle.close(); this.handle = null; } }
}

export class TauriFileWriter implements FileWriter {
  private handle: any = null;
  private temporary = '';
  constructor(private path: string) {}
  async prepare(_meta: FileMeta): Promise<void> {
    const fs = await import("@tauri-apps/plugin-fs");
    const path = await import("@tauri-apps/api/path");
    const dir = await path.dirname(this.path);
    await fs.mkdir(dir, { recursive: true });
    this.temporary = `${this.path}.${uuid()}.part`;
    this.handle = await fs.open(this.temporary, { write: true, createNew: true });
  }
  async writeAt(offset: number, data: Uint8Array): Promise<void> {
    const fs = await import("@tauri-apps/plugin-fs");
    await this.handle.seek(offset, fs.SeekMode.Start);
    let written = 0;
    while (written < data.length) {
      const n = await this.handle.write(data.subarray(written));
      if (!n) throw new Error('SHORT_WRITE');
      written += n;
    }
  }
  async finalize(_meta: FileMeta): Promise<void> {
    await this.handle.close();
    this.handle = null;
    const fs = await import('@tauri-apps/plugin-fs');
    if (await fs.exists(this.path)) throw new Error('DESTINATION_EXISTS');
    await fs.rename(this.temporary, this.path);
    this.temporary = '';
  }
  async abort(): Promise<void> {
    if (this.handle) { await this.handle.close(); this.handle = null; }
    if (this.temporary) { const fs = await import('@tauri-apps/plugin-fs'); await fs.remove(this.temporary); this.temporary = ''; }
  }
}

export async function makeReaderFromFile(file: File): Promise<FileReader> {
  return new BrowserFileReader(file);
}

export async function makeWriters(baseDir: string, metas: FileMeta[]): Promise<FileWriter[]> {
  return metas.map((m) => new TauriFileWriter(`${baseDir}/${m.name}`));
}

// ---------------- Receiver: the user picks where to save (File System Access API) ----------------
// Both Tauri (WebView2=Chromium) and browsers natively support showDirectoryPicker / showSaveFilePicker;
// when unavailable, error out directly (rather than silently writing an empty file) and let the UI prompt the user.
// selectSaveDirectory() must be called within a user-gesture (click) context.

type DirHandle = any; // FileSystemDirectoryHandle
type FileHandle = any; // FileSystemFileHandle

let saveDir: DirHandle | null = null;
export function setSaveDir(h: DirHandle | null): void {
  saveDir = h;
}
export function getSaveDir(): DirHandle | null {
  return saveDir;
}
export function hasSaveDir(): boolean {
  return saveDir !== null;
}

export async function selectSaveDirectory(): Promise<DirHandle | null> {
  try {
    if (isTauri()) {
      const dialog = await import('@tauri-apps/plugin-dialog');
      return await dialog.open({ directory: true, multiple: false, title: '选择接收文件夹' });
    }
    // Mobile browsers (iOS Safari / Android Chrome) have no File System Access API,
    // so no writable directory handle is obtainable → don't try to pop the picker (it won't show), just fall back to "auto-download after completion".
    if (!("showDirectoryPicker" in window)) return DOWNLOAD_SINK;
    return await (window as any).showDirectoryPicker();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return null;
    throw error;
  }
}

// Whether the current environment can really "pick a save folder". Always false on mobile (auto-download only).
// The judgment lives in env.ts; the UI hint text and this capability check must come from the same source.
export function canPickSaveDirectory(): boolean {
  return canSaveToFolder();
}

// Fallback receive target: not a real directory, just a marker so makeReceiverWriter takes the DownloadWriter path.
const DOWNLOAD_SINK: DirHandle = { name: "浏览器下载", downloadSink: true };
export function isDownloadSink(dir: DirHandle | null): boolean {
  return !!dir && dir.downloadSink === true;
}

// Mobile receive fallback: with no writable directory, accumulate chunks in memory and trigger one browser download in finalize.
// The cost is the file's size in memory (only kicks in on FSA-less environments like mobile).
export class DownloadWriter implements FileWriter {
  private chunks: Uint8Array[] = [];
  private dead = false;
  constructor(private name: string) {}
  async prepare(_meta: FileMeta): Promise<void> {}
  async writeAt(_offset: number, data: Uint8Array): Promise<void> {
    // Must copy: what channel passes in is a view over a reused buffer (`this.block.subarray(...)`,
    // allocated once per file and overwritten block by block); keeping the reference would turn the whole file into the last block's content.
    // FsBufferedWriter handles it the same way (it copies with new Uint8Array(data)).
    this.chunks.push(new Uint8Array(data));
  }
  async finalize(meta: FileMeta): Promise<void> {
    // Cancelled/failed files produce no download (the normal channel path never finalizes after abort; this is a backstop).
    if (this.dead) return;
    const parts = this.chunks;
    this.chunks = [];
    const blob = new Blob(parts as BlobPart[], { type: meta.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // The Blob URL can be reclaimed once the download starts; keep a 1-minute margin so a large file isn't revoked mid-read.
    // unref: in browsers setInterval/setTimeout return a number (no such method); in Node tests it lets the process exit normally.
    const timer = setTimeout(() => URL.revokeObjectURL(url), 60000) as unknown as { unref?: () => void };
    timer.unref?.();
  }
  async abort(): Promise<void> {
    this.dead = true;
    this.chunks = [];
  }
}

// OPFS receive path for FSA-less browsers (mobile): stream into the Origin Private File System instead of
// buffering the whole file as a Blob (DownloadWriter), so multi-GB transfers do not OOM. The file is then
// handed straight to a browser download from the OPFS handle (zero in-memory copy).
// Only used at or above OPFS_MIN_SIZE: on a real iPhone FileSystemWritableFileStream.write() behaves like
// synchronous disk I/O and can stall the receive pipeline, so smaller files stay on the in-memory path.
// No Worker is used: a main-thread async createWritable already streams without accumulating a full-file Blob.
// (createSyncAccessHandle is iOS-unavailable, and the zero-copy export below already removes the second peak.)

// OPFS is not guaranteed to be usable even when the API exists: Safari Private Browsing, old WebKit builds and
// restricted WebViews all expose the API but reject or stall writes. So probe by actually writing — and never
// decide from navigator.storage.estimate() alone: a quota number does not prove the sandbox is writable.
export async function probeOpfsWritable(): Promise<boolean> {
  try {
    const storage = navigator.storage as (StorageManager & { getDirectory?: () => Promise<any> }) | undefined;
    if (!storage?.getDirectory) return false;
    const root = await storage.getDirectory();
    const name = `.probe-${crypto.randomUUID()}`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array([0]));
    await writable.close();
    await root.removeEntry(name);
    return true;
  } catch { return false; }
}
// One probe per page: capability does not change while the page is alive.
let opfsProbe: boolean | undefined;
async function opfsWritable(): Promise<boolean> {
  if (opfsProbe === undefined) {
    opfsProbe = await probeOpfsWritable();
    if (!opfsProbe) console.warn('[p2p] OPFS 不可写，回退内存下载');
  }
  return opfsProbe;
}
// Safari detection is only for user-facing guidance; it never decides capability — the probe does.
function isSafari(): boolean {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}
// A successful probe is not a guarantee: storage permission or page state can still change mid-transfer.
function isOpfsTransientError(e: unknown): boolean {
  return e instanceof DOMException && ["UnknownError", "QuotaExceededError", "NotAllowedError", "InvalidStateError"].includes(e.name);
}
// Above this size the in-memory download fallback becomes risky; tell the user instead of retrying OPFS forever.
const OPFS_FALLBACK_WARN_SIZE = 512 * 1024 * 1024;
// Below this size the in-memory path is fine and measurably safer (see the stall note above); at or above it,
// buffering the whole file would risk OOM, so OPFS is used whenever the probe says it is really writable.
const OPFS_MIN_SIZE = 1024 * 1024 * 1024;
export class OpfsWriter implements FileWriter {
  private writable: any = null;
  private handle: any = null;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private nextOffset = 0;
  private readonly FLUSH = 4 * 1024 * 1024;
  constructor(private name: string) {}
  async prepare(_meta: FileMeta): Promise<void> {
    const root = await (navigator.storage as any).getDirectory();
    this.handle = await root.getFileHandle(this.name, { create: true });
    this.writable = await this.handle.createWritable();
  }
  async writeAt(offset: number, data: Uint8Array): Promise<void> {
    try {
      // Reliable ordered DC: blocks arrive with monotonically increasing offset. On abnormal out-of-order arrival, flush first then seek.
      if (offset !== this.nextOffset) {
        await this.flush();
        await this.writable.write({ type: 'write', position: offset, data });
        this.nextOffset = offset + data.length;
        return;
      }
      this.chunks.push(new Uint8Array(data));
      this.buffered += data.length;
      this.nextOffset += data.length;
      if (this.buffered >= this.FLUSH) await this.flush();
    } catch (e) {
      // Give up on the sandbox instead of stalling the receive pipeline forever (see isOpfsTransientError).
      if (isOpfsTransientError(e)) { await this.abort().catch(() => {}); throw new Error('OPFS_UNAVAILABLE'); }
      throw e;
    }
  }
  private async flush(): Promise<void> {
    const chunks = this.chunks;
    if (!chunks.length) return;
    const buffered = this.buffered;
    this.chunks = [];
    this.buffered = 0;
    const pos = this.nextOffset - buffered;
    const data = chunks.length === 1 ? chunks[0] : new Blob(chunks as BlobPart[]);
    await this.writable.write({ type: 'write', position: pos, data });
  }
  async finalize(_meta: FileMeta): Promise<void> {
    try {
      await this.flush();
      await this.writable.close();
    } catch (e) {
      if (isOpfsTransientError(e)) { await this.abort().catch(() => {}); throw new Error('OPFS_UNAVAILABLE'); }
      throw e;
    }
    // Export: hand the OPFS File directly to the browser download — zero in-memory copy of the file content
    // (the blob URL references the OPFS file, not a JS-side copy), avoiding a second multi-GB peak.
    const file = await this.handle.getFile();
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // The OPFS backing file is private to the origin; keep it until the download has read it, then clean up the sandbox.
    const t = setTimeout(() => { URL.revokeObjectURL(url); void this.handle.remove().catch(() => {}); }, 60000) as unknown as { unref?: () => void };
    t.unref?.();
  }
  async abort(): Promise<void> {
    this.chunks = []; this.buffered = 0;
    if (this.writable) await this.writable.abort().catch(() => {});
    if (this.handle) await this.handle.remove().catch(() => {});
  }
}

// Open a writable file handle: prefer the already-chosen directory; otherwise fall back to a single-file picker; error if neither is supported.
async function openSaveHandle(meta: FileMeta, dir: DirHandle): Promise<FileHandle> {
  if (dir) return dir.getFileHandle(meta.name, { create: true });
  if ("showSaveFilePicker" in window) {
    try {
      return await (window as any).showSaveFilePicker({ suggestedName: meta.name });
    } catch {
      throw new Error("已取消选择保存位置");
    }
  }
  throw new Error("当前环境不支持选择保存位置，无法接收文件");
}

// Streaming chunked writes: buffer in arrival order and flush once 4MB is accumulated,
// turning ~12000 writes for 3GB into ~750 — avoiding whole-file buffering (prevents OOM / empty files) while greatly improving write throughput.
export class FsBufferedWriter implements FileWriter {
  private writable: any = null;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private nextOffset = 0;
  private readonly FLUSH = 4 * 1024 * 1024;

  constructor(private handle: FileHandle) {}

  async prepare(_meta: FileMeta): Promise<void> {
    this.writable = await this.handle.createWritable({ keepExistingData: false });
  }

  async writeAt(offset: number, data: Uint8Array): Promise<void> {
    // Reliable ordered DC: blocks arrive with monotonically increasing offset. On abnormal out-of-order arrival, flush first then seek.
    if (offset !== this.nextOffset) {
      await this.flush();
      await this.writable.write({ type: "write", position: offset, data });
      this.nextOffset = offset + data.length;
      return;
    }
    this.chunks.push(new Uint8Array(data));
    this.buffered += data.length;
    this.nextOffset += data.length;
    if (this.buffered >= this.FLUSH) await this.flush();
  }

  private async flush(): Promise<void> {
    const chunks = this.chunks;
    if (!chunks.length) return;
    // Snapshot before await: otherwise blocks arriving during await would be swept away by the subsequent `chunks=[]`, and pos would be miscalculated.
    const buffered = this.buffered;
    this.chunks = [];
    this.buffered = 0;
    const pos = this.nextOffset - buffered;
    // Pass multiple chunks as a Blob directly to write, skipping concatBytes' one full copy in GB-scale transfers
    const data = chunks.length === 1 ? chunks[0] : new Blob(chunks as BlobPart[]);
    await this.writable.write({ type: "write", position: pos, data });
  }

  async finalize(_meta: FileMeta): Promise<void> {
    await this.flush();
    // FSA semantics: writes go to a temp swap file first; close() atomically commits (renames) the data to the user's chosen path.
    // For GB-scale files the "write tail" is almost entirely here —— earlier write() resolves before the data truly hits disk.
    await this.writable.close();
  }
  async abort(): Promise<void> {
    this.chunks = []; this.buffered = 0;
    if (this.writable) await this.writable.abort();
    // A cancelled/failed file leaves behind the 0-byte placeholder that openSaveHandle() created via
    // getFileHandle({create:true}): no close() ever ran, so nothing was committed to it. Remove it so an
    // aborted transfer doesn't litter the user's folder with empty files. remove() is Chromium 110+;
    // where it is missing the placeholder is simply left behind (same as before this change).
    try { await this.handle.remove?.(); } catch { /* already gone / no permission — nothing to clean up */ }
  }
}

// Name-conflict avoidance must preserve the extension: `report.pdf` → `report (1).pdf`.
// The old writing put "(1)" after the extension (`report.pdf (1)`), turning the Windows extension into `.pdf (1)`,
// so double-clicking wouldn't open it with the default app; `.exe`/`.bat`/`.msi` and the like would fail outright.
export function withSuffix(name: string, suffix: number): string {
  if (!suffix) return name;
  const dot = name.lastIndexOf(".");
  // dot<=0: no extension, or dot-starting name (`.gitignore`); dot at the end (`foo.`) doesn't count either.
  if (dot <= 0 || dot === name.length - 1) return `${name} (${suffix})`;
  return `${name.slice(0, dot)} (${suffix})${name.slice(dot)}`;
}

const destinations = new Set<string>();
const browserDestinations = new WeakMap<object, Set<string>>();
export async function makeReceiverWriter(meta: FileMeta, directory: DirHandle = getSaveDir()): Promise<FileWriter> {
  if (!directory) throw new Error('SAVE_PERMISSION_REQUIRED');
  const native = typeof directory === 'string';
  const download = !native && isDownloadSink(directory);
  const fs = native ? await import('@tauri-apps/plugin-fs') : undefined;
  const path = native ? await import('@tauri-apps/api/path') : undefined;
  let locks = destinations;
  if (!native && !download) { locks = browserDestinations.get(directory) ?? new Set<string>(); browserDestinations.set(directory, locks); }
  let name = meta.name; let key = '';
  // In download mode there is no queryable directory; the browser adds its own "(1)" suffix on conflict, so no existence probe here.
  for (let suffix = 0; !download; suffix++) {
    if (suffix > 10000) throw new Error('NAME_CONFLICT_LIMIT');
    name = withSuffix(meta.name, suffix);
    key = native ? (await path!.join(directory, name)).toLowerCase() : name.toLowerCase();
    if (locks.has(key)) continue;
    locks.add(key); // Reserve before any asynchronous existence check.
    let exists = false;
    try {
      if (native) exists = await fs!.exists(await path!.join(directory, name));
      else {
        try { await directory.getFileHandle(name); exists = true; }
        catch (e) { if ((e as DOMException).name !== 'NotFoundError') throw e; }
      }
    } catch (e) { locks.delete(key); throw e; }
    if (!exists) break;
    locks.delete(key);
  }
  const resolvedPath = native ? await path!.join(directory, name) : `${directory.name}/${name}`;
  let inner: FileWriter;
  try {
    inner = native
      ? new TauriFileWriter(resolvedPath)
      : download
        ? (meta.size >= OPFS_MIN_SIZE && await opfsWritable() ? new OpfsWriter(name) : new DownloadWriter(name))
        : new FsBufferedWriter(await openSaveHandle({ ...meta, name }, directory));
  }
  catch (e) { locks.delete(key); throw e; }
  const writer: FileWriter = {
    prepare: (m) => inner.prepare(m), writeAt: (o, b) => inner.writeAt(o, b),
    finalize: async (m) => { await inner.finalize(m); locks.delete(key); },
    abort: async () => { try { await inner.abort(); } finally { locks.delete(key); } },
  };
  // In-memory fallback buffers the whole file, so say so when the file is big: the fix is leaving private mode
  // or switching browser, not retrying OPFS.
  const notice = !native && download && inner instanceof DownloadWriter && meta.size > OPFS_FALLBACK_WARN_SIZE
    ? (isSafari()
      ? "当前浏览器模式不支持直接保存（如 Safari 无痕模式）：已改用内存下载，大文件可能内存不足，建议退出无痕模式或改用 Chrome / Edge / 桌面端"
      : "当前环境不支持直接保存：已改用内存下载，大文件可能内存不足")
    : undefined;
  // Expose the final (possibly collision-suffixed) filename so the UI can tell the user the real saved name.
  return Object.assign(writer, { savedName: name, notice });
}
