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

### 1.3 Bandwidth throttle / QoS slider — `P2 · S`
Sender-side pacing cap (e.g. 1–100 MB/s or "polite mode") so a big send doesn't saturate the LAN / hotspot. Builds on the existing backpressure loop — just clamp the send window.

### 1.4 Parallel file pipelining — `✅ SHIPPED v1.1`
Interleave chunks of multiple queued files instead of strictly sequential per-file transfer, so one slow/huge file doesn't starve the rest of the queue. Shipped as a deterministic file-round-robin send order (`buildSendOrder`) — zero wire-protocol change, receiver already stores by chunk index.

### 1.5 Auto-retry with exponential backoff — `✅ SHIPPED v1.1`
Mid-transfer drops now auto-recover: DC close → bounded resume attempts (3, 2s/4s/8s backoff) → re-offer → persisted-bitmap handshake that skips already-stored chunks → sender self-queries on reconnect → re-paired peers revive FAILED sessions. Signaling blips survive via automatic `rejoin-room` rebinding. Retry button offered after exhaustion.

### 1.6 Streaming receive for everything — `✅ SHIPPED v1.3`
Receives >64 MB now spill chunks into a single OPFS temp file as they arrive (positional writes, RAM-trimmed as written) and the completion path is fully streamed: completeness poll → per-file byte-range hashing (incremental hash-wasm SHA-256 in 8 MB slices — sha256sum-exact for ALL sizes, superseding the Merkle-like fallback on this path) → `File.slice()`-backed saves (disk-to-disk, no RAM copy) → OPFS temp discarded. ≤64 MB keeps the proven in-memory path byte-identical.

### 1.7 Integrity upgrade: real streaming Merkle tree — `P2 · L`
Replace the Merkle-like construction for >256 MB files with a proper per-chunk SHA-256 Merkle tree (root signed into the manifest). Enables partial-file verification, honest `sha256sum`-compatible leaf checks, and delta resume verification. Also fixes the documented "sha256sum won't match for large files" limitation.

### 1.8 Post-transfer actions — `P2 · S`
Receiver "after complete" automations: auto-open folder, auto-open first file, unzip `.zip` via File System Access + native decompression, or chain-send to another device.

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

### 2.5 Signaling hardening kit — `P1 · M 🔧`
For self-hosters: optional Redis-backed socket.io adapter (horizontal scale), per-IP room-creation rate limits (PIN attempts are limited, creation isn't), optional OIDC/honeypot-free room tokens, and a `/healthz` + structured logging.

### 2.6 Transparency panel — `P2 · S`
A "What left your device this session" view: exact signaling events emitted, bytes by destination, ICE candidate IPs. Reinforces the zero-storage promise with receipts.

---

## 3. Pairing, Discovery & Networking

### 3.1 Bundled TURN relay — `✅ SHIPPED v1.1 (credential plumbing + kit)`
Signaling mints short-lived coturn `static-auth-secret` credentials at `GET /turn-credentials` (HMAC-SHA1, 10-min TTL), plus `GET /healthz`. Client auto-merges them into ICE (Settings toggle, default ON; custom ICE wins). coturn ships in the compose kit (§8.1). Socket.IO scoped to `/socket.io` so HTTP endpoints coexist with the gateway.

### 3.2 LAN zero-config discovery — `P1 · L 🔧`
"Nearby devices" panel: a tiny UDP beacon service (or mDNS via the gateway) that lists FluxDrop devices on the same network → one-tap pairing, **no signaling server, no internet**. Works offline with the PWA; perfect complement to the Direct-LAN badge.

### 3.3 NFC / proximity pairing — `P3 · M`
Web NFC tap to hand the room credential + SAS fingerprint to the receiving phone; fallback to a 2-frame ultrasonic handshake via WebAudio as a party trick.

### 3.4 Expiring share links with server-side rooms — `P1 · S 🔧`
`/link` generator: one-click link that pre-creates the room server-side, embeds `join=…&pin=…` + PAKE commitment, with selectable TTL (5 min / 1 h / 24 h) and one-join semantics (room dies after first pairing).

### 3.5 IPv6 + dual-stack ICE guidance — `P2 · S`
Surface IPv6 candidate availability in diagnostics and prefer stable IPv6 host pairs on dual-stack LANs (often bypasses NAT44 entirely).

---

## 4. Files & Storage

### 4.1 Received-files vault — `✅ SHIPPED v1.3`
OPFS-backed vault (`vault/<transferId>/…` + IndexedDB meta in its own DB): every verified received transfer is kept automatically (Settings toggle, default ON), searchable in the landing "Files vault" view, re-downloadable per file or as a folder, with per-entry SHA-256 ✓ badges and deletion. Budget with LRU eviction (512 MB / 2 GB / 8 GB / unlimited; oldest entries evicted first). Auto-save trust scope skips the pickers entirely (vault-only save).

### 4.2 Zip-on-receive — `P2 · M`
"Download as single .zip" for multi-file transfers (client-side zip via `CompressionStream`-based writer or tiny lib). Great for mobile where picking a folder is painful.

### 4.3 Conflict-aware save options — `✅ SHIPPED v1.2`
When saving a multi-file transfer into an existing folder (File System Access path), FluxDrop detects name collisions up front and opens a per-file resolution dialog — auto-rename (`"name (1).ext"`), overwrite, or skip — with apply-to-all. Without FSA (mobile/older browsers) the download fallback keeps the browser's native uniquification.

### 4.4 Rich file previews on consent — `✅ SHIPPED v1.2`
Before accepting, the receiver fetches head-bytes previews over the DataChannel (`PREVIEW_REQ`/`PREVIEW_DATA`, first 8 files × 24 KB, E2E-encrypted when the PAKE session is active): images render as real thumbnails, text/code shows the first line, everything else gets a typed chip. Consent happens with your eyes, not just filenames.

### 4.5 Send queue editing mid-session — `P2 · M`
Add/remove/reorder queued files while a transfer session is live; manifest versioning already has a `version` field to build on.

### 4.6 Clipboard & snippet upgrades — `P2 · M`
- Continuous **clipboard sync mode** between paired devices (opt-in toggle)
- Rich snippets: syntax-highlighted code (react-syntax-highlighter is already a dep), Markdown preview, >1 MB snippet chunking
- Snippet → QR for tiny payloads (no connection needed)

---

## 5. UX & Interface

### 5.1 Transfer activity dock — `✅ SHIPPED v1.3`
Persistent bottom-center dock (safe-area aware) visible in every active transfer state from anywhere in the app: state + percent + live speed when collapsed; expandable to progress bar, elapsed, chunk counts, per-receiver mini-rows for group sends, with pause/resume, cancel and jump-to-transfer. Collapses into the full progress card by design.

### 5.2 Command palette (⌘K) — `P2 · S`
A cmdk-based palette (dep already present) unifying: start send/receive, recent rooms, history search, settings, theme, diagnostics — the keyboard shortcuts already exist; this gives them a home.

### 5.3 Drag-out of received files — `P3 · S`
From the completion screen, drag a file chip straight into Finder/Explorer via `DataTransferItem` (Chrome desktop; graceful fallback to the download button).

### 5.4 Sound & haptics presets — `P3 · S`
Complete/connect chime packs + `navigator.vibrate` on mobile completion; quiet-hours toggle.

### 5.5 Accent theming — `P2 · S`
Keep the emerald/teal identity as default, add 4–5 accent presets + high-contrast mode; persisted per device in `fluxdrop-prefs`.

### 5.6 First-run speedrun — `P2 · S`
Replace the 7-step tour with a single interactive "try it now" sandbox: send a demo file to a self-paired preview window. Cuts time-to-first-success to ~15 seconds.

---

## 6. Collaboration & Multi-device

### 6.1 Group rooms (1 → N fan-out) — `✅ SHIPPED v1.3`
`MAX_DEVICES_PER_ROOM` lifted (default 8, env-tunable 2..32): the sender holds ONE RTCPeerConnection per receiver (dedicated DataChannel, consent, PAKE session key, adaptive flow window and resume bitmap per peer), driven by a cooperative wave scheduler with per-peer positions in the deterministic send order (late acceptors catch up from 0; post-completion pairings trigger a fresh redelivery leg). Signaling relays are strictly UNICAST per addressed device. Aggregate progress counts a chunk only when every required receiver holds it; a departing receiver stops being required and the send continues. Room roster shows live per-receiver progress bars.

### 6.2 Relay-to-peer chaining — `P3 · L`
A paired receiver can re-publish received files as a new sender — an explicit, consent-based mini-mesh for reaching a third device that can't reach the original sender.

### 6.3 Room chat & read receipts — `✅ SHIPPED v1.3 (chat; receipts via existing chunk-ACK path)`
In-room text channel over the DataChannel (opcode CHAT 0x12, 2000-char cap): broadcast from the sender to every receiver, replies addressed back per peer, sealed with the per-peer PAKE session key while E2E is active (plaintext frames dropped when active — same anti-downgrade guard as payloads). Floating collapsible panel with unread badge; signaling relays nothing.

### 6.4 Device trust levels — `✅ SHIPPED v1.3`
Trusted peers now carry scopes — `auto-accept files` / `auto-accept snippets` (all-files-match snippet-*.txt ≤100 KB) / `auto-save to vault` (skips pickers, saves into the Files vault) — plus a trust-on-first-use SAS fingerprint recorded at trust time and surfaced in Settings → Privacy so the PIN-verified code is auditable later. Legacy entries migrate to all-true scopes.

---

## 7. Platform, PWA & Distribution

### 7.1 Mobile app shells — `P2 · L`
Capacitor wrapper (Android/iOS) adding: share-sheet integration everywhere, background transfer with OS notifications, "keep screen awake" during transfer. Web codebase stays canonical.

### 7.2 Desktop wrapper — `P3 · M`
Tauri shell with system tray "quick drop" target and native save dialogs; optional integration with OS share menus.

### 7.3 Background transfer resilience — `P1 · M`
Page Lifecycle API: auto-pause on `freeze`/background on mobile, persist resume state, request a sync/complete notification on resume. Pairs with 1.5 auto-retry.

### 7.4 Offline-first landing + LAN mode — `P2 · S`
Service worker already caches the shell; wire the full landing + nearby-discovery (3.2) so a LAN-only, internet-less transfer is possible end-to-end.

---

## 8. Infrastructure & Self-hosting

### 8.1 One-command self-host kit — `✅ SHIPPED v1.1`
`docker-compose.yml` with app (multi-stage Dockerfile → Node 22 standalone runtime), signaling service, coturn (static-auth-secret wired to the same `TURN_SECRET`), and Caddy front (`deploy/Caddyfile.docker`). `.env.docker.example` + README quickstart. Run: `cp .env.docker.example .env && docker compose up -d --build`.

### 8.2 Signaling server admin dashboard — `P3 · M 🔧`
Opt-in local page: live rooms, connection counts, relayed-bytes (metadata only), geo-none privacy note, kill-switch. Good for fleet/education deployments.

### 8.3 Multi-region signaling + closest-IP hint — `P3 · L 🔧`
For public hosted instance: region pick via latency probe from the client before `io()` connect; rooms pinned to their region.

---

## 9. Developer Experience & Extensibility

### 9.1 Headless CLI sender/receiver — `P2 · M 🔧`
`bunx fluxdrop send ./file --room XXXX` using the same protocol/encoding modules (`src/lib/fluxdrop/*` are framework-agnostic by design). Enables automation, CI artifact handoff, and server-to-server drops.

### 9.2 Protocol spec + conformance suite — `P2 · M 🔧`
Publish the binary wire protocol (9-byte header) as a versioned spec with golden vectors, and a test harness that validates any implementation (browser, CLI, future Rust client). Locks interop as the project grows.

### 9.3 Public JS SDK — `P3 · L`
`@fluxdrop/sdk`: embed a send/receive widget into any web app (docs site, support chat, LMS). Widget = the existing UI components, props-driven, themeable.

### 9.4 Structured diagnostics export — `P1 · S`
One-click "copy debug bundle" (sanitized: no file names unless allowed): ICE pair, DTLS version, throughput curve, chunk timeline. Turns "it was slow" bug reports into actionable data.

---

## 10. Accessibility & Internationalization

### 10.1 i18n rollout — `P1 · M`
`next-intl` is installed but unused. Extract UI strings, ship EN + 5 launch locales (ES, FR, DE, PT-BR, JA), RTL-ready layout audit. QR flow text especially matters for cross-border sharing.

### 10.2 A11y sweep — `P1 · S`
`prefers-reduced-motion` handling for the particle field/celebration animations, focus-trap audit of dialogs, screen-reader announcements already partially covered by `TransferAnnouncer` — extend to diagnostics and settings.

### 10.3 Low-vision transfer mode — `P3 · S`
Large-type progress screen + extra-high-contrast chunk map; the "compare 6 digits" SAS UI gets an ARIA live readout.

---

## 🗺️ Suggested Release Trains

| Train | Theme | Items |
|-------|-------|-------|
| **v1.1 — "Just works"** | Reliability & reach | ✅ 1.5 auto-retry · ✅ 1.1 adaptive flow window · ✅ 1.2 compression · ✅ 3.1 TURN · ✅ 8.1 self-host kit · ✅ 1.4 pipelining — **SHIPPED** |
| **v1.2 — "Locked down"** | Security & trust | ✅ 2.1 PAKE E2E · ✅ 2.2 SAS-in-transcript · ✅ 2.3 at-rest encryption · ✅ 2.4 alias rotation · ✅ 4.4 rich previews · ✅ 4.3 conflict-aware save — **SHIPPED** |
| **v1.3 — "Together"** | Multi-device & collaboration | ✅ 6.1 group rooms · ✅ 5.1 activity dock · ✅ 6.3 room chat · ✅ 6.4 trust levels · ✅ 4.1 files vault · ✅ 1.6 streaming receive — **SHIPPED** |
| **v1.4 — "Everywhere"** | Platform & world | 3.2 LAN discovery · 10.1 i18n · 7.3 background resilience · 9.4 debug bundle · 5.2 command palette |
| **v2.0 — "Ecosystem"** | Big bets | 7.1 mobile shells · 9.1 CLI · 9.2 protocol spec · 9.3 SDK · 1.7 Merkle trees · 8.3 multi-region |

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
