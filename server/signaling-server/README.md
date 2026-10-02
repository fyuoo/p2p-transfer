# Standalone signaling service

TypeScript + Node.js 22+, runs on Windows / Linux / macOS. It only relays device status, invitations, SDP / ICE — never file contents. Windows uses the Rust WSS client; browsers use the TS client.

## Start

In this directory:

```sh
npm ci
npm run build
npm start
```

Listens on `127.0.0.1:8787` by default; client address `ws://127.0.0.1:8787`. The repo also has a compatibility entry `app/web npm run signal`, but you still need to install dependencies in this directory first.

LAN deployment (PowerShell):

```powershell
$env:SIG_HOST = '0.0.0.0'
$env:SIG_PORT = '8787'
$env:SIG_TOKEN = 'replace-with-a-long-random-secret'
npm start
```

Linux / macOS:

```sh
SIG_HOST=0.0.0.0 SIG_PORT=8787 SIG_TOKEN=replace-with-a-long-random-secret npm start
```

Clients fill in `ws://server-LAN-IP:8787`, the same room, and the access token. Both the Windows and browser UIs have input fields; the token is never put in the URL nor saved to browser storage. Windows can also be configured via the `SIG_URL`, `SIG_ROOM`, `SIG_TOKEN` env vars, where UI changes only affect the current process. Default room is `default`.

For public deployment, run WSS behind a TLS reverse proxy; the service itself listens on internal HTTP/WS. HTTPS pages must also use WSS. Windows validates the server certificate using the system root store. The reverse proxy must support WebSocket upgrade, and its read timeout should exceed 60s. Set `SIG_ORIGINS=https://app.example.com,https://other.example.com` to restrict web origins; native clients send no Origin, so they still authenticate by token. `GET /healthz` returns health status and the online count. The token-management API lives under `/admin/*` (`POST /admin/tokens` to issue, `GET /admin/tokens` to list, `POST /admin/tokens/revoke` to revoke, `?status=active|expired|revoked` to filter), all requiring `Authorization: Bearer <SIG_ADMIN_TOKEN>`; repeated auth failures trigger a brief cooldown. The CLI tool `scripts/token-admin.mjs` (zero-dependency single file, can point at a remote service via `--url`). The browser admin page is at `GET /admin/` (served directly by the server, reusing the same reverse proxy, so no cross-origin issues; phones can issue/list/revoke directly; the page itself holds no credentials — once `SIG_ADMIN_TOKEN` is entered it is sent by the page's fetch with the Bearer). Under a reverse proxy, `/admin/*` and `/healthz` are **plain HTTP** and will not be matched by a `Connection: Upgrade` ws rule, so they need a separate proxy rule, otherwise they fall through to the static site and return index.html.

## Protocol and isolation

Shared definitions: `public/signaling.ts`, version `1`. Every client message carries `version/type/requestId`. Registration `hello` carries `sessionKey/name/room/engine/token?`. The server derives the device ID from the SHA-256 of the random sessionKey; client reconnect and server restart do not change the current instance ID; restarting the app / refreshing the page generates a new identity. sessionKey is the reconnect credential and is never broadcast to other devices.

`welcome` returns the self ID and the list of compatible devices; `peer-join/peer-leave` update online status. The `from` field in relayed messages is written by the server, so clients cannot impersonate another source. `ack` only means the server accepted the relay, not that the user accepted or that the file was delivered; errors come back via `error {requestId,code}`.

Device lists are isolated by room; browsers and the Windows native client can discover each other. Cross-engine file transfer is off by default; with `SIG_ENABLE_CROSS_ENGINE=1` set, both sides must declare `wireProtocol: "transfer-v2"` to exchange tasks, SDP/ICE, and DataChannel data. A room is an isolation namespace, not a private-room password; the current model is a shared access-token, not an account system or per-room ACL.

The server binds transferId to sender and receiver, rejecting third-party accept/cancel, unaccepted native SDP offers, and wrong-direction answers. Browser SDP belongs to the device session and may be exchanged before the task invitation; final file authorization is still enforced by the client.

## Resources and disconnect behavior

- Up to 128 connections; unregistered for 10s closes; max message 256 KiB; up to 256 messages per connection per second; send buffer cap 1 MiB, compression off.
- 20s heartbeat reclaims unresponsive connections. Clients use jittered exponential backoff, up to ~30s.
- Windows send queue 64; up to 128 unacknowledged requests with a 15s timeout; browsers are likewise capped at 128 unacknowledged requests.
- Server task records capped at 4096, expiring after 24h, deleted on reject/cancel. There is no task-completion report yet; long-running high-frequency services should later add completion notifications or a persisted task index.
- A signaling disconnect or peer-leave does not actively close an already-established WebRTC. Tasks that have not finished the signaling exchange may fail or time out and need to be re-initiated; old invitations/SDP are not replayed.
- A server restart does not preserve task bindings; new tasks re-register and re-invite normally, and already-established data channels run independently. There is no multi-replica routing / shared state; the current deployment is single-instance.

A standalone signaling service does not by itself mean public-file traversal is implemented: current WebRTC still relies mainly on host ICE, and cross-NAT STUN/TURN access is implemented separately.

## Verification

```sh
npm test
```

The server tests cover auth, room/capability isolation, task ownership, message limits, heartbeat, and stable identity. Under `app/web`, run `npm run test:signaling` to verify the real-browser signaling classes; build this service first, then run `cargo test --offline --lib` under `app/windows`, where the Rust tests spin up a temporary TS service to verify registration, relay, and restart identity. The test service only listens on a random local port and is cleaned up on exit.

# Token generation tool

After starting the service with `SIG_ADMIN_TOKEN` set, run `npm run token -- 3` to generate a token valid for 3 days. The validity argument accepts 1 to 7 days; a remote service can be specified via `SIG_ADMIN_URL=http://server-IP:8787`. Equivalently, open `https://<service-address>/admin/` in a browser and do the same from the page.
