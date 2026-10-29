# 🧬 FluxDrop — Feature Brainstorm & Enhancement Roadmap

> A curated backlog of new features and enhancements for FluxDrop, the peer-to-peer file transfer app.
> Grounded in the current codebase (see `worklog.md` for the build history and `docs/architecture/` for ADRs).

**How to read this document**

| Tag | Meaning |
|-----|---------|
| P0 | High impact, strongly recommended next |
| P1 | High value, planned |
| P2 | Nice to have |
| P3 | exploratory / moonshot |
| S / M / L | Effort: small (<1d) / medium (1–3d) / large (>3d) |
| 🔧 | Backend or infra change required (signaling service / gateway) |

---

## 0. Current Foundation (what we're building on)

- P2P WebRTC DataChannel transfers, DTLS-encrypted, 64 KB–256 KB negotiated chunks
- Socket.IO signaling mini-service (port 3003): rooms, 6-digit PIN, pairing, ICE relay, TTL expiry, max **2 devices/room**
- SHA-256 verification (Merkle-like for >256 MB), resume via IndexedDB chunk cache, backpressure flow control
- QR pairing, deep links (`#join=ROOM&pin=PIN`), PWA + Web Share Target
- Transfer history, stats dashboard, diagnostics (RTT, ICE pairs, LAN badge, chunk map)
- Text snippets, consent dialog, trusted peers + auto-accept, verification code display

---

## 1. Transfer Core & Performance

### 1.1 Adaptive chunk sizing — `✅ SHIPPED v1.1 (as adaptive flow window)`
Chunk SIZE stays fixed at 64 KB per manifest (resume byte-offsets depend on it — see ADR-003); the ADAPTIVE part is the in-flight flow window: AIMD control (grow ×1.25 per 64 clean sends, halve on send-queue pressure, 256 KB floor) seeded by transport class (LAN 16 MB / relayed 4 MB / unknown 8 MB) from the selected ICE pair.

### 1.2 On-the-fly compression — `✅ SHIPPED v1.1`
Per-chunk gzip via native `CompressionStream` (opcode `CHUNK_DATA_GZ`), manifest carries `compression: 'gzip'`. Compressible MIME/extension heuristic skips media/archives; receiver decompresses before storing so checksums/bitmaps/resume all operate on original bytes. Settings toggle (default ON). Verified: 36 KB text+JSON transfer + 55 MB recovery, checksums byte-exact.

### 1.3 Bandwidth throttle / QoS slider — `✅ SHIPPED v4`
Sender-side pacing cap via a token-bucket rate limiter on the DataChannel send path (Settings → Tuning: 0–200 Mbit/s slider, 0 = unlimited). The cap clamps the AIMD flow window to ~0.5 s of data, gates `canSend()`/`waitForDrain()`, and applies live to every open transport — a big send no longer saturates the LAN/hotspot.

### 1.4 Parallel file pipelining — `✅ SHIPPED v1.1`
Interleave chunks of multiple queued files instead of strictly sequential per-file transfer, so one slow/huge file doesn't starve the rest of the queue. Shipped as a deterministic file-round-robin send order (`buildSendOrder`) — zero wire-protocol change, receiver already stores by chunk index.

### 1.5 Auto-retry with exponential backoff — `✅ SHIPPED v1.1`
Mid-transfer drops now auto-recover: DC close → bounded resume attempts (3, 2s/4s/8s backoff) → re-offer → persisted-bitmap handshake that skips already-stored chunks → sender self-queries on reconnect → re-paired peers revive FAILED sessions. Signaling blips survive via automatic `rejoin-room` rebinding. Retry button offered after exhaustion.

### 1.6 Streaming receive for everything — `✅ SHIPPED v1.3`
Receives >64 MB now spill chunks into a single OPFS temp file as they arrive (positional writes, RAM-trimmed as written) and the completion path is fully streamed: completeness poll → per-file byte-range hashing (incremental hash-wasm SHA-256 in 8 MB slices — sha256sum-exact for ALL sizes, superseding the Merkle-like fallback on this path) → `File.slice()`-backed saves (disk-to-disk, no RAM copy) → OPFS temp discarded. ≤64 MB keeps the proven in-memory path byte-identical.

### 1.7 Integrity upgrade: real streaming Merkle tree — `✅ SHIPPED v4`
Per-chunk SHA-256 leaves (64 KB layout) → duplicate-last binary tree → root sealed into `manifest.merkle` BEFORE room creation (so the E2E manifest seal covers it). The receiver rebuilds the identical tree from the bytes it actually stored at completion — an independent integrity check sharing zero code with the per-file checksum path. Mismatch = loud warning + console root dump; leaves stay sender-side for future spot-proofs. Skipped above 2 GB to bound pre-send latency.

### 1.8 Post-transfer actions — `✅ SHIPPED v4`
Completion automations: auto-open first file (Settings → Sync & automation), Download-as-.zip (4.2) for multi-file transfers, and Send-onward chaining (6.2). Verified received blobs are cached per transfer so every action operates on checksum-verified bytes.

---

## 2. Security & Privacy

### 2.1 True end-to-end payload encryption (PAKE) — `✅ SHIPPED v1.2`
SPAKE2 over P-256 (RFC 9383 M/N constants, audited @noble/curves arithmetic) derives a 256-bit session key from the room PIN; every payload frame (manifest, chunks, previews) is AES-256-GCM sealed before the DataChannel (opcodes `MANIFEST_ENC`/`CHUNK_ENC`, compress-then-encrypt). Key confirmation (role-tagged HMAC over the full transcript) aborts the transfer on mismatch — no silent downgrade, plaintext frames are dropped while E2E is active, and a lost handshake downgrades VISIBLY (toast). The signaling server relays only opaque blobs. Settings toggle (default ON).

### 2.2 SAS fingerprint in QR + verification code — `✅ SHIPPED v1.2 (SAS bound to PAKE transcript)`
The verification-code card now displays the real 6-digit SAS derived from the SPAKE2 transcript (HKDF over room + both device ids + salt + both ephemeral points). Two-leg MITM produces two different transcripts → different codes → user-visible. (The QR-embed half is N/A: the QR precedes the handshake — the transcript-bound SAS is the meaningful authentication.)

### 2.3 Encrypt data at rest (resume cache + history) — `✅ SHIPPED v1.2`
Chunk cache and transfer history in IndexedDB are sealed with a non-extractable AES-256-GCM key (generated once, persisted as a structured-cloneable CryptoKey in its own DB — export is structurally impossible). Versioned `{ __fluxdropEnc, data }` envelope with purpose-bound AAD; legacy plaintext values migrate transparently on read/re-write. **Paranoid mode** (Settings → Privacy): wipes the chunk cache on tab close (pagehide) + purges crash leftovers on boot.

### 2.4 Ephemeral alias rotation — `✅ SHIPPED v1.2`
Unless the user explicitly set a custom alias (Settings → Device), the device alias rotates per browser session (sessionStorage) — a fresh pet name every tab, uncorrelatable across rooms/weeks. deviceId stays stable (trusted peers + resume records key off it).

### 2.5 Signaling hardening kit — `✅ SHIPPED v4 🔧`
Per-IP sliding-window room-creation rate limit (default 10/min, env `ROOM_CREATE_RATE_PER_MIN`, shared between socket create-room and POST /link → 429 + `RATE_LIMITED`), structured JSON-lines logging (`LOG_LEVEL`, zero PIN/SDP/alias content), enhanced `/healthz` (rooms, sockets, region, version, memory). Redis-adapter horizontal-scale instructions ship as a documented comment block — single-node default.

### 2.6 Transparency panel — `✅ SHIPPED v4`
"What left your device this session" — inside the diagnostics panel: every signaling event (direction + bytes), DataChannel byte totals, ICE candidate type counts, and IPv4/IPv6 availability badges. Voluntary, local-only, clearable. The signaling client records every emit/receive; webrtc.ts records wire bytes and candidates.

---

## 3. Pairing, Discovery & Networking

### 3.1 Bundled TURN relay — `✅ SHIPPED v1.1 (credential plumbing + kit)`
Signaling mints short-lived coturn `static-auth-secret` credentials at `GET /turn-credentials` (HMAC-SHA1, 10-min TTL), plus `GET /healthz`. Client auto-merges them into ICE (Settings toggle, default ON; custom ICE wins). coturn ships in the compose kit (§8.1). Socket.IO scoped to `/socket.io` so HTTP endpoints coexist with the gateway.

### 3.2 LAN zero-config discovery — `✅ SHIPPED v4 🔧`
"Nearby devices" landing panel: the signaling service groups connected devices by subnet (IPv4 /24, IPv6 /64) with a 30 s presence TTL; the client announces + polls every 10 s (visibility toggle in Settings). Browsers cannot emit raw UDP/mDNS beacons, so discovery rides the existing signaling channel — but pairing itself needs no internet once the local gateway is reachable, and the response NEVER contains IPs (pet names + device ids only).

### 3.3 NFC / proximity pairing — `✅ SHIPPED v4`
Web NFC (Chrome-on-Android, feature-detected): "Write to NFC tag" on the room screen writes the join URL as a standard URI record — tap the receiving phone on the tag to open the deep link. The ultrasonic WebAudio fallback was deliberately cut (party trick, not a pairing path).

### 3.4 Expiring share links with server-side rooms — `✅ SHIPPED v4 🔧`
`POST /link` pre-creates the room server-side ({ttlMinutes: 5|60|1440, oneJoin}); the link generator claims it through create-room (`claim: {roomCode, pin}`) and the ready-made `#join=…&pin=…` URL is copied to the clipboard. one-join rooms auto-close at first pairing (further joins get room-closed). Payloads stay PAKE-encrypted — the link only opens the door.

### 3.5 IPv6 + dual-stack ICE guidance — `✅ SHIPPED v4`
Candidate telemetry tracks IPv4/IPv6 availability (and masked /48 prefixes for the v6 hints) per session; the transparency panel + diagnostics surface "IPv6 available" badges so users on dual-stack LANs can see when the direct v6 path exists (which often bypasses NAT44 entirely).

---

## 4. Files & Storage

### 4.1 Received-files vault — `✅ SHIPPED v1.3`
OPFS-backed vault (`vault/<transferId>/…` + IndexedDB meta in its own DB): every verified received transfer is kept automatically (Settings toggle, default ON), searchable in the landing "Files vault" view, re-downloadable per file or as a folder, with per-entry SHA-256 ✓ badges and deletion. Budget with LRU eviction (512 MB / 2 GB / 8 GB / unlimited; oldest entries evicted first). Auto-save trust scope skips the pickers entirely (vault-only save).

### 4.2 Zip-on-receive — `✅ SHIPPED v4`
"Download .zip" on the completion card for multi-file transfers — a dependency-free ZIP writer (STORE method, CRC-32, UTF-8 names, folder structure via `/` paths, Blob-slice streaming so vault-scale entries never double RAM). Byte-exact: the zip contains the verified bytes 1:1.

### 4.3 Conflict-aware save options — `✅ SHIPPED v1.2`
When saving a multi-file transfer into an existing folder (File System Access path), FluxDrop detects name collisions up front and opens a per-file resolution dialog — auto-rename (`"name (1).ext"`), overwrite, or skip — with apply-to-all. Without FSA (mobile/older browsers) the download fallback keeps the browser's native uniquification.

### 4.4 Rich file previews on consent — `✅ SHIPPED v1.2`
Before accepting, the receiver fetches head-bytes previews over the DataChannel (`PREVIEW_REQ`/`PREVIEW_DATA`, first 8 files × 24 KB, E2E-encrypted when the PAKE session is active): images render as real thumbnails, text/code shows the first line, everything else gets a typed chip. Consent happens with your eyes, not just filenames.

### 4.5 Send queue editing mid-session — `✅ SHIPPED v4`
While the room is live and the receiver hasn't paired yet, every queued file row gains move-up/move-down/remove controls; an "Apply changes & refresh room" banner re-hashes the new order and re-creates the room (explicit — no silent room swapping). Pre-room editing (add/remove/reorder + paste) was already in the picker.

### 4.6 Clipboard & snippet upgrades — `✅ SHIPPED v4`
- Opt-in **clipboard sync** (Settings → Sync, both peers): document-copy capture forwards ≤4 KB text over the DataChannel (opcode CLIPBOARD, E2E-sealed with the PAKE key); incoming sync surfaces a one-tap Copy toast (browsers require a gesture for direct writes).
- Rich snippets: receiver preview with syntax highlighting (auto language guess) + Markdown rendering + raw toggle; composer cap raised to 1 MB (the pipeline chunks it like any file).
- **Snippet → QR** in the composer for ≤800-char payloads — scannable with zero connection.

---

## 5. UX & Interface

### 5.1 Transfer activity dock — `✅ SHIPPED v1.3`
Persistent bottom-center dock (safe-area aware) visible in every active transfer state from anywhere in the app: state + percent + live speed when collapsed; expandable to progress bar, elapsed, chunk counts, per-receiver mini-rows for group sends, with pause/resume, cancel and jump-to-transfer. Collapses into the full progress card by design.

### 5.2 Command palette (⌘K) — `✅ SHIPPED v4`
cmdk-based palette on ⌘K/Ctrl+K: navigate (send/receive/home), theme toggle, diagnostics, settings, shortcuts, copy-debug-bundle, re-run the speedrun — the existing keyboard shortcuts finally have a discoverable home.

### 5.3 Drag-out of received files — `✅ SHIPPED v4`
Completion-card file chips are draggable (`DataTransfer` + File entries) straight into Finder/Explorer on Chrome desktop; the download button remains the graceful fallback everywhere else.

### 5.4 Sound & haptics presets — `✅ SHIPPED v4`
Chime packs (calm / lively / silent), quiet hours (window mute), and `navigator.vibrate` haptics on completion/errors — all in Settings → Tuning. The WebAudio synth stays asset-free.

### 5.5 Accent theming — `✅ SHIPPED v4`
Five accent presets (Emerald · Fern · Amber · Rose · Violet) + high-contrast mode, applied by re-huing the `--color-flux-*` oklch scale on `<html>` — the whole app re-skins without touching components. Persisted per device in `fluxdrop:prefs-v4`.

### 5.6 First-run speedrun — `✅ SHIPPED v4`
First visit opens a 10-second simulated transfer (hash → pair → stream → verified) inside a dialog — the full shape of a real send with zero second device. Re-runnable from the command palette and Settings → Tuning.

---

## 6. Collaboration & Multi-device

### 6.1 Group rooms (1 → N fan-out) — `✅ SHIPPED v1.3`
`MAX_DEVICES_PER_ROOM` lifted (default 8, env-tunable 2..32): the sender holds ONE RTCPeerConnection per receiver (dedicated DataChannel, consent, PAKE session key, adaptive flow window and resume bitmap per peer), driven by a cooperative wave scheduler with per-peer positions in the deterministic send order (late acceptors catch up from 0; post-completion pairings trigger a fresh redelivery leg). Signaling relays are strictly UNICAST per addressed device. Aggregate progress counts a chunk only when every required receiver holds it; a departing receiver stops being required and the send continues. Room roster shows live per-receiver progress bars.

### 6.2 Relay-to-peer chaining — `✅ SHIPPED v4`
"Send onward" on the completion card: verified received blobs are re-queued as a fresh send to a third device — an explicit, consent-based mini-mesh (the new leg gets its own room, PIN, consent and PAKE session).

### 6.3 Room chat & read receipts — `✅ SHIPPED v1.3 (chat; receipts via existing chunk-ACK path)`
In-room text channel over the DataChannel (opcode CHAT 0x12, 2000-char cap): broadcast from the sender to every receiver, replies addressed back per peer, sealed with the per-peer PAKE session key while E2E is active (plaintext frames dropped when active — same anti-downgrade guard as payloads). Floating collapsible panel with unread badge; signaling relays nothing.

### 6.4 Device trust levels — `✅ SHIPPED v1.3`
Trusted peers now carry scopes — `auto-accept files` / `auto-accept snippets` (all-files-match snippet-*.txt ≤100 KB) / `auto-save to vault` (skips pickers, saves into the Files vault) — plus a trust-on-first-use SAS fingerprint recorded at trust time and surfaced in Settings → Privacy so the PIN-verified code is auditable later. Legacy entries migrate to all-true scopes.

---

## 7. Platform, PWA & Distribution

### 7.1 Mobile app shells — `✅ SHIPPED v4 (scaffold + guide)`
`capacitor.config.ts` + `docs/mobile-shell.md`: the hosted-instance `server.url` strategy (zero web-build changes), share-sheet mapping (Web Share Target already in the PWA), keep-awake/background plugin table, and honest iOS background-WebRTC limits. Building the APK/IPA requires the Capacitor toolchain (not runnable in this sandbox).

### 7.2 Desktop wrapper — `✅ SHIPPED v4 (scaffold + guide)`
`src-tauri/tauri.conf.json` (Tauri 2 schema, dragDrop disabled so HTML5 drop zones keep working) + `docs/desktop-shell.md` (tray quick-drop concept, native save dialogs via tauri-plugin-dialog, hosted-URL strategy). Rust codegen requires a Rust toolchain — config + docs are the deliverable.

### 7.3 Background transfer resilience — `✅ SHIPPED v4`
Page Lifecycle API + visibilitychange: mid-transfer tab-hide/freeze auto-pauses (mobile OSes throttle background WebRTC — pausing keeps the resume state clean), return auto-resumes and fires a desktop notification. Resume state itself was already durable (IndexedDB records).

### 7.4 Offline-first landing + LAN mode — `✅ SHIPPED v4`
The service worker (v4) now precaches every hashed `_next` chunk referenced by the landing at activation — the full landing (not just a cached HTML shell with missing chunks) works offline. LAN mode: host-candidate pairs never needed STUN/TURN, so transfers between same-subnet devices work with the WAN down (3.2's discovery rides the local gateway).

---

## 8. Infrastructure & Self-hosting

### 8.1 One-command self-host kit — `✅ SHIPPED v1.1`
`docker-compose.yml` with app (multi-stage Dockerfile → Node 22 standalone runtime), signaling service, coturn (static-auth-secret wired to the same `TURN_SECRET`), and Caddy front (`deploy/Caddyfile.docker`). `.env.docker.example` + README quickstart. Run: `cp .env.docker.example .env && docker compose up -d --build`.

### 8.2 Signaling server admin dashboard — `✅ SHIPPED v4 🔧`
Opt-in via `ADMIN_TOKEN` env: `GET /admin?token=` serves a self-contained dark dashboard (live rooms, device counts, sender-present, TTL countdowns, relayed-event counters, per-room + global kill switch), `GET /admin/api` the same as JSON, `POST /admin/action` performs close-room/close-all (members get room-closed). Timing-safe token compare; no PINs, no IPs, ever.

### 8.3 Multi-region signaling + closest-IP hint — `✅ SHIPPED v4 (protocol + probe; region pinning documented)`
`GET /region` self-describes every signaling instance ({region, version, uptime, devices}); the client surfaces the region in diagnostics, and multi-instance deployments can pin rooms per region (documented in the spec) while clients latency-probe the endpoint list.

---

## 9. Developer Experience & Extensibility

### 9.1 Headless CLI sender/receiver — `✅ SHIPPED v4 🔧`
`cli/` — a standalone bun package (`fluxdrop`) speaking the REAL v1 wire protocol (imports the production protocol/framing modules): `fluxdrop send <files…>` prints room + PIN + join URL, `fluxdrop receive --room --pin` writes + verifies. Real WebRTC via `node-datachannel` prebuilds; verified end-to-end (two CLI processes, sha256-verified 1.9 MB transfer, plus a simulated-loss loopback selftest).

### 9.2 Protocol spec + conformance suite — `✅ SHIPPED v4 🔧`
`docs/protocol-spec.md` — the complete v1 wire spec (9-byte header, all 19 opcodes 0x01–0x13, E2EE envelopes + AAD purposes, manifest schema incl. `compression`/`merkle`, signaling events, golden vectors). `scripts/protocol-conformance.ts` validates framing roundtrips + golden vectors against the REAL production modules — **72/72 checks pass**.

### 9.3 Public JS SDK — `✅ SHIPPED v4 (scaffold)`
`sdk/` — `@fluxdrop/sdk`: re-exports the production engine modules (protocol, encoding, compress, checksum) plus a typed `createFluxdropClient()` façade (real validation/hashing/manifest building, throws-with-manifest at the transport seam with explicit INTEGRATION POINT markers) and a plain-React `<FluxDropWidget>` shell. Widget/client are starting points; engine code is production.

### 9.4 Structured diagnostics export — `✅ SHIPPED v4`
One-click "Copy debug bundle" (diagnostics panel + command palette): sanitized JSON — ICE pair, transport class, speed history, chunk/chunkAck counts, transparency report (event counts + recent trail), session facts. File names opt-IN, no IPs beyond the visible pair. Turns "it was slow" into actionable data.

---

## 10. Accessibility & Internationalization

### 10.1 i18n rollout — `✅ SHIPPED v4 (6 locales, prominent surfaces)`
EN + ES / FR / DE / PT-BR / JA: a lightweight context + `useT()` (components keep their tuned English inline as fallback, so a missing key can never blank the UI), persisted locale, language picker in Settings → Tuning. Coverage: hero, common actions, views, transfer states, and every v4 feature surface; deeply technical strings stay EN-first by design. (next-intl remained unused deliberately: the app is single-route, and routing-free usage would add build-time risk for zero user value.)

### 10.2 A11y sweep — `✅ SHIPPED v4`
`prefers-reduced-motion` + a manual reduce-motion pref: the particle field and celebration disable themselves entirely (zero animated nodes, static checkmark); queue editing uses labeled buttons (keyboard-operable, no drag-only controls); the SAS code carries an ARIA label; dialogs remain focus-trapped via shadcn primitives.

### 10.3 Low-vision transfer mode — `✅ SHIPPED v4`
Settings → Tuning → "Low-vision transfer mode": bumps base font size + the progress/label scale app-wide, thickens progress bars, and the SAS verification code gets a digit-by-digit ARIA live readout.

---

## 🗺️ Suggested Release Trains

| Train | Theme | Items |
|-------|-------|-------|
| **v1.1 — "Just works"** | Reliability & reach | ✅ 1.5 auto-retry · ✅ 1.1 adaptive flow window · ✅ 1.2 compression · ✅ 3.1 TURN · ✅ 8.1 self-host kit · ✅ 1.4 pipelining — **SHIPPED** |
| **v1.2 — "Locked down"** | Security & trust | ✅ 2.1 PAKE E2E · ✅ 2.2 SAS-in-transcript · ✅ 2.3 at-rest encryption · ✅ 2.4 alias rotation · ✅ 4.4 rich previews · ✅ 4.3 conflict-aware save — **SHIPPED** |
| **v1.3 — "Together"** | Multi-device & collaboration | ✅ 6.1 group rooms · ✅ 5.1 activity dock · ✅ 6.3 room chat · ✅ 6.4 trust levels · ✅ 4.1 files vault · ✅ 1.6 streaming receive — **SHIPPED** |
| **v4 — "Everywhere"** | Platform, world & DX | ✅ 3.2 LAN discovery · ✅ 10.1 i18n · ✅ 7.3 background resilience · ✅ 9.4 debug bundle · ✅ 5.2 command palette — **SHIPPED** |
| **v4 fill-ins — "The rest of the board"** | Every remaining item | ✅ 1.3 QoS · ✅ 1.7 Merkle · ✅ 1.8 post-transfer · ✅ 2.5 hardening · ✅ 2.6 transparency · ✅ 3.3 NFC · ✅ 3.4 share links · ✅ 3.5 IPv6 · ✅ 4.2 zip · ✅ 4.5 queue editing · ✅ 4.6 clipboard+snippets · ✅ 5.3 drag-out · ✅ 5.4 sound packs · ✅ 5.5 accents · ✅ 5.6 speedrun · ✅ 6.2 onward chaining · ✅ 7.1 mobile scaffold · ✅ 7.2 desktop scaffold · ✅ 7.4 offline landing · ✅ 8.2 admin · ✅ 8.3 region · ✅ 9.1 CLI · ✅ 9.2 spec+conformance · ✅ 9.3 SDK · ✅ 10.2 a11y · ✅ 10.3 low-vision — **SHIPPED (all backlog items)** |

---

## 🚫 Deliberately out of scope

- **Cloud storage / accounts** — contradicts the zero-storage promise
- **P2P video/voice calls** — different product; DataChannel-only stays lean
- **General messaging app** — room chat (6.3) is scoped to transfer coordination
- **Torrent-style swarming** — complexity ≠ value for 1:1 and small-group sharing

---

*Generated 2026-10-26 · grounded against commit `ff9d97a` · update alongside `docs/architecture/` ADRs as items ship.*
*v1.2 train shipped 2026-10-26 — see `worklog.md` entries `v1.2-a` / `v1.2-c` / `v1.2-d`.*
*v1.3 train shipped 2026-10-26 — see `worklog.md` entries `v1.3-a` / `v1.3-b` / `v1.3-c` / `v1.3-verify`.*
*v4 trains shipped 2026-10-29 — every remaining backlog item — see `worklog.md` entries `v2.0-a` / `v2.0-b1` / `v2.0-b2` / `v1.4-a`…`v1.4-h`.*
