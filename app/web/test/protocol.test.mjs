// Protocol self-test (pure JS, runnable directly with Node): verifies the framing + streaming
// hash algorithm matches public/protocol.md.
// Run: node app/web/test/protocol.test.mjs
// Note: this is an algorithm mirror (not a direct TS import), for verifying core logic without
// a browser / Rust.

const CHUNK_SIZE = 256 * 1024;

// ---- Frame: [fileIndex u32 LE][offset u64 LE][payload] ----
function encodeChunk(fileIndex, offset, payload) {
  const head = new ArrayBuffer(12);
  const dv = new DataView(head);
  dv.setUint32(0, fileIndex, true);
  dv.setUint32(4, offset >>> 0, true);
  dv.setUint32(8, Math.floor(offset / 0x100000000), true);
  const out = new Uint8Array(12 + payload.length);
  out.set(new Uint8Array(head), 0);
  out.set(payload, 12);
  return out.buffer;
}
function decodeChunk(buf) {
  const dv = new DataView(buf);
  const fileIndex = dv.getUint32(0, true);
  const lo = dv.getUint32(4, true);
  const hi = dv.getUint32(8, true);
  const offset = hi * 0x100000000 + lo;
  return { fileIndex, offset, payload: new Uint8Array(buf, 12) };
}

// ---- Hash ----
async function sha256Bytes(data) {
  const h = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(h);
}
async function sha256(data) {
  const b = await sha256Bytes(data);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- Simulate sender: two-pass streaming read, compute file-level hash ----
async function senderHash(fileBytes) {
  const digests = [];
  let off = 0;
  while (off < fileBytes.length) {
    const len = Math.min(CHUNK_SIZE, fileBytes.length - off);
    const chunk = fileBytes.subarray(off, off + len);
    digests.push(await sha256Bytes(chunk));
    off += len;
  }
  return sha256(concatBytes(digests));
}

// ---- Simulate receiver: per-block digest, assemble and compare hash once complete ----
async function receiverVerify(fileBytes, expectedHash) {
  const digestMap = new Map();
  let off = 0;
  while (off < fileBytes.length) {
    const len = Math.min(CHUNK_SIZE, fileBytes.length - off);
    const chunk = fileBytes.subarray(off, off + len);
    // round-trip through framing once, verify encode/decode loses no bytes
    const wire = decodeChunk(encodeChunk(0, off, chunk));
    if (wire.offset !== off) throw new Error(`offset mismatch ${wire.offset} != ${off}`);
    digestMap.set(wire.offset, await sha256Bytes(wire.payload));
    off += len;
  }
  const ordered = [...digestMap.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  const got = await sha256(concatBytes(ordered));
  return got === expectedHash;
}

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("PASS:", msg); }

async function main() {
  // 1) 1MB random file
  const buf = new Uint8Array(1024 * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) & 0xff;
  const h = await senderHash(buf);
  assert(await receiverVerify(buf, h), "1MB file: framing round-trip + streaming hash consistent");

  // 2) Unaligned size (prime length, exercises the trailing block)
  const buf2 = buf.subarray(0, 1000003);
  const h2 = await senderHash(buf2);
  assert(await receiverVerify(buf2, h2), "1000003 bytes (unaligned) consistent");

  // 3) Empty file
  const h3 = await senderHash(new Uint8Array(0));
  assert(h3.length === 64, "empty file hash is 64 hex chars");
  assert(await receiverVerify(new Uint8Array(0), h3), "empty file consistent");

  // 4) >4GB offset framing correctness (no real 4GB send; only the high word is verified)
  const wire = decodeChunk(encodeChunk(3, 5 * 0x100000000 + 123, new Uint8Array([1, 2, 3])));
  assert(wire.fileIndex === 3 && wire.offset === 5 * 0x100000000 + 123, ">4GB offset framing high word correct");

  // 5) Hash determinism (same input → same output)
  const hA = await senderHash(buf.subarray(0, 5000));
  const hB = await senderHash(buf.subarray(0, 5000));
  assert(hA === hB, "same input: hash deterministically consistent");

  console.log("\nAll protocol tests passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
