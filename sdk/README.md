# @fluxdrop/sdk

The public FluxDrop SDK — embed **verified, peer-to-peer file sends** into any
web app. What shipped as a v0.1 scaffold is now the real thing (v0.2):

- **Typed client** (`createFluxdropClient`) with the full transport:
  socket.io signaling, WebRTC DataChannel, manifest-first framing, 64 KiB
  chunks with ACK pacing + lost-ACK resweep, SHA-256 verification handshake.
- **`<fluxdrop-widget>`** — a framework-free custom element (shadow DOM,
  themable, RTL-aware). One import, one tag.
- **React wrapper** (`@fluxdrop/sdk/react`).
- **Engine re-exports** — the app's production wire code (protocol,
  encoding, checksum, compress, format). A widget built on this SDK speaks
  byte-for-byte the same protocol as the FluxDrop web client.

```bash
npm install @fluxdrop/sdk
```

```html
<script type="module">
  import '@fluxdrop/sdk/widget'
</script>

<fluxdrop-widget signal-url="https://your-fluxdrop-instance"></fluxdrop-widget>
```

```ts
import { createFluxdropClient } from '@fluxdrop/sdk'

const fluxdrop = createFluxdropClient({ alias: 'docs-site', signalUrl: 'https://…' })
const room = await fluxdrop.createRoom()      // → roomId + pin + joinUrl
const { verified } = await fluxdrop.sendFiles([file])  // → true when every SHA-256 matched
```

## Build & publish

```bash
bun install
bun run build        # tsup → dist/ (ESM + .d.ts + sourcemaps), bundles the engine
bun run pack:check   # build + npm pack --dry-run (verified: 22 files, ~246 kB)
npm publish          # from this folder — ship it
```

Wire conformance of the bundled engine is locked by
`../scripts/protocol-conformance.ts` (72 checks — docs/protocol-spec.md §10).
The static docs site lives in `../docs-site/`.

## Compatibility notes

- SDK senders are plaintext-over-DataChannel (same posture as the CLI): the
  receiving FluxDrop app shows its visible E2EE downgrade notice. E2EE (PAKE
  over the room PIN) is an interactive web↔web feature.
- Receivers: any FluxDrop web app (v2+) — the widget's room is a normal room.
- Signaling: the Bun server (`../mini-services/signaling`) or the Cloudflare
  Worker adapter (`../serverless/signaling-worker`).
