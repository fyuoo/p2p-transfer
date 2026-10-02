# Windows Native Transport Protocol (first edition)

> 2026-09-17 update: the control plane has been reworked into a standalone TS service; see `server/signaling-server/README.md` and `public/signaling.ts`. The mDNS, local WebSocket, and 8 signaling sessions mentioned below belong to the first-edition history; the current Windows build uses a single active WS/WSS connection registered to the central service and no longer starts a local listener. The data plane is unchanged.

Implementation: `app/windows/src/native/`. Dependency pinned to `webrtc = 0.14.0`, using the existing async PeerConnection/DataChannel API. It does not implement ICE, DTLS, or SCTP itself.

## Scope

Windows native ↔ Windows native, with host ICE on the LAN. The mDNS TXT `engine=windows-native-v1` is used for capability filtering. Each active task owns one PeerConnection and one reliable + ordered DataChannel with label `windows-native-v1`. Multiple files within a task share that task connection and are transferred in sequence.

The browser continues to use the TypeScript v2 protocol; the two protocols do not interoperate at present. Phone, cross-network STUN/TURN, per-device connection reuse, and persistent resume are not yet implemented. Folders are deferred to a later stage.

## Control plane and authorization

The existing local WebSocket signaling sends `{type:"signal",data:{engine:"windows-native-v1",transferId,kind,...}}`.

| kind | content and trigger |
|---|---|
| invite | `files:[{name,size}]`; sent after the Rust file picker confirms; does not carry the local path |
| accept | sent after the local user clicks receive and picks a save directory via the Rust directory picker |
| offer / answer | `sdp` is an RTCSessionDescription; contains collected host candidates, no trickle ICE |
| cancel | reject, cancel, timeout, or failure; bound to a task ID and peer ID |

The file read path and receive directory are kept only in Rust. The remote side cannot specify the save directory, invoke a local confirmation event, or alter an already-accepted manifest. An unconfirmed task does not create a receive file or a native PeerConnection. The receive decision times out after 120 seconds.

## Data plane

Binary frame: `fileIndex:u32LE | offset:u64LE | payload`, total length at most 32,768 bytes. `webrtc-rs 0.14`'s on_message buffer is 65,535 bytes, so a 65,536-byte message cannot be sent.

The verification logical block is 262,144 bytes; framing must not cross a logical block boundary. The digest follows `sha256-chain-v2`:

1. `root=SHA256(UTF8("p2p:sha256-chain-v2:<size>:262144"))`.
2. For each block compute `root=SHA256(root || SHA256(block))`.
3. Empty files use the initial root; the digest is encoded as lowercase hexadecimal.

Control messages are JSON strings, at most 4 KiB:

| type | fields | semantics |
|---|---|---|
| ready | grant=4194304 | receiver ready, initial cumulative credit |
| credit | grant | cumulative bytes already handed to the buffered writer + 4 MiB |
| finish | index, hash | sender has finished sending the current file |
| committed | index | receiver verified successfully, flushed, sync_all, committed without overwrite |
| complete | none | sent after all files received committed |
| complete-ack | none | receiver confirms task completion |

Credit accumulates across files and is only released after a complete logical block enters the buffered writer. Credit does not represent persistence; `committed` is what represents a committed file. All frames are checked by file index, exact contiguous offset, and declared length. Failure, disconnect, or cancel does not announce completion; committed files are kept, and the current `.part` is attempted to be cleaned up. A process crash may leave a `.part` behind; there is no startup scan-and-recover yet.

## Resource limits

- Send up to 2 tasks, receive up to 2 tasks; waiting tasks count at most 100 unfinished tasks; memory records keep at most 300, and historical terminal states are purged upon reaching the threshold.
- At most 2 active connection handshakes; receive handshakes use a separate receive quota to avoid bidirectional wait deadlock.
- Global default send limit 64 MiB/s, adjustable in the UI, 0 means unlimited. Receive credit is always in effect independently of the limit.
- The send buffer additionally has a 4 MiB high watermark and a 2 MiB low watermark, woken by the library's low-watermark event, to avoid relying solely on the peer's credit.
- Per-task receive message queue 160 entries (about 5 MiB at most); single-file write buffer 4 MiB; send/receive logical block 256 KiB. Library, system socket, and WebView memory are not counted in these application queue capacities; a hard process-wide memory cap has not been set yet.
- 1–1000 files per batch, total file-name bytes at most 128 KiB; reject Windows reserved names, path separators, ADS, control characters, etc.
- SDP collection timeout 20 s, data channel establishment 30 s, message send 30 s, no data progress 60 s, wait for further signaling 300 s.
- At most 8 signaling sessions, signaling send queue 64 entries, single message 256 KiB, receive rate limit 256 entries/s.

## File commit

Create a random `.p2p-*.part` in the user-selected target directory and use Tokio for sequential read / buffered write. After verification passes, perform `flush`, `sync_all`, and close the file, then call `persist_noclobber`. Same-name files use `1-<original-name>`, `2-<original-name>`, etc.; the final commit is adjudicated by the no-overwrite operation and does not rely on a racy exists check.

Completion of a transfer does not mean a multi-file transaction: if earlier files succeeded but a later file fails, the committed files are not rolled back. The UI shows the count of confirmed-on-disk files. The control plane is currently LAN discovery plus plaintext WebSocket, with no pairing identity authentication yet; it cannot be treated as a finished product facing an untrusted public network.

## Verification and running

Run `npm run tauri -- dev` in `app/web`; testing on the same machine requires starting two app processes — two browser windows will not run the Rust engine. The release build uses `npm run tauri -- build --no-bundle`.

Automated verification: `npm test`, `npm run build`, and in `app/windows` run `cargo test --offline --lib native`. The native tests check, over real local WebRTC connections, multi-window credit, non-block-aligned data, multi-file, empty file, digest corruption, cancel, and no-overwrite commit; real dual-machine 3 GiB throughput, disk-full, and UI operations still require environment testing.
