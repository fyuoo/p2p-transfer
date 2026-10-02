# Security Policy

## Scope

This covers the web client (`app/web`), the shared protocol (`public`) and the
signaling server (`server/signaling-server`).

## Secrets and deployment

The following are secrets. Never commit them, and never expose them to the
browser:

| Secret | Where it is used | Risk if leaked |
|---|---|---|
| `SIG_ADMIN_TOKEN` | issues access tokens via `/admin/` | attacker can mint valid access tokens |
| `SIG_TURN_SECRET` | signs short-lived TURN credentials | attacker can mint TURN relay credentials (bandwidth abuse) |
| `signaling.config.json` | server runtime config | contains the values above |

Notes:

- `signaling.config.json` is gitignored. Ship `signaling.config.example.json`
  only.
- The long-term TURN secret is never sent to clients: the server signs
  short-lived REST credentials per connection instead.
- Access tokens are stored only as SHA-256 hashes.

## Admin interface

`/admin/` grants token issuance. If the signaling server is reachable from the
public internet, **set `SIG_ADMIN_TOKEN`** — otherwise anyone who can reach the
page can create tokens. Consider restricting `/admin/` at the reverse proxy.

## Transport

- Serve the web client over **HTTPS** and reach the signaling server over
  **WSS**. A page loaded over HTTPS cannot open a plain `ws://` connection, and
  WebRTC plus OPFS require a secure context.
- `/healthz` is a liveness probe and exposes no secrets, but avoid exposing
  internal diagnostics publicly.

## Trust model

File bytes are encrypted in transit by WebRTC (DTLS over the DataChannel), so
neither the signaling server nor a TURN relay can read file contents. However:

- The signaling server brokers connection negotiation. A malicious or
  compromised signaling server can influence which peers are connected.
- There is currently **no out-of-band fingerprint or identity verification**
  between peers. Do not treat a connection as authenticated beyond what the
  signaling server attests.
- If you need stronger guarantees, self-host the signaling server.

## Reporting a vulnerability

Please report through **GitHub Security Advisories** (private reporting) if the
repository has them enabled. If advisories are not available, open an issue and
prefix the title with `[security]`, and avoid pasting live tokens, TURN secrets
or real deployment hostnames into the report.
