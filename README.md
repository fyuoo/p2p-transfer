# p2p-transfer

[English](README.md) | [简体中文](README.zh-CN.md)

Self-hostable browser-to-browser file transfer over WebRTC.

Files travel over a WebRTC DataChannel between the two browsers. A separate
signaling server brokers the handshake only — rooms, presence, invites, SDP and
ICE candidates. **The signaling server never receives or stores file contents.**

Two accuracy notes up front, because they are the most common misconceptions:

- **TURN may carry your data.** When a direct peer connection cannot be
  established, WebRTC falls back to a TURN relay, and your traffic then passes
  through that relay. It is still encrypted between the browsers — TURN only
  sees encrypted packets and connection metadata, not file contents.
- **Deploying the signaling server does not give you NAT traversal.** It only
  does signaling. Cross-network, symmetric-NAT, corporate and mobile networks
  usually need a STUN/TURN server as well.

## Repository layout

```
app/web/                    TypeScript web client (desktop + mobile entries, Vite)
public/                     Shared signaling contract (TypeScript, source of truth)
server/signaling-server/    Node.js signaling server (rooms, tokens, admin, REST credentials for TURN)
```

`app/web` is the shared frontend for both the browser and the desktop shell.
The desktop shell itself (Tauri, `app/windows`) and the webview adapter
(`app/web/src/tauri/`) are **not** part of this repository.

## Quick start

```bash
# 1) signaling server
cd server/signaling-server
npm install
cp signaling.config.example.json signaling.config.json   # adjust as needed
npm run dev                                               # listens on ws://127.0.0.1:8787

# 2) web client
cd app/web
npm install
npm run dev                                               # http://localhost:5173
```

The web client locates the signaling server via the `?sig=ws://<host>:8787`
URL parameter, `app/web/config/app-config.js` (deployment-time override, not
tracked), or the `ws://localhost:8787` default.

**Use HTTPS/WSS in production.** A page served over HTTPS cannot open a plain
`ws://` connection (mixed content is blocked), so the signaling server must be
reached over `wss://` — typically by terminating TLS in front of it.

## What the signaling server sees — and what it does not

| Data | Visible to signaling server |
|---|---|
| File contents | **No** — never received, never stored |
| File names, sizes, counts | Yes (sent in the transfer manifest) |
| Room, device names, transfer IDs | Yes |
| Connection timing, SDP, ICE candidates | Yes |
| File contents at a TURN relay | **No** — encrypted traffic and metadata only |

WebRTC encrypts the DataChannel with DTLS, so file bytes are protected in
transit. Note the trust model though: the signaling server still participates in
connection negotiation, and there is currently **no out-of-band fingerprint or
identity verification** between peers. If you do not trust the signaling
operator, self-host it. If you self-host, protect the admin interface and the
TURN secret (see [SECURITY.md](SECURITY.md)).

## NAT traversal (STUN/TURN)

- Same LAN, or simple NAT: host/server-reflexive candidates are usually enough.
- Across the public internet, symmetric NAT, corporate networks, mobile
  carriers: you almost certainly need TURN.
- TURN over UDP has the best throughput; TCP/TLS variants trade throughput for
  firewall compatibility.
- This project ships coturn-compatible REST credentials: the server signs
  short-lived credentials per connection and the long-term secret
  (`SIG_TURN_SECRET`) never leaves the server.

## Browser support and current limitations

- **HTTPS or `localhost` is required** (secure context) for WebRTC and for the
  Origin Private File System (OPFS) used by large downloads.
- **Safari private browsing** can make OPFS writes fail with `UnknownError`.
  The client probes OPFS by actually writing a byte before use and falls back to
  an in-memory download, reported as an environment limitation rather than a
  transfer failure. Very large files may exceed mobile memory limits.
- **Mobile browsers may suspend a backgrounded tab**, which stalls an in-flight
  transfer. Keep the tab in the foreground.
- **Transfers are live, peer-to-peer sessions.** There is no offline inbox —
  both peers must be online. A transfer cannot be resumed after a reload or
  disconnect; it must be restarted.
- Folder/directory transfer is not supported (a flat list of files is).
- UI copy, the admin page and the `token-admin` CLI output are currently
  **Chinese only**. There is no i18n layer yet — strings are hardcoded — so
  adding a language first requires extracting them.

## Access tokens

The server supports per-client access tokens with expiry, issued either from
the browser admin page at `/admin/` (set `SIG_ADMIN_TOKEN`) or with the
zero-dependency CLI:

```bash
cd server/signaling-server
SIG_ADMIN_TOKEN=<admin-token> node scripts/token-admin.mjs issue --days 3
```

Plain tokens are stored only as SHA-256 hashes.

## Tests

```bash
cd app/web                  && npm run typecheck && npm run build
cd app/web                  && node --test test/download-writer.test.mjs test/status-level.test.mjs test/auth-labels.test.mjs test/env.test.mjs test/token-ttl.test.mjs test/ice-config.test.mjs
cd server/signaling-server  && npm test          # server suite
```

`npm test` additionally runs an end-to-end transfer suite that needs a live
browser environment and is not part of the CLI-verifiable set; prefer the
explicit per-suite command above.

## Entry points once deployed

`/` (desktop), `/mobile.html` (mobile), `/admin/` (token management),
`/healthz` (liveness).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see
[SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
