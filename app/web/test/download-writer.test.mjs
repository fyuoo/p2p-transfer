// Behavior tests for DownloadWriter (the mobile fallback writer that auto-downloads once the
// full file is received, used when directory picking is unsupported).
//
// Key regression point: what channel passes to writeAt is a view over a **reused buffer**
// (webrtc/channel.ts: `this.block.subarray(...)`, allocated once per file and overwritten block
// by block). If DownloadWriter doesn't copy but stores a reference, the whole file becomes the
// last block's content — a bug hard to spot on real devices, hence pinned as a test.
//
// Run: npm run test:writer
import { build } from 'esbuild';
import test from 'node:test';
import assert from 'node:assert/strict';

const result = await build({
  stdin: { contents: `export * from './src/file/source.ts';`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false,
  external: ['@tauri-apps/plugin-fs', '@tauri-apps/plugin-dialog', '@tauri-apps/api/path', '@tauri-apps/api/core', '@tauri-apps/api/event'],
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

// Minimal DOM / Blob URL stub: capture the "clicked download".
let captured = null;
const clicks = [];
globalThis.URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.document = {
  createElement: () => ({
    click() { clicks.push({ href: this.href, name: this.download }); },
    remove() {},
    set href(v) { this._href = v; },
    get href() { return this._href; },
  }),
  body: { appendChild() {} },
};

const bytesOf = async () => new Uint8Array(await captured.arrayBuffer());

test('Chunk writes over a reused buffer are not aliased', async () => {
  const w = new mod.DownloadWriter('a.bin');
  await w.prepare({ name: 'a.bin', size: 8, mime: 'application/octet-stream' });
  const block = new Uint8Array(4); // simulate channel's reused block
  block.set([1, 1, 1, 1]);
  await w.writeAt(0, block.subarray(0, 4));
  block.set([2, 2, 2, 2]);
  await w.writeAt(4, block.subarray(0, 4));
  await w.finalize({ name: 'a.bin', size: 8, mime: 'application/octet-stream' });
  assert.deepEqual([...(await bytesOf())], [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.equal(clicks.at(-1).name, 'a.bin');
  assert.equal(clicks.at(-1).href, 'blob:stub');
});

test('Views with byteOffset write only their own range', async () => {
  const w = new mod.DownloadWriter('b.bin');
  await w.prepare({});
  await w.writeAt(0, new Uint8Array([9, 9, 7, 8, 9]).subarray(2, 4));
  await w.finalize({ name: 'b.bin', size: 2, mime: 'application/octet-stream' });
  assert.deepEqual([...(await bytesOf())], [7, 8]);
});

test('No download is triggered after abort', async () => {
  const w = new mod.DownloadWriter('c.bin');
  await w.prepare({});
  await w.writeAt(0, new Uint8Array([1]));
  await w.abort();
  const before = captured;
  await w.finalize({ name: 'c.bin', size: 0, mime: '' });
  assert.equal(captured, before);
});

test('Fallback judgment: when no directory picker, use the download sink', () => {
  assert.equal(mod.canPickSaveDirectory(), false); // no window under Node
  assert.equal(mod.isDownloadSink({ downloadSink: true }), true);
  assert.equal(mod.isDownloadSink({ name: 'x' }), false);
  assert.equal(mod.isDownloadSink(null), false);
});

// ---- Receive dedupe: the file extension must be preserved ----
// Regression point: the old impl appended "(1)" after the extension (e.g. `report.pdf (1)`),
// so on Windows a .exe/.pdf no longer launched on double-click.
test(
  "Dedupe inserts the index before the extension (.exe/.pdf stay usable)"
  , () => {
  assert.equal(mod.withSuffix("report.pdf", 1), "report (1).pdf");
  assert.equal(mod.withSuffix("setup.exe", 2), "setup (2).exe");
  assert.equal(mod.withSuffix("archive.tar.gz", 1), "archive.tar (1).gz");
  assert.equal(mod.withSuffix("README", 1), "README (1)");
  assert.equal(mod.withSuffix(".gitignore", 1), ".gitignore (1)");
  assert.equal(mod.withSuffix("foo.", 1), "foo. (1)");
  assert.equal(mod.withSuffix("report.pdf", 0), "report.pdf");
});

test(
  "makeReceiverWriter preserves extension on name collision"
  , async () => {
  const asked = [];
  const existing = new Set(["report.pdf", "setup.exe"]);
  const dir = {
    name: "dir",
    async getFileHandle(name, opts) {
      asked.push(name);
      if (existing.has(name) || opts?.create) {
        return { async createWritable() { return { async write() {}, async close() {} }; } };
      }
      const err = new Error("NotFound"); err.name = "NotFoundError"; throw err;
    },
  };
  const meta = (name) => ({ name, size: 4, mime: "application/octet-stream" });
  const w1 = await mod.makeReceiverWriter(meta("report.pdf"), dir);
  await w1.prepare(meta("report.pdf"));
  await w1.finalize(meta("report.pdf"));
  assert.ok(asked.includes("report (1).pdf"), "should be report (1).pdf, got: " + asked.join(", "));
  assert.ok(!asked.includes("report.pdf (1)"), "must not append the index after the extension");
  assert.equal(w1.savedName, "report (1).pdf", "resolved name should be exposed for the UI");
  asked.length = 0;
  const w2 = await mod.makeReceiverWriter(meta("setup.exe"), dir);
  await w2.prepare(meta("setup.exe"));
  await w2.finalize(meta("setup.exe"));
  assert.ok(asked.includes("setup (1).exe"), "should be setup (1).exe, got: " + asked.join(", "));
});

// ---------------------------------------------------------------------------
// FsBufferedWriter (browser FSA path) — 4 MiB batching contract.
// Pinned *before* touching the implementation (the double-buffering candidate),
// because these rules are what keep GB-scale transfers at ~750 writes and what
// guarantee ordering / no data resurrection after a failed write.
// ---------------------------------------------------------------------------
const BLOCK = 256 * 1024;
const FLUSH = 4 * 1024 * 1024;
const metaOf = () => ({ name: "f.bin", size: FLUSH * 2, mime: "application/octet-stream" });
const block = (n, size = BLOCK) => { const b = new Uint8Array(size); b.fill(n % 251); return b; };

function fakeWritable(onWrite) {
  const w = {
    writes: [], closed: false, aborted: false,
    async write(req) {
      if (onWrite) await onWrite(req, w.writes.length);
      const data = req.data instanceof Blob
        ? new Uint8Array(await req.data.arrayBuffer())
        : new Uint8Array(req.data); // copy: channel hands over a view of a reused buffer
      w.writes.push({ position: req.position, data });
    },
    async close() { w.closed = true; },
    async abort() { w.aborted = true; },
  };
  return w;
}
const writerOver = (writable) => new mod.FsBufferedWriter({ async createWritable() { return writable; } });

test("FsBufferedWriter buffers below the 4 MiB threshold (and copies, never aliases)", async () => {
  const w = fakeWritable();
  const writer = writerOver(w);
  await writer.prepare(metaOf());
  const src = block(1);
  await writer.writeAt(0, src);
  src.fill(0); // channel reuses this buffer for the next block — content must already be copied
  assert.equal(w.writes.length, 0, "must not issue a write before the batch fills");
  await writer.finalize(metaOf());
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].data[0], 1, "aliased buffer would have turned the block into zeros");
});

test("FsBufferedWriter flushes one batched write once 4 MiB accumulate", async () => {
  const w = fakeWritable();
  const writer = writerOver(w);
  await writer.prepare(metaOf());
  for (let i = 0; i < FLUSH / BLOCK; i++) await writer.writeAt(i * BLOCK, block(i));
  assert.equal(w.writes.length, 1, "16 x 256 KiB blocks collapse into a single write");
  assert.equal(w.writes[0].position, 0);
  assert.equal(w.writes[0].data.byteLength, FLUSH);
  assert.equal(w.writes[0].data[0], 0);
  assert.equal(w.writes[0].data[BLOCK], 1, "second block lands at its own offset, in order");
});

test("FsBufferedWriter flushes the tail on finalize and commits the file", async () => {
  const w = fakeWritable();
  const writer = writerOver(w);
  await writer.prepare(metaOf());
  await writer.writeAt(0, block(3, 1234));
  assert.equal(w.writes.length, 0);
  await writer.finalize(metaOf());
  assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].position, 0);
  assert.equal(w.writes[0].data.byteLength, 1234);
  assert.equal(w.closed, true, "FSA close() is what commits the swap file");
});

test("FsBufferedWriter writes successive batches in order at increasing positions", async () => {
  const w = fakeWritable();
  const writer = writerOver(w);
  await writer.prepare(metaOf());
  for (let i = 0; i < (FLUSH / BLOCK) * 2; i++) await writer.writeAt(i * BLOCK, block(i));
  assert.equal(w.writes.length, 2);
  assert.deepEqual(w.writes.map(x => x.position), [0, FLUSH]);
  assert.equal(w.writes[1].data[0], 16, "second batch starts with block 16");
});

test("FsBufferedWriter flushes pending data before honouring an out-of-order offset", async () => {
  const w = fakeWritable();
  const writer = writerOver(w);
  await writer.prepare(metaOf());
  await writer.writeAt(0, block(1));
  await writer.writeAt(8 * 1024 * 1024, block(9, 100)); // abnormal: not the expected next offset
  assert.equal(w.writes.length, 2, "pending batch is flushed first, then the seek is written directly");
  assert.deepEqual(w.writes.map(x => x.position), [0, 8 * 1024 * 1024]);
  assert.equal(w.writes[0].data.byteLength, BLOCK);
  assert.equal(w.writes[1].data.byteLength, 100);
});

test("FsBufferedWriter drops the batch after a failed write instead of replaying it", async () => {
  const w = fakeWritable(async (_req, i) => { if (i === 0) throw new Error("DISK_FULL"); });
  const writer = writerOver(w);
  await writer.prepare(metaOf());
  await assert.rejects(
    (async () => { for (let i = 0; i < FLUSH / BLOCK; i++) await writer.writeAt(i * BLOCK, block(i)); })(),
    /DISK_FULL/
  );
  assert.equal(w.writes.length, 0, "a failed write is not a written write");
  await writer.finalize(metaOf());
  assert.equal(w.writes.length, 0, "the dropped batch must not be resurrected by finalize");
});

test("FsBufferedWriter abort discards buffered data and never commits the file", async () => {
  const w = fakeWritable();
  const writer = writerOver(w);
  await writer.prepare(metaOf());
  await writer.writeAt(0, block(1));
  await writer.abort();
  assert.equal(w.aborted, true);
  assert.equal(w.closed, false, "abort must not commit a partial file");
  assert.equal(w.writes.length, 0);
});

// ---------------------------------------------------------------------------
// OpfsWriter (mobile, FSA-less) — stream to OPFS, then zero-copy export.
// Keeps multi-GB transfers from holding the whole file in a Blob (DownloadWriter).
// ---------------------------------------------------------------------------
test('OPFS capability probe is false without navigator.storage', async () => {
  // Node has no OPFS: the probe must fail so writer selection falls back to DownloadWriter.
  assert.equal(await mod.probeOpfsWritable(), false);
});

test('OPFS capability probe is false when the sandbox rejects the write', async () => {
  // Safari Private Browsing exposes the API but rejects writes — the probe must catch that, not just the API check.
  const mockRoot = { async getFileHandle() { throw new DOMException('denied', 'NotAllowedError'); } };
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => mockRoot } }, configurable: true });
  try { assert.equal(await mod.probeOpfsWritable(), false); }
  finally { try { Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true }); } catch {} }
});

test('OpfsWriter maps a mid-transfer sandbox failure to OPFS_UNAVAILABLE', async () => {
  // A successful probe is no guarantee: storage can be revoked mid-transfer. The pipeline must not stall —
  // the writer aborts and surfaces OPFS_UNAVAILABLE (rendered as a browser-mode limitation, not a failure).
  let aborted = false;
  const mockHandle = {
    async createWritable() {
      return { async write() { throw new DOMException('gone', 'InvalidStateError'); }, async close() {}, async abort() { aborted = true; } };
    },
    async getFile() { return { async arrayBuffer() { return new ArrayBuffer(0); } }; },
    async remove() {},
  };
  const mockRoot = { async getFileHandle() { return mockHandle; } };
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => mockRoot } }, configurable: true });
  try {
    const w = new mod.OpfsWriter('opfs3.bin');
    await w.prepare({});
    await assert.rejects(
      () => w.writeAt(0, new Uint8Array(4 * 1024 * 1024)), // crosses the 4 MiB flush threshold
      (e) => e instanceof Error && e.message.includes('OPFS_UNAVAILABLE'),
    );
    assert.equal(aborted, true, 'the sandbox file must be discarded, not left half-written');
  } finally {
    try { Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true }); } catch {}
  }
});

test('OpfsWriter streams to OPFS and exports the file zero-copy', async () => {
  const writes = [];
  const mockFile = { size: 8, async arrayBuffer() { return new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2]).buffer; } };
  const mockHandle = {
    async createWritable() { return { async write(o) { writes.push(o); }, async close() {}, async abort() {} }; },
    async getFile() { return mockFile; },
    async remove() {},
  };
  const mockRoot = { async getFileHandle() { return mockHandle; } };
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => mockRoot } }, configurable: true });
  try {
    const w = new mod.OpfsWriter('opfs.bin');
    await w.prepare({});
    const b = new Uint8Array(4);
    b.set([1, 1, 1, 1]); await w.writeAt(0, b.subarray(0, 4));
    b.set([2, 2, 2, 2]); await w.writeAt(4, b.subarray(0, 4));
    await w.finalize({ name: 'opfs.bin', size: 8, mime: 'application/octet-stream' });
    // Zero-copy: the download source is the OPFS File handle, not a Blob assembled in JS memory.
    assert.equal(captured, mockFile);
    assert.equal(clicks.at(-1).name, 'opfs.bin');
    // Two 4-byte blocks (< 4 MiB flush) collapse into a single batched write on finalize.
    assert.equal(writes.length, 1);
    assert.equal(writes[0].position, 0);
    assert.equal(writes[0].data.size, 8);
  } finally {
    try { Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true }); } catch {}
  }
});

test('OpfsWriter abort cleans up the OPFS backing file and triggers no download', async () => {
  let removed = false, aborted = false;
  const mockHandle = {
    async createWritable() { return { async write() {}, async close() {}, async abort() { aborted = true; } }; },
    async getFile() { return { async arrayBuffer() { return new ArrayBuffer(0); } }; },
    async remove() { removed = true; },
  };
  const mockRoot = { async getFileHandle() { return mockHandle; } };
  const prevNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: async () => mockRoot } }, configurable: true });
  try {
    const w = new mod.OpfsWriter('opfs2.bin');
    await w.prepare({});
    await w.writeAt(0, new Uint8Array([1, 2, 3]));
    const before = captured;
    await w.abort();
    assert.equal(aborted, true);
    assert.equal(removed, true, 'abort must remove the OPFS backing file');
    assert.equal(captured, before, 'no download after abort');
  } finally {
    try { Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true }); } catch {}
  }
});
