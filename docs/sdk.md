# FluxDrop JS SDK (`@fluxdrop/sdk`)

> Feature 9.3 — Public JS SDK scaffold. Embed FluxDrop send/receive into any web app: docs sites, support chats, LMS portals.

The SDK lives in [`sdk/`](../sdk) and is **three layers**:

| Layer | Path | Status |
|---|---|---|
| **Engine** — wire protocol, encoding, compression, checksums, formatting | [`sdk/src/engine.ts`](../sdk/src/engine.ts) → re-exports `src/lib/fluxdrop/{protocol,encoding,compress,checksum,format}.ts` | **Production code** — the exact files the web client runs on |
| **Client façade** — `createFluxdropClient()` typed event-emitter API | [`sdk/src/index.ts`](../sdk/src/index.ts) | **Scaffold** — state machine + manifest building are real; transport steps throw `ScaffoldTransportError` |
| **React widget** — `<FluxDropWidget>` shell | [`sdk/src/widget.tsx`](../sdk/src/widget.tsx) | **Scaffold** — themed minimal UI with `FULL-UI SLOT` markers |

Design rule: the SDK adds *nothing* to the engine — it re-exports the framework-agnostic modules from `src/lib/fluxdrop/` via read-only relative imports so embedders never depend on repo-internal paths. Those modules are browser/worker/bun/node-safe by design (no React, no `next/*`, no `window` at module scope).

## Quickstart (monorepo)

```bash
# sdk/ has its own package.json (peer deps + relative engine imports — no install needed)
# consume it from another workspace package via an alias:
#   "@fluxdrop/sdk": "file:./sdk"
```

```ts
import { createFluxdropClient, ScaffoldTransportError, formatBytes } from '@fluxdrop/sdk'

const fluxdrop = createFluxdropClient({
  endpoint: 'https://fluxdrop.example.com',
  signalUrl: 'wss://signal.example.com:3003',
  alias: 'docs-site',
  role: 'sender',
})

fluxdrop.on('state', (s) => console.log('→', s))

try {
  const { manifest } = await fluxdrop.sendFiles([file])
  console.log('would send', formatBytes(manifest.totalSize), 'in', manifest.totalChunks, 'chunks')
} catch (err) {
  if (err instanceof ScaffoldTransportError) {
    console.log('transport not wired yet; manifest:', err.manifest)
  }
}

fluxdrop.destroy()
```

## Client façade API

`createFluxdropClient(options)` → `FluxdropClient`:

```ts
interface FluxdropClient {
  on<K extends FluxdropEventName>(event: K, handler: FluxdropEvents[K]): () => void
  getState(): TransferState
  connect(): Promise<void>                                    // 🔌 scaffold stub
  createRoom(): Promise<FluxdropRoomInfo>                     // 🔌 scaffold stub
  joinRoom(roomId: string, pin: string): Promise<{ roomId: string; peers: Device[] }> // 🔌 scaffold stub
  sendFiles(files: File[]): Promise<FluxdropSendResult>       // ✅ local pipeline, 🔌 send step
  destroy(): void
}
```

Options: `endpoint?` (base URL of a FluxDrop instance, shown by the widget), `signalUrl?`, `alias?`, `role?: 'sender' | 'receiver'`, `withPin?` (default `true`).

### Events (`FluxdropEvents`)

| Event | Payload | Emitted when |
|---|---|---|
| `state` | `(state, previous)` | any `TransferState` transition |
| `roomCreated` | `{ roomId, joinCode, pin, qrData }` | sender's room is live (post-wiring) |
| `roomJoined` | `{ roomId, peers }` | receiver joined (post-wiring) |
| `peer` | `(device, 'joined' \| 'left')` | roster change (post-wiring) |
| `progress` | `{ transferId, bytesTransferred, totalBytes, chunksAcked, totalChunks }` | chunk ACKs (post-wiring) |
| `complete` | `{ transferId, verified, manifest }` | checksum-verified finish (post-wiring) |
| `error` | `(err: Error)` | anything fatal; client stays usable |

### The scaffold contract: `ScaffoldTransportError`

WebRTC is not available in plain Node, and the SDK intentionally does **not** bundle `socket.io-client`. Everywhere the façade reaches a point that needs the transport it throws:

```ts
class ScaffoldTransportError extends Error {
  readonly code = 'SCAFFOLD_TRANSPORT'
  readonly manifest?: TransferManifest // set when sendFiles() got as far as building it
}
```

- `connect()` — needs a signaling socket (`src/lib/fluxdrop/signaling.ts` wraps `socket.io-client`; the web client connects through its origin with `XTransformPort=3003`).
- `createRoom()` / `joinRoom()` — relay through the signaling server; require `connect()`.
- `sendFiles()` — **the local half is production code**: `validateFiles()` rejects oversized/blocked files (`CONSTANTS.MAX_FILE_SIZE`, `BLOCKED_EXTENSIONS`, …), then every file is hashed with `hashFile()` (SHA-256 via `crypto.subtle`, with the `hash-wasm` fallback for insecure origins), then the manifest is assembled (64 KiB chunk math, `RESUME_RECORD_TTL_MS` expiry). The *send step* — `encodeControlMessage(MANIFEST, …)` + the chunk loop over the DataChannel — throws with the manifest attached.

Every scaffold throw also emits the `error` event and lands the state machine in `ERROR` — hosts can render that instead of try/catching.

Each throw site carries a `🔌 INTEGRATION POINT` comment naming the production file that implements it. `cli/src/transfer.ts` is a dependency-free reference for the full send/receive sequence.

## Widget

```tsx
import { FluxDropWidget } from '@fluxdrop/sdk/widget'

<FluxDropWidget
  endpoint="https://fluxdrop.example.com"   // "open in FluxDrop ↗" affordance today;
                                            // join-URL + QR base once rooms are wired
  theme={{ accent: '#6d28d9', radius: 12, dark: true }}
  compact                                   // sidebar-friendly
  onSend={async (files) => { /* your queue, or fluxdrop.sendFiles(files) */ }}
/>
```

Plain React (`react >= 18`, optional peer dep) with inline styles — no `next/*`, shadcn or Tailwind imports, so it embeds anywhere. The `FULL-UI SLOT` comment in `sdk/src/widget.tsx` marks where the production components (`src/components/fluxdrop/file-picker.tsx`, `transfer-progress.tsx`, `consent-dialog.tsx`, `qr-display.tsx`, …) mount once the façade drives full transfers.

## Engine reference

Re-exported verbatim — see the source files for full JSDoc and [`docs/protocol-spec.md`](./protocol-spec.md) for the wire contract:

| Module | Highlights |
|---|---|
| `protocol` | `MessageType` opcodes (0x01–0x13), 9-byte header layout, `CONSTANTS` (64 KiB chunks, flow windows, limits), `TransferManifest`, `TransferState`, `SIGNALING_EVENTS` |
| `encoding` | `encodeChunkData` / `encodeChunkAck` / `encodeControlMessage`, `decodeMessage` (zero-copy views), buffer pool |
| `compress` | per-chunk gzip via `CompressionStream`, compressibility heuristics, `shouldCompressTransfer` |
| `checksum` | `hashFile` (whole ≤256 MB / Merkle-like above), `hashBytes`, `hashBlobRange` (incremental, matches `sha256sum`), `verifyChecksum` |
| `format` | `formatBytes/Speed/Duration/Eta/Percent`, `validateFiles`, `computeTotalChunks`, `generateDeviceAlias` |

## Roadmap (scaffold → full client)

1. ✅ **Engine extraction** — `src/lib/fluxdrop/*` engine modules are framework-agnostic and re-exported.
2. ✅ **Façade hardening** *(this scaffold)* — typed events, state machine, manifest building with production hashing, explicit `ScaffoldTransportError` seams.
3. 🔌 **Lift the connection wiring** — `src/lib/fluxdrop/{signaling,webrtc,e2e}.ts` behind the façade. They are also framework-agnostic but need a DI point for the socket factory and toast side effects that currently live in the React hook (`src/hooks/fluxdrop/use-fluxdrop.ts`).
4. 🖼 **Widget full UI** — swap the shell for the production component set behind the same props; `endpoint` becomes the join-URL/QR base.

Until step 3, hosts render the widget and use the engine modules directly for custom pipelines; live transfers remain driven by the main FluxDrop web app.

## Conformance

```bash
bun scripts/protocol-conformance.ts   # 72 checks incl. golden vectors
```

Any change to `src/lib/fluxdrop/{protocol,encoding}.ts` changes this SDK's wire behavior — update the conformance suite and `docs/protocol-spec.md` §10 in lockstep.

## Related

- [Protocol spec](./protocol-spec.md) — the wire contract the engine implements
- [CLI](../cli/README.md) — headless sender/receiver using the same modules
- [Mobile shell (Capacitor)](./mobile-shell.md) · [Desktop shell (Tauri)](./desktop-shell.md) — the same "reuse the web app" strategy on native runtimes
