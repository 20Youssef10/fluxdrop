# fluxdrop — headless CLI

Headless sender/receiver for [FluxDrop](../README.md) that speaks the **real v1 wire protocol** — not a reimplementation. It imports the production modules (`src/lib/fluxdrop/protocol.ts`, `src/lib/fluxdrop/encoding.ts`) directly, so a 9-byte header, 64 KiB chunks, `CHUNK_ACK` pacing, and manifest-first sequencing are byte-identical to the web client. Conformance is locked by [`scripts/protocol-conformance.ts`](../scripts/protocol-conformance.ts) (see [`docs/protocol-spec.md`](../docs/protocol-spec.md)).

```
┌─────────────┐  ws://host:3003  ┌───────────────┐  ws://host:3003  ┌─────────────┐
│ fluxdrop    │◄────────────────►│ signaling     │◄────────────────►│ browser or  │
│ send        │    room/SDP/ICE  │ mini-service  │   room/SDP/ICE   │ another CLI │
└──────┬──────┘                  └───────────────┘                  └──────┬──────┘
       └──────────────────── WebRTC DataChannel "fluxdrop-0" ─────────────────┘
```

## Requirements

- [bun](https://bun.sh) ≥ 1.1 (runtime)
- A reachable FluxDrop signaling server (default `ws://localhost:3003`)
- `node-datachannel` ships prebuilt native binaries for linux-x64, darwin-arm64/x64 and win32-x64 — on other platforms see [Platform support](#platform-support--loopback)

## Install

```bash
cd cli
bun install
```

## Usage

```bash
# ── Terminal A (sender) ───────────────────────────────────────────────
bun src/index.ts send ./report.pdf ./data.csv --ttl 5m
# fluxdrop send — 2 file(s), alias "cli-sender-kqkh"
# ┌──────────────────────────────────────────────────────────────
# │ Room code: 8MHFMP    PIN: 470417
# │ Web receiver: open http://localhost:3000 → "Join" → code + PIN
# │ CLI receiver: fluxdrop receive --room 8MHFMP --pin 470417 --out DIR
# │ Deep link:   fluxdrop://room/8MHFMP?pin=470417
# └──────────────────────────────────────────────────────────────
# waiting up to 300s for a receiver… (Ctrl+C to abort)
# receiver joined: cli-receiver-56bm
#   [rtc] connecting
#   [rtc] connected
# 🛰  DataChannel open — sending manifest…
# ⏳ 5.1 MB/5.1 MB  chunks acked 82/82 (100%)
# ✅ transfer complete — receiver verified every SHA-256 checksum

# ── Terminal B (receiver) ─────────────────────────────────────────────
bun src/index.ts receive --room 8MHFMP --pin 470417 --out ~/Downloads
# 🛰  DataChannel open — waiting for manifest…
# 📦 manifest: 2 file(s), 5373952 bytes, 82 chunks
# ⏳ 5.1 MB/5.1 MB  chunks 82/82 (100%)
# ✅ sha256 fluxdrop-e2e-test.bin: 84d1c20cbfca… == 84d1c20cbfca…
# ✅ transfer complete — SHA-256 verified
#    wrote /home/me/Downloads/fluxdrop-e2e-test.bin
```

Run `bun src/index.ts --help` for the full flag reference, or `--version`.

### Flags

| Flag | Applies to | Default | Meaning |
|---|---|---|---|
| `--signal URL` | send, receive | `ws://localhost:3003` | signaling server |
| `--ttl DURATION` | send | `5m` | how long to wait for a receiver (`30s`, `5m`, `1h`) |
| `--room CODE` | receive | — | room code printed by the sender |
| `--pin PIN` | receive | — | room PIN |
| `--out DIR` | receive, loopback | `.` | output directory |
| `--alias NAME` | send, receive | `cli-<role>-<rand>` | device alias shown to the peer |

### Loopback demo (no network)

```bash
bun src/index.ts loopback                 # uses a generated demo file
bun src/index.ts loopback a.bin b.bin --out /tmp/out
```

Runs a sender and a receiver **in-process**, wired through the real framing code (production `encoding.ts`), including manifest build, chunk slicing across file boundaries, `CHUNK_ACK` handling, the `TRANSFER_COMPLETE` handshake, and SHA-256 verification. Prints the golden-vector frame from the protocol spec as proof of which encoder produced the bytes.

## How it maps to the protocol

| Protocol step (spec §) | CLI behavior |
|---|---|
| `create-room` / `join-room` (§9) | socket.io-client against the signaling URL; PIN always requested on send |
| pairing (`pairing-request` → `pairing-confirm`) | CLI sender auto-accepts, receiver initiates pairing on `room-joined` (same as web) |
| SDP/ICE relay (§9.3) | offer from the sender (DataChannel `fluxdrop-0`), answer from the receiver, trickle ICE both ways |
| `MANIFEST` (§5.3) | built locally with streamed SHA-256 per file (`sha256sum`-compatible) |
| `CHUNK_DATA` + `CHUNK_ACK` (§5.1/5.2) | 64 KiB chunks, 32 MiB buffered-amount ceiling, bounded re-send rounds for lost/failing ACKs |
| `TRANSFER_COMPLETE` (§5.5) | `finalChecksum` = concatenated per-file digests (matches the web sender) |
| verification | receiver re-hashes every written file and answers `TRANSFER_COMPLETE_ACK {verified}` |

### E2EE status

The CLI does **not** implement the v1.2 SPAKE2 handshake — transfers are plaintext over DTLS. Pairing with the web client is fully interoperable: the web sender waits ~3.5 s for the PAKE to complete, then shows a visible **"Sending WITHOUT end-to-end encryption"** toast and proceeds. That downgrade is by design (and visible), not silent.

`--no-e2e` is accepted for symmetry; it is the only mode the CLI has.

## Platform support & loopback

`node-datachannel` (libdatachannel bindings) provides the WebRTC stack. It works wherever prebuilt binaries install cleanly (verified: linux-x64). If it fails to load on your platform, `send`/`receive` exit with a clear error pointing at `loopback`, which exercises everything except the network/WebRTC layer.

If you extract this CLI from the monorepo, copy `src/lib/fluxdrop/protocol.ts` + `encoding.ts` next to `cli/src/` and update `src/proto.ts` — the conformance suite will validate the copies.

## Development

```bash
bun src/index.ts loopback                          # offline protocol check
bun scripts/protocol-conformance.ts                 # from repo root — full wire conformance
cd cli && bun install && bun src/index.ts --help
```

Layout:

```
cli/
├── package.json          # bin entry, deps: socket.io-client + node-datachannel
├── src/
│   ├── index.ts          # CLI entry: arg parsing, send/receive/loopback commands
│   ├── proto.ts           # re-exports the REAL production protocol/encoding modules
│   ├── signaling.ts       # socket.io-client wrapper (event names from SIGNALING_EVENTS)
│   ├── peer.ts            # node-datachannel Peer/DataChannel wrapper ('fluxdrop-0')
│   ├── transfer.ts        # Send/Receive engines: manifest, chunking, ACKs, verify
│   ├── loopback.ts        # in-process demo (real framing, no network)
│   └── util.ts            # streamed SHA-256, formatting, argv parsing
└── README.md
```
