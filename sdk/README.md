# @fluxdrop/sdk

Embed FluxDrop send/receive into any web app — docs sites, support chats, LMS portals.

> **Scaffold status (honest):** the **engine modules are production code** — they are the exact files the FluxDrop web app runs on (`src/lib/fluxdrop/*`, re-exported unmodified via [`src/engine.ts`](./src/engine.ts); wire conformance locked by [`scripts/protocol-conformance.ts`](../scripts/protocol-conformance.ts)). The **client façade and widget are a starting point**: typed API surface + a themed React shell, with clearly marked integration points where the full signaling/WebRTC/PAKE wiring plugs in. See [Roadmap](#roadmap) and [`docs/sdk.md`](../docs/sdk.md).

## Install (monorepo)

```bash
# the SDK lives in-repo; consume it via a workspace alias for now:
#   "@fluxdrop/sdk": "file:./sdk"
```

No dependencies are bundled: the engine layer has zero imports outside `src/lib/fluxdrop`, and `react` is an optional peer dependency (only needed for the widget).

## Usage

### Engine modules (production, framework-agnostic)

```ts
import {
  // wire protocol
  MessageType, CONSTANTS, SIGNALING_EVENTS, HEADER_SIZE,
  encodeChunkData, encodeChunkAck, encodeControlMessage, decodeMessage,
  // hashing + compression + formatting
  hashFile, hashBytes, verifyChecksum,
  gzipCompress, gzipDecompress, isCompressibleType, shouldCompressTransfer,
  formatBytes, formatSpeed, computeTotalChunks,
  // types
  type TransferManifest, type FileManifestEntry, type DecodedMessage,
} from '@fluxdrop/sdk'
```

Every function above is the same code the browser client uses — see [`docs/protocol-spec.md`](../docs/protocol-spec.md) for the wire contract they implement, and the dependency-free CLI reference implementation in [`cli/src/transfer.ts`](../cli/src/transfer.ts) for the full send/receive sequence over any `Wire` object.

### Client façade (scaffold)

```ts
import { createFluxdropClient, ScaffoldTransportError } from '@fluxdrop/sdk'

const fluxdrop = createFluxdropClient({
  endpoint: 'https://fluxdrop.example.com', // shown by the widget as "open in FluxDrop"
  signalUrl: 'wss://signal.example.com:3003',
  alias: 'docs-site',
  role: 'sender',
})

const off = fluxdrop.on('state', (s) => console.log('→', s))
fluxdrop.on('progress', (p) =>
  console.log(`${p.bytesTransferred}/${p.totalBytes} (${p.chunksAcked}/${p.totalChunks} chunks)`))
fluxdrop.on('complete', ({ verified }) => console.log(verified ? '✅' : '❌'))

try {
  // ✅ real local work: validates files (engine validateFiles), hashes them
  //    (engine hashFile — SHA-256 with the insecure-origin fallback) and
  //    builds the production manifest (64 KiB chunk math).
  const { manifest } = await fluxdrop.sendFiles([file])
} catch (err) {
  // 🔌 everything that needs the TRANSPORT (signaling relay / WebRTC
  //    DataChannel) throws a ScaffoldTransportError carrying the built
  //    manifest — the exact seam where the wiring plugs in.
  if (err instanceof ScaffoldTransportError) console.log(err.manifest)
}

off() // unsubscribe
fluxdrop.destroy()
```

API surface (all JSDoc'd in [`src/index.ts`](./src/index.ts)):

| Method | Status |
|---|---|
| `on(event, handler)` / `getState()` / `destroy()` | **working** — typed emitter (`state`, `roomCreated`, `roomJoined`, `peer`, `progress`, `complete`, `error`) |
| `sendFiles(files)` | **half-working** — validation + SHA-256 hashing + manifest building run production engine code; the DataChannel send step throws `ScaffoldTransportError` (`.manifest` attached) |
| `connect()` | 🔌 throws `ScaffoldTransportError` — plug in `socket.io-client` + [`src/lib/fluxdrop/signaling.ts`](../src/lib/fluxdrop/signaling.ts) here |
| `createRoom()` / `joinRoom(roomId, pin)` | 🔌 throw `ScaffoldTransportError` — need `connect()`; payloads resolve via `SIGNALING_EVENTS.ROOM_CREATED` / `ROOM_JOINED` |

State transitions use the production `TransferState` machine (`IDLE → VALIDATING → MANIFEST_EXCHANGE → TRANSFERRING → VERIFYING → COMPLETE`; full set in `src/lib/fluxdrop/protocol.ts`).

### React widget (skeleton)

```tsx
import { FluxDropWidget } from '@fluxdrop/sdk/widget'

<FluxDropWidget
  endpoint="https://fluxdrop.example.com"   // "open in FluxDrop ↗" affordance today;
                                            // join-URL + QR base once rooms are wired
  theme={{ accent: '#6d28d9', radius: 12, dark: true }}
  compact                                   // sidebar-friendly
  onSend={async (files) => {                // host hook — your upload queue or a real
    try {                                   // FluxDrop room transfer (see Roadmap)
      await fluxdrop.sendFiles(files)
    } catch (err) {
      if (err instanceof ScaffoldTransportError) console.log(err.manifest)
    }
  }}
/>
```

The widget is plain React (`react >= 18` peer dep, optional): inline styles only, no next/shadcn/tailwind imports, themable via the `theme` prop. The `FULL-UI SLOT` comment in [`src/widget.tsx`](./src/widget.tsx) marks where the production FluxDrop components (`src/components/fluxdrop/file-picker.tsx`, `transfer-progress.tsx`, `consent-dialog.tsx`, `qr-display.tsx`, …) mount once the façade drives full transfers.

## Roadmap (scaffold → full client)

1. **Engine extraction** ✅ — done: `src/lib/fluxdrop/{protocol,encoding,compress,checksum,format}.ts` are already framework-agnostic and re-exported here.
2. **Façade hardening** (this scaffold) — typed events, state machine, manifest building with production hashing, explicit `ScaffoldTransportError` seams.
3. **🔌 Lift the connection wiring** — `src/lib/fluxdrop/{signaling,webrtc,e2e}.ts` behind the façade (they're also framework-agnostic; they need a DI point for the socket factory + toast side effects first, which currently live in the React hook).
4. **Widget full UI** — swap the shell for the production component set behind the same props; `endpoint` becomes the join-URL/QR base.

Until step 3, hosts render the widget and use the engine modules directly for any custom pipeline; live transfers remain driven by the main FluxDrop web app.

## Conformance

```bash
bun scripts/protocol-conformance.ts   # 72 checks incl. golden vectors (exit 0)
```

Any change to `src/lib/fluxdrop/{protocol,encoding}.ts` is a change to this SDK's wire behavior — the conformance suite and `docs/protocol-spec.md` §10 must be updated in lockstep.
