# FluxDrop signaling — Cloudflare Worker (v5 roadmap E15)

The **serverless signaling adapter**: the same socket.io wire contract as the
Bun server ([`mini-services/signaling`](../../mini-services/signaling)),
implemented on one Durable Object with WebSocket hibernation. Zero-cost
self-hosting on Cloudflare's free tier next to the Bun deployment — pick
whichever runtime your infrastructure prefers; clients can't tell the
difference (verified: `test/smoke.ts` drives the STOCK socket.io-client
through every contract point).

## Quick start

```bash
bun install
bun run dev          # wrangler dev (miniflare) on :8787
bun run test:smoke   # boots dev + runs the 12-check wire conformance roundtrip
```

Point a client at it:

- **Web app**: Settings → Network → Signaling server → `http://localhost:8787`
  (behind the sandbox gateway: `/?XTransformPort=8787`). The client's
  `transports: ['websocket', 'polling']` tries websocket first — that's this.
- **SDK / CLI**: pass `signalUrl: 'https://your-worker.workers.dev'`.

## Deploy

```bash
bunx wrangler login
bunx wrangler secret put ADMIN_TOKEN   # optional — enables /admin/api JSON
bun run deploy
```

Free-tier cost profile: DO requests + WebSocket messages are metered in the
tens of millions per month before any billing — a personal/hobby signaling
hub is effectively **$0**. Room state persists in DO storage (SQLite class),
so hibernation/eviction never loses a room mid-transfer.

## Contract coverage vs the Bun server

| Capability | Bun server | This worker |
|---|---|---|
| Rooms (create/join/rejoin, PIN, oneJoin links, cap 8) | ✅ | ✅ |
| Pairing + WebRTC offer/answer/ICE relay | ✅ | ✅ |
| Transfer lifecycle (manifest/accepted/complete/cancel/resume) | ✅ | ✅ |
| E2E PAKE relay (`e2e-relay`, opaque) | ✅ | ✅ |
| Chunk relay fallback (`relay-data`/`relay-ack`) | ✅ | ✅ per-room bucket + lifetime cap |
| Relay per-IP quota | ✅ | ❌ (per-room only — see note) |
| Share links (`POST /link`) | ✅ | ✅ |
| `/healthz` · `/region` · `/turn-credentials` | ✅ | ✅ |
| Admin dashboard (HTML) | ✅ | ❌ JSON `/admin/api` only |
| `/nearby` LAN discovery | ✅ | ❌ |
| Webhooks / event bus (E14) | ✅ | ❌ |
| Federation (E17) | ✅ | ❌ |
| Speedrun leaderboard (F19) | ✅ | ❌ |

**Per-IP quota note:** Workers see `CF-Connecting-IP`, but a per-IP token
bucket shared across DO instances needs a KV/DO counter — out of scope for
the template. The per-room bucket + lifetime cap bound the worst case.

**Transport note:** engine.io **v4 over WebSocket only**. socket.io clients
that insist on polling (e.g. `transports: ['polling']`) get a 426. The
FluxDrop web client, SDK and CLI all try websocket first.
