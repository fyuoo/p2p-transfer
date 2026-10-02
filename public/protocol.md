# P2P Drop · Shared Protocol Contract

> Version note (2026-09-16): The text below is an early protocol design record and is not the current implementation contract. The browser actually uses the v2 protocol in `app/web/src/webrtc/protocol.ts`; the Windows native first edition uses [native-protocol.md](native-protocol.md) and currently does not interoperate with the browser v2. Descriptions of out-of-order delivery, persistent resume, etc. do not necessarily reflect what is implemented.

This file is the authoritative contract shared by the **desktop (Tauri / Rust)** and the **frontend (WebView / browser)**. Each side implements its own copy and does not directly depend on the other; either side can be replaced on its own without breaking the peer.

The transport layer is unified as **WebRTC `RTCDataChannel`** (reliable + ordered; SCTP → DTLS → ICE underneath). Signaling only handles the handshake by exchanging SDP/ICE; **file bytes never traverse the signaling server**.

---

## 1. DataChannel message classification

`RTCDataChannel` distinguishes by the type of `event.data`:
- **string** → control frame (JSON)
- **ArrayBuffer** → binary data chunk

The receiver splits accordingly: strings go to control logic, ArrayBuffers go to file writing.

---

## 2. Binary data chunk frame (ArrayBuffer)

```
| fileIndex : u32 LE (4B) | offset : u64 LE (8B) | payload : bytes |
```

- `fileIndex`: the index of the file in the manifest (0-based). A single-file transfer is always `0`.
- `offset`: the byte offset of this payload within the file.
- `payload`: the file fragment, length = `min(chunkSize, remaining)`.
- The receiver writes directly to the target file at `offset` → natively supports out-of-order delivery + resume (P3).

Convention: `chunkSize` is `min(256KB, maxMessageSize - 12)` at runtime (256KB is the ceiling; the actual value depends on the browser-negotiated `maxMessageSize`). A single message = 12B header + payload.
**Sender backpressure window 8MB**: when the buffer exceeds 8MB, sending pauses; it resumes when it drops to ≤8MB (driven by the `bufferedamountlow` event), keeping the pipe full; **no artificial rate limiting**.

> **Transport isolation**: each send creates an independent `RTCDataChannel` with label `transfer:<transferId>` (transferId is a UUID). Each DC carries exactly one transfer, so `fileIndex` is locally unique within the DC; both ends may send simultaneously (full duplex) without interference.

---

## 3. Control frame (JSON string)

All control frames contain a `type` field.

| type | direction | fields | description |
|------|-----------|--------|-------------|
| `manifest` | sender→receiver | `transferId`, `files:[{fileIndex,name,size,mime,hash,blocks}]` | sent before transfer starts; `hash` is empty here (see below) |
| `start` | sender→receiver | `transferId`, `fileIndex` | notify that streaming of chunks begins |
| `ack` | receiver→sender | `fileIndex`, `blockIndex` | confirm a chunk is written (flow control / resume) |
| `complete` | sender→receiver | `transferId`, `fileIndex`, `hash`, `ok` | the **file-level hash** (hex) computed by the sender as it streams; the receiver verifies against it |
| `request` | receiver→sender | `fileIndex`, `fromOffset`, `toOffset` | resume: request a retransmit range |
| `abort` | both | `transferId`, `reason` | abort the transfer |

### Resume (current implementation)

The `request` frame in the table above is not implemented. The actual resume mechanism: the receiver reports, in the `ready` frame, the number of bytes **fully written to disk** for each file (optional field `resume: [{fileIndex, bytes}]`; absent means start from the beginning), and the sender continues from that offset.

- The resume point must be an integer multiple of `blockSize` (or exactly equal to `size`); the receiver's progress is derived from the `.part` leftover file length, and the sidecar metadata `.part.json` records only `{name, size, blockSize, blocks}` to verify it is the same file.
- The hash chain `root = sha256(root ‖ sha256(block))` is a sequential chain; on resume both sides **replay the first N blocks from disk** to rebuild root, so the final SHA-256 of the complete file can still be computed and verified.
- On verification failure (source file was modified), the `.part` MUST be discarded — otherwise the next resume would reuse corrupt data and fail forever at the same spot.
- Currently only the **desktop TCP direct connection** supports resume (the browser receiver uses the File System Access API, whose handle cannot persist across sessions).

`hash` is a **file-level integrity digest**. To support large files (GB-scale) and avoid the latency of "read the whole file twice to compute the hash, then send", **single-pass streaming** is used: the sender reads and sends block by block while accumulating each block's 32B digest; after sending everything, it computes SHA-256 over the concatenated digests = the file-level hash that is unknown at the `manifest` stage and carried in the `complete` frame.

```
sender: read block → send block + compute SHA-256 of each block (32B digest) → after all sent → sha256(concat(digests)) = fileHash → complete.hash
receiver: write block to disk + store digest by offset → after all received → sha256(concat(digests sorted by offset)) → compare with complete.hash to decide ok
```

`blocks = ceil(size / chunkSize)`.

---

## 4. Signaling messages (WebSocket JSON)

The signaling server is a **dumb relay**: it only forwards messages between the two ends by target id, without parsing WebRTC content.

### 4.1 Connection roles
- The local frontend connects to its embedded signaling service: `{ "role": "ui" }`
- An external initiator connects to the peer's signaling service: `{ "role": "peer", "session", "from", "name" }`
  - `session` = the peer device id (obtained via mDNS self-discovery), also the pairing session key.

### 4.2 Relay messages (server forwards between the two ends)
| type | meaning |
|------|---------|
| `invite` | an external peer connects in, carrying `from`/`name`/`files`/`transferId`; the UI pops a receive prompt (file name/size are visible before accepting) |
| `accept` | the UI agrees, `{ to, transferId }`; the sender only actually starts transferring after receiving this (manual confirmation gate) |
| `signal` | WebRTC handshake: `{ "session", "data": { "sdp"? , "ice"? } }` |
| `bye` | either side disconnects |

### 4.3 Pairing code and connection model
P2P is a one-to-one direct connection; the "pairing code" is for manually confirming the peer's identity (to avoid mis-connection).
- LAN: the device id is provided by mDNS; the UI shows a human-readable name + a short code.
- Public network (P4): assigned and shown by the signaling server; manually cross-checked.

**Exactly one PeerConnection per device pair**. To avoid glare (two PCs built) when both ends initiate simultaneously, a deterministic leader/follower role is used: compare `selfId` with the peer id as strings; **the larger is the leader (sends offer), the smaller is the follower (answers)**. Both ends compute the same role independently, so there is no conflict by construction.

**Manual confirmation gate (security)**: the sender first sends `invite` (with file summary + transferId); the receiver clicks "Receive" and only then replies `accept`; the sender creates the `transfer:<transferId>` DC and starts sending only after receiving `accept`. The receiver only builds a channel for an arriving transfer DC when `acceptedTransfers` contains that tid, otherwise it closes immediately — **files are never written to disk before manual confirmation, and one transfer's confirmation never leaks to another transfer**.

---

## 5. Connection establishment sequence (LAN, mDNS + embedded signaling / or Node signaling server)

```
A discovers B ──► A's frontend WS connects to signaling (handler)
B connects to signaling too; both appear in each other's device list
A selects a file → clicks "Send to B"
  A ensureSession(B): A is leader → create p2p-ctl DC + send offer
  A sendInvite(B, files, tidA) ──► B pops "Receive? A wants to send X (size)"
B clicks "Receive":
  B selects a save directory → acceptedTransfers.add(tidA) → ensureSession(A) (follower) answers offer
  B sendAccept(A, tidA) ──► A
A receives accept(tidA) → create transfer:tidA DC → manifest → start → data chunk stream → complete
B's ondatachannel(transfer:tidA) hits the confirmed tid → build Channel → write to disk per manifest → verify

(duplex) B can also select a file and send to A at the same time, following a fully symmetric flow; the two independent transfer DCs do not interfere.
```

---

## 6. Encryption
- Transport layer: WebRTC DataChannel is end-to-end **DTLS-SRTP** by default; the signaling server cannot see the content.
- Identity / at-rest encryption: P4 (token PAKE / file-at-rest encryption) — not defined by this protocol for now.
