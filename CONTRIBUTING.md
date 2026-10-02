# Contributing

Thanks for your interest in P2P Drop. Please read this first — this repository has one
unusual property that affects where your change should go.

## This repo is a one-way export

The source of truth is a private upstream repository. Everything under `app/`, `public/` and
`server/` in this repository is **regenerated on every export** from that upstream.

That means:

- A PR that changes code under `app/`, `public/` or `server/` will be **overwritten** by the
  next export, even if it is merged here.
- Root-level docs (`README.md`, `README.zh-CN.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`)
  are preserved across exports and **can** be edited directly here.

So:

| What you want to change | Where to send it |
| --- | --- |
| Docs, typos, wording in root files | PR directly to this repo |
| Code under `app/`, `public/`, `server/` | Open an issue describing the problem and the expected behaviour; fixes land upstream and come back through the next export |

Issues are always welcome — bug reports, browser/OS combinations that fail, and deployment
questions all help.

## Reporting bugs

Please include:

- Browser and version (or desktop shell version), and OS.
- Whether both peers are on the same LAN or across the public internet.
- Whether a STUN/TURN server is configured.
- File size and whether the failure reproduces consistently.
- Any error text from the UI (it maps to a stable reason code such as `COMMIT_STALL`,
  `OPFS_UNAVAILABLE`, `CREDIT_STALL`).

## Development

```bash
cd app/web
npm install
npm run typecheck     # tsc --noEmit
npm run build
```

Signaling server:

```bash
cd server/signaling-server
npm install
npm test
```

Known state: `npm test` at the web root includes a `transfer.test.mjs` suite that hangs in some
environments. Run the stable suites individually if you hit it.

## Code style

- TypeScript for web, strict mode.
- Comments in English; user-facing strings are currently Chinese (there is no i18n layer yet —
  see the README notes before adding new hard-coded strings).
- Keep the wire protocol (`public/protocol.md`) authoritative: any change to frame layout or
  control messages must update it first.

## Security

Do not open a public issue for security problems. See [SECURITY.md](SECURITY.md).
