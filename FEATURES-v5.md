# 🧬 FluxDrop — v5 Roadmap: Features & Enhancements

Successor to `FEATURES.md` (v1.1 → v4, all shipped). This document is the v5 plan:
grounded in what exists, nothing here duplicates shipped features.

**Legend:** `⬜ planned` · `🚧 in progress` · `✅ shipped (verified)` · `🔧 self-host extra`

---

## Status snapshot

| # | Feature | Status |
|---|---------|--------|
| A1 | Fast lanes (multi-PC striping) | ✅ E2E verified |
| A2 | Relay fallback transport (server-relayed, E2E-encrypted) | ✅ E2E verified |
| A3 | Delta sync (rsync-lite) | ✅ E2E verified |
| A4 | Parallel hash pool (double-buffered streaming) | ✅ shipped (code-verified) |
| A5 | Network weather + pre-flight sim | ✅ shipped (code-verified) |
| A6 | Watch folder + scheduled send | ✅ shipped (UI verified) |
| B1 | Disappearing transfers (vault TTL + remote wipe) | ✅ E2E verified |
| B2 | Panic mode / duress PIN | ✅ E2E verified |
| B3 | Post-quantum hybrid PAKE (ML-KEM-768) | ✅ E2E verified |
| B4 | Scoped session grants | ✅ E2E verified |
| B5 | Relay abuse quotas | ✅ shipped (code-verified) |
| C6 | Pull mode (browse & request) | ✅ E2E verified |
| C7 | Kiosk / broadcast receive | ✅ E2E verified |
| C8 | Transfer templates | ✅ E2E verified |
| C9 | Arabic + RTL locale | ✅ E2E verified |
| C10 | OLED black + custom accent picker | ✅ E2E verified |
| C11 | ETA confidence bands | ✅ shipped (unit-verified) |
| D12 | Ship the shells (Tauri desktop + Capacitor Android) | ✅ E2E verified (bridge sim) |
| D13 | Background transfer resilience (native shells) | ✅ E2E verified (sim lifecycle) |
| E14 | Webhooks / event bus (automation hub) | ✅ E2E verified |
| E15 | Serverless signaling adapter (CF Worker + DO) | ✅ smoke-verified (socket.io client) |
| E16 | @fluxdrop/sdk npm + widget + docs site | ✅ E2E verified (widget → app transfer) |
| E17 | Federated signaling (S2S room peering) | ✅ E2E verified (cross-server transfer) |
| F18 | Chaos harness in CI | ✅ E2E verified (4/4 profiles) |
| F19 | Speedrun ghosts + leaderboards | ✅ E2E verified |

**E2E evidence (two browser sessions via gateway, 2026-10-29):**
- A1: fastLanes=2 + 20 MB fresh file → lane 1 connected mid-transfer and
  striped ~2.1 MB+ (fair-share rotation), SHA-256 ✓ both sides. Fair-share
  fix: budget-max starved lanes on links with headroom (primary won every
  tie); ties now rotate.
- A2: `__fluxdropRelay.forceNext()` → "skipping PC creation", "manifest sent
  SEALED over signaling", transfer completed over relay, SHA-256 ✓; relay
  badge now also renders in the final summary card (was pre-transfer-only).
- A3: receiver re-received a same-name 20 MB file from its vault →
  "delta mode armed — 20.0 MB → 409 B on the wire", Merkle 320 leaves
  verified, "Δ saved 20.0 MB" badge on the summary.
- A4/A5: headless Chrome provides no Workers (pool falls back to main
  thread — logged, graceful) and the weather probe needs an interactive
  room cycle; both are lint+tsc clean and code-verified.
- A6: WATCH FOLDER + SCHEDULED SEND panels render in the sender flow
  (status badges, feed, queue, switches); FS-directory picking itself can't
  run headless.

**Section B evidence (two browser sessions via gateway, 2026-10-30):**
- B1: sender pref TTL=1 min → manifest ttlMs → sender summary badge
  "Disappears after 1 min"; receiver's vault showed the entry with a live
  countdown badge ("51s", tooltip "Disappearing transfer…"); after the TTL
  elapsed the sweep purged it (vault 1 transfer → 0, IDB meta 0 entries —
  OPFS bytes + metadata both gone). Remote wipe: sender's "Wipe on
  receiver" button → receiver toast "Transfer wiped on this device",
  vault entry + resume cache + buffers purged.
- B2: Settings → Privacy → "Set panic PIN" armed 919191 (salted SHA-256
  in localStorage, "armed" badge). Joining a room with the duress PIN
  showed the byte-identical INVALID_PIN error a wrong PIN shows — and
  silently wiped: transfer history (1 → "No transfers yet"), recent rooms,
  vault, chunk cache, trusted devices, chat, telemetry.
- B3: every PAKE handshake now also runs ML-KEM-768 (@noble/post-quantum,
  pure JS). Both consoles: `E2E session active … [PQ hybrid ML-KEM-768]` +
  matching SAS; verification card shows a PQ badge. Standalone crypto
  tests: hybrid keys match, classic-only fallback byte-identical (older
  peers), tampered kemCt caught by the confirmation MAC (ML-KEM implicit
  rejection → different keys → MAC fails).
- B4: consent dialog gained grant checkboxes (chat default on, clipboard
  default off). With chat UNchecked: the sender's chat draft was refused
  (outbound filter, message never left) and the receiver never displayed
  it. Grants ride transfer-accepted; both sides' transparency panels get a
  "Session permission grants" section (rendered on the sender-side record
  path; the receiver-side display window is narrow because the room view
  swaps to the progress card at accept — the record + enforcement are live).
- B5: signaling server built + booted with the quota ladder (per-IP bucket
  → per-room lifetime cap → admin block), /healthz 200, admin endpoints
  guarded (503 without ADMIN_TOKEN), admin dashboard gained relay-bytes
  card + policy chips + per-room Block relay buttons. Client treats
  room-cap/blocked relay-errors as fatal (no infinite retransmit).

**Section C evidence (two browser sessions via gateway, 2026-10-30):**
- C6: sender queued 3 files + pull toggle → room created ("Pull mode is
  live"); receiver joined → **SHARED LIBRARY** browser with all 3 files
  (folder groups, search, select-all); selected ONLY c-b.txt → "1 selected ·
  5.1 KB" → Request → sender hashed the pick (VALIDATING card) → sealed
  manifest → receiver auto-accepted the exact selection — **c-b.txt received,
  c-a/c-c never travelled, SHA-256 ✓**. Two real bugs found+fixed in E2E:
  the DC-open manifest early-return swallowed the pull offer, and filesRef
  wasn't rebound to the picked subset (c-a's bytes went out under c-b's
  checksum).
- C7: receiver "Kiosk mode" → fullscreen station (big QR, room+PIN,
  "Trusted devices only" → toggled to "Everyone"); sender opened the QR's
  **#claim=** deep link → "Sending to kiosk ROOM" banner → picked a file →
  Send — no consent dialog (auto-accept), transfer completed, wall shows
  "1 received · 5.1 KB" with c-a.txt "in vault", Merkle verified, and the
  station **rotated to a fresh room** for the next sender. Two real bugs
  found+fixed in E2E: receivers that join before the sender claims never
  re-initiated pairing (now onDeviceDiscovered mirrors the join-time pairing
  request for senders), and a pre-open completed transfer triggered an
  instant bogus rotation (stale-manifest guard added).
- C8: all 5 preset chips render in the sender flow; "Quiet hours" tap →
  prefs { qos 25 Mbit/s, soundPack silent } + honest toast "cap 25 Mbit/s ·
  sounds off"; "Quick drop" restores defaults.
- C9: العربية locale → `<html dir="rtl" lang="ar">`, hero/buttons in
  Arabic (أرسل الملفات / إرسال ملفات), back-arrows carry the flux-flip-rtl
  mirror class; English restores dir=ltr.
- C10: dark + OLED toggle → `html.flux-oled`, body background **lab(0 0 0)**
  (true black), glass cards near-black; Custom accent chip + hue slider →
  live re-skin (`--color-flux-500: oklch(0.62 0.14 360)`, persisted).
- C11: computeEtaBand unit-verified — steady link (20 samples ≈1 MB/s) →
  9.86–9.97 s band around a 9.90 s point for 10 MB; jittery link → 5.9–33 s
  band; <5 samples or 0 remaining → null (classic point ETA fallback).

**Section D evidence (two browser sessions via gateway, 2026-10-30):**
- D12/D13 were built as REAL shell sources + a web-side bridge whose whole
  surface is browser-VERIFIABLE through a first-class simulation mode
  (`?shellSim=capacitor|tauri` or Settings → Device — a real installed shell
  always wins over the sim; detection probes `window.__TAURI__` /
  `window.Capacitor`). One E2E run, all green:
- **Transfer regression through the new wiring**: plain-web sender →
  sim-Capacitor receiver joined + accepted → `Transfer complete`,
  `d-file.txt` arrived, `SHA-256 verified` badge, Done button — and the
  plain-web session showed NO native chip, no shell card lines.
- **D13 lifecycle verbatim** (receiver console, the exact calls the Android
  foreground service / desktop tray would receive):
  `keepScreenAwake(true)` → `transfersActive(true) — "Reading manifest…"` →
  `"Receiving files…"` → `"Verifying checksums…"` → `"Transfer complete"` →
  `keepScreenAwake(false)` → `transfersActive(false) — "Idle"`. The
  web build's hidden-tab auto-pause is correctly suppressed in shells
  (`isNativeShell()` guard in use-background-resilience).
- **D12 deep links**: `window.__fluxdropSim.deepLink('fluxdrop://claim?room=KIOSKQ1&pin=4321')`
  → view switched to sender + "Sending to kiosk KIOSKQ1" banner + toast
  (same parser serves the web `#claim=`/`#join=` hashes and the
  `fluxdrop://` scheme; 15/15 parser unit checks pass).
- **D12 share-sheet / file associations**: `__fluxdropSim.openFiles([...])`
  → "Added 1 shared file" toast, `d-shared.txt` sitting in the sender queue
  ("1 file · …") — the same arming path the Web Share Target uses.
- **Shell card + controls** (Settings → Device): "Capacitor · simulated"
  badge, capability chips, live "Foreground service: …" line, bridge-call
  log. Switching the sim to Tauri via the REAL Radix Select (keyboard:
  ArrowDown → Home → ArrowDown → Enter) flipped the header chip to
  "Desktop app · sim", revealed the Tray-status line + autostart row, and
  the autostart toggle round-tripped (`__fluxdropSim.autostart() → true`,
  "Autostart enabled" toast, call logged).
- **Rust/Kotlin sources ship complete but were not compiled here** (no
  cargo/gradle/SDK in the sandbox): the Tauri project (tray + close-to-tray,
  single-instance forwarding, deep-link plugin, autostart, file
  associations with a Rust-side READ ALLOWLIST, `.fluxdrop` room-link
  files, `flux_read_file_chunk` at 4 MiB/chunk) and the Capacitor plugin
  (ForegroundTransferService with partial wake lock + dataSync
  notification, share-sheet in/out with cache stashing, intent deep links,
  keep-awake, FileProvider) are template-faithful and documented in
  src-tauri/README.md + src-capacitor/README.md.

**Sections E & F evidence (two browser sessions via gateway + headless
playwright + worker smoke, 2026-10-30):**
- E14: a webhook registered in the admin automation hub
  (http://localhost:3050/hook, events room.created/room.joined/
  transfer.started/transfer.complete) received 10/10 deliveries, EVERY one
  HMAC-signed (`X-FluxDrop-Signature: t=<ts>,v1=<hex>`, Stripe-style) —
  covering both real transfers of the run (fed + widget): room.created ×2,
  room.joined ×2, transfer.started ×1 (P2P manifests ride the DataChannel;
  the signaling manifest path fires it for SDK/relay sends), transfer.complete
  ×3, plus webhook.test + federation.link. Metadata-only payloads (room ids,
  counts, bytes) — never PINs/SDP/content.
- E17: two signaling instances (alpha :3013, beta :3014, HMAC-authed
  `/federation` links, link "up" in both admins, /region advertises peers)
  → sender on alpha created room A9ZBFC, receiver (web app, endpoint pref
  pointed at beta) joined `A9ZBFC@alpha` through the link → consent →
  transfer complete, file arrived, SHA-256 verified. WebRTC stays DIRECT
  browser↔browser; only signaling tunneled. Server-side: roomsWithFed=1,
  fed device tracked with `fedVia`; home-side per-IP relay budget enforced
  pre-tunnel, owner-side room ladder post-tunnel.
- E16: Settings → Dev tab: live wire-conformance badge ran the golden-vector
  suite in-app (`/api/conformance` → "conformance · 72 passed"); the REAL
  production `<fluxdrop-widget>` (imported from sdk/src, pointed at the
  app's own signaling via the pref-aware resolver) sent
  sdk-widget-demo.bin → joined from a second browser session → Transfer
  complete + SHA-256 verified; the widget flipped to its verified-done
  state. `npm pack --dry-run` = 22 files / ~246 kB (tsup ESM+dts build).
- F18: `bun run chaos` (playwright, headless Chromium) drove REAL 3 MiB
  transfers through the app under in-app impairment: steady 21.9 s,
  latency (+250 ms ±80 all frames) 20.1 s, lossy-wifi (120 ms + 20 % ICE
  loss) 22.2 s, flaky (signaling drop every 15 s → rejoin-room ladder
  cycles, device_left/rejoined in server logs) 21.1 s — ALL SHA-256
  verified; ci/chaos-report.json + badges regenerate per run. The harness
  itself caught and fixed two real bugs during development: the chaos
  boot-resolve no-op (`?chaos=` silently inactive) and an
  `Illegal invocation` in the DataChannel impairment wrapper (pre-bound
  prototype send) — exactly the perf-resume-1 bug class it exists for.
- F19: speedrun race mode — "Start timed run" sent the fixed 2 MiB
  fluxdrop-speedrun file through the NORMAL pipeline (room + consent +
  verified complete); the dialog timed accept→verified-complete, showed
  "New personal best!" + effective Mbit/s, persisted the ghost
  (fluxdrop:speedrun-best), and "Race again" rendered the ghost bar +
  "vs ghost" delta on run 2. Opt-in leaderboard: alias-only submit through
  the signaling bridge ranked live ("world rank #N", board renders, admin
  dashboard shows the same board); server rate-limits 5 submissions/
  10 min/IP and sanitizes entries (alias ≤24 chars, timeMs 200..600 000).
- E15: `serverless/signaling-worker` — Cloudflare Worker + Durable Object
  (WebSocket hibernation, SQLite class, rooms persisted across eviction):
  the STOCK socket.io-client passed a 12-check smoke roundtrip (engine.io
  v4 WS handshake, create/join/rejoin, pairing + SDP relay, sealed
  transfer-manifest, relay-data through the per-room token bucket,
  relay-ack, NOT_MEMBER rejection). Wrangler dev boots it locally; deploy
  is `bun run deploy`. Deltas vs the Bun server documented in its README
  (no /nearby, no per-IP relay quota, no admin HTML/federation/webhooks).

> Note on A4: BLAKE3/WASM was evaluated and **dropped** — `blake3` fails to
> resolve its `blake3-wasm` dep on the current registry, and SHA-256 digests
> are protocol-canonical (changing hashes breaks interop with deployed
> clients). v5 parallelizes the existing SHA-256 pipeline instead.

---

# A. Transfer & Network (speed / reliability) — v5 focus

## A1. Fast lanes — multi-PC striping — `🚧`

**Problem.** One RTCPeerConnection = one SCTP association = one congestion
window. On lossy Wi-Fi the single cwnd caps throughput far below the burst
sender's capability (~9 MB/s on clean links).

**Design.** *Additive extra lanes* — the primary PC (lane 0) keeps every
existing code path (pairing, PAKE, manifest, recovery ladder, pause/resume);
extra lanes 1..N are pure throughput bonuses negotiated after the transfer is
already streaming:

- `laneCount` pref (1–4, default 1). Lanes only spin up when:
  transfer is TRANSFERRING **and** manifest total > 16 MiB **and** exactly one
  receiver (fan-out stays single-lane in v5).
- Signaling `webrtc-offer/answer/ice` payloads gain optional `lane?: number`
  (absent = 0 — wire-compatible with older peers). Server relays opaquely.
- Sender creates one `FluxDropWebRTC` per lane, attaches the **same**
  chunk/ACK handlers (the receive path is chunk-index-based and lane-agnostic).
- Send loop stripes round-robin weighted by per-lane `canSend` windows.
- ACKs ride the lane that delivered the chunk (load-balanced).
- Lane death: drop + re-stripe, transfer unaffected while primary lives.
  Primary death: existing recovery ladder (lanes torn down).
- Settings → Tuning: "Fast lanes" selector with explainer copy.

**Why multi-PC, not multi-DataChannel:** multiple streams share one SCTP
association (one cwnd); multiple associations multiply the congestion window
and add path diversity when lanes use different ICE/relay policies later.

**Verify:** laneCount=2 → big file → both lanes visible in stats, SHA-256 ✓,
aggregate ≈ sum of lanes; laneCount=1 → byte-identical legacy behavior.

## A2. Relay fallback transport — `🚧`

**Problem.** Some networks kill UDP entirely (corporate NAT/proxies). Today
that means: no transfer at all. The recovery ladder exhausts → FAILED.

**Design.** When every P2P attempt is exhausted, fall back to relaying the
(already E2E-encrypted) chunks through the self-hosted signaling server:

- Server: `relay-data` / `relay-ack` socket events — room-membership checked,
  base64 ≤ 128 KiB per message, per-room token-bucket quota (default 4 MB/s,
  8 MB burst, configurable constant), relayed-bytes counter surfaced in the
  admin dashboard.
- Client: `RelayTransport` class — windowed send (8 in flight, ack-driven),
  paced; receiver feeds the same chunk-ingest path as DC chunks (index-based,
  transport-agnostic).
- Engine: on total P2P failure + `relayFallback` pref (default **on**) →
  switch instead of FAILED; resume semantics reuse the bitmap (only unsent
  chunks relay). UI badge "Relayed via server" in connection status +
  transparency panel.
- WebTransport (HTTP/3) remains the future upgrade path for the relay driver;
  v5 ships the WebSocket-relay driver (works everywhere today, incl. the
  sandbox gateway). The transport is behind a driver interface so a
  WebTransport driver can slot in without engine changes.

**Why safe:** payload is E2E-encrypted (SPAKE2-derived keys) — the server
sees ciphertext + sizes only, same trust level as SDP/ICE relay it already
handles.

**Verify:** force P2P impossibility (relay-only ICE policy, no TURN) →
transfer completes via relay, SHA-256 ✓, badge shown, quota enforced.

## A3. Delta sync (rsync-lite) — `🚧`

**Problem.** Re-sending a modified 4 GB video moves the whole file even when
5% changed.

**Design.** Classic rsync two-phase, adapted to the existing chunk engine:

- `src/lib/fluxdrop/delta.ts` (pure, dependency-free):
  - 256 KiB blocks; weak rolling hash (adler32-style, O(1) roll per byte) +
    strong SHA-256 per block.
  - `blockHashes(file)` — receiver computes block list.
  - `buildPatch(newBytes, remoteBlocks)` — rsync scan: weak hit → strong
    verify → `copy` op (skip block) else extend `raw` run.
  - `encodePatch/applyPatch` — compact streaming serialization (`FDDELTA1`
    magic + varints) and reconstruction via `readBlock(blockIndex)` callback
    (never holds whole file in memory).
- Wiring: per-file delta **codec layer** — the transport stays dumb chunk
  indices; a delta-encoded file's byte stream IS its patch stream (chunked
  by the same chunker). Receiver reconstructs from the old version and the
  final SHA-256 must equal the original new-file digest (rsync guarantee).
- Old-version sources: vault-stored prior transfer (chunk store powers the
  existing "Re-download" feature) — auto-detected by name; else full send
  fallback (delta never blocks a transfer).
- UI: sender-panel toggle per session + summary badge "Δ saved X MB".
  Protocol: manifest file entries gain optional `delta` descriptor; peers
  without v5 ignore it and receive a full send (feature-negotiated).

**Verify:** old+new 20 MB files with 3 small mutations → patch ≪ full,
reconstruction byte-identical, SHA-256 ✓; no old version → clean full send.

## A4. Parallel hash pool — `🚧`

**Problem.** One inline worker serializes hashing; on multi-GB files the
pre-send hash phase (and post-receive verify) is now slower than the wire
since perf/resume-1 raised transfer speeds.

**Design.** SHA-256 of a single stream is inherently sequential — the wins
are (a) concurrency across files, (b) decoupling disk reads from crypto:

- Worker pool (2–6 workers, `hardwareConcurrency`-capped) — one file per
  worker concurrently (multi-file manifests).
- Double-buffered reads inside each worker: prefetch the next 4 MiB slice
  while the hasher digests the current one (I/O latency no longer serializes
  crypto).
- Per-chunk verification paths (Merkle/resume bitmap) route through a generic
  pool task queue.
- Digests stay byte-identical SHA-256 (protocol-canonical). All public APIs
  keep their signatures (call sites unchanged).

**Verify:** N-file manifest hashes with ~N× parallelism in the progress
curve; single-file streaming shows no read stalls; digests unchanged.

## A5. Network weather + pre-flight sim — `🚧`

**Problem.** Users discover hostile NATs mid-transfer ("why is it stuck").

**Design.** A self-contained diagnostics probe — no engine coupling:

- `src/lib/fluxdrop/net-weather.ts` → `probeNetwork()`:
  - Throwaway PC ICE gather → classify host/srflx/relay candidates (STUN from
    the existing `DEFAULT_ICE` config). srflx present ⇒ NAT traversable.
  - TURN TCP reachability heartbeat (best-effort, from `turn.ts` config).
  - In-page loopback PC pair (no signaling) with a DataChannel → RTT and
    8 MiB throughput-ceiling burst (device CPU/DC ceiling, paced by
    `bufferedAmountLowThreshold`).
  - Verdict: `direct-likely` / `nat-hostile` / `relay-needed` + advice chips
    ("Enable Fast lanes", "Relay fallback will carry this", …).
  - Fully cancellable, never throws, partial results + errors array.
- UI: `network-weather.tsx` card (sun/cloud metaphor, lucide icons), manual
  "Run probe" + optional 30 s auto-refresh, collapsible section in the
  diagnostics panel.

**Verify:** probe runs in normal LAN sandbox → srflx/host mix, loopback
ceiling in the tens-of-MB/s range, advice sensible; cancel mid-probe clean.

## A6. Watch folder + scheduled send — `🚧`

**Problem.** Recurring sends require manual picking every time.

**Design.** File System Access API (Chromium):

- `src/lib/fluxdrop/watch-folder.ts`: `showDirectoryPicker` handle persisted
  in IndexedDB; polling diff (size+mtime snapshot vs IDB) yields new/changed
  files every ~4 s; permission query/re-request helpers.
- `watch-folder-panel.tsx`: pick folder, live status, new-file feed; files
  auto-queue and flush to `startSend()` when a send session is live, else
  held in a local pending list (in-memory Files + IDB metadata; limitation
  surfaced in copy — background tabs can't retain un-granted handles forever).
- Scheduled send: time-of-day + daily toggle, stored in prefs; at trigger,
  queued files auto-send if a session is active, else a toast.
- Feature-detected: panel hidden entirely when `showDirectoryPicker` is
  absent.

**Verify:** pick dir → drop new file in OS → appears in feed → auto-send on
active session; schedule fires a toast on an idle session.

---

# B. Privacy & Security — v5 shipped

1. **Disappearing transfers (vault TTL)** — ✅ shipped. `manifest.ttlMs`
   (sender pref: Keep / 1 min / 10 min / 1 hour / 1 day) arms the receiver's
   vault copy with `expiresAt`; `sweepVaultExpiry()` purges on every list
   (OPFS bytes + IDB metadata). Vault entries show live countdown badges.
   `WIPE_REQUEST` (opcode 0x14) lets the sender purge the receiver's copy
   mid/post-transfer over the open DataChannel (vault entry + resume chunk
   cache + in-memory buffers).
2. **Panic mode / duress PIN** — ✅ shipped. A second PIN (salted SHA-256,
   localStorage) typed anywhere a room PIN is asked (receiver join,
   share-link claim) silently wipes history, vault, chunk cache, trusted
   devices, recent rooms, chat and telemetry, then refuses the pairing with
   the byte-identical INVALID_PIN error. Arming UI in Settings → Privacy.
3. **Post-quantum hybrid PAKE** — ✅ shipped (was “v6 headline candidate”).
   Every SPAKE2 handshake now runs ML-KEM-768 in parallel
   (`@noble/post-quantum`, pure JS — no WASM). Hybrid IKM =
   concat(SPAKE2 shared, KEM ss) with domain separation; the transcript +
   SAS bind kemPub + kemCt, so HNDL attackers who recorded today's
   classical transcript can't derive tomorrow's key. Older peers fall back
   to the byte-identical classic v1.2 derivation. Verification card shows a
   PQ badge when the hybrid leg contributed.
4. **Scoped permission grants** — ✅ shipped. The consent dialog grants the
   sender per-session capabilities: `chat` (default on) and `clipboard`
   (default off) — `files` models future pull-mode rights. Grants ride
   `transfer-accepted`, are enforced receiver-side on every inbound
   CHAT/CLIPBOARD frame (the authority) and filtered sender-side (UX);
   the transparency panel renders both directions.
5. **Relay abuse quotas** — ✅ shipped. Beyond A2's per-room token bucket:
   a per-IP relay bucket (2 MB/s sustained, 16 MB burst), a per-room
   LIFETIME cap (512 MB, `relay-error { reason: 'room-cap' }` — client fails
   over instead of retransmitting forever), and an admin block/unblock
   kill-switch (`relay-error { reason: 'blocked' }`). Admin dashboard gained
   relay-bytes totals, policy chips, abuse counters and per-room Block
   relay buttons. All env-tunable; metadata-only (opaque base64 lengths).

# C. UX & Interaction — v5 shipped

6. **Pull mode ("browse & request")** — ✅ shipped. The sender's "Pull mode"
   toggle swaps the pushed manifest for a shared LIBRARY (metadata only,
   sealed over the e2e-relay envelope like delta control). The receiver gets
   a folder-grouped browser with search, image thumbs (PREVIEW frames keyed
   by libraryId), multi-select and a running total; Request sends the picked
   indices, the sender hashes ONLY the picks and pushes the sealed manifest,
   and the receiver auto-accepts when the manifest matches the selection
   name+size (a substituted manifest falls back to the consent dialog).
   Single-request rooms in v5 (first picker wins).
7. **Kiosk / broadcast receive** — ✅ shipped. A fullscreen receive station
   (receiver panel button / command palette): mints pre-created share-link
   rooms, shows a huge QR + PIN, auto-accepts (trusted-only default, everyone
   via the open-kiosk toggle) straight into the Files vault — no pickers on a
   TV — and renders a progress wall (live transfer + history). A fresh room
   rotates in after every transfer so many senders can use the station
   sequentially. The QR is a new `#claim=ROOM&pin=PIN` deep link that arms
   the sender side ("Sending to kiosk ROOM" banner — pick files, press Send).
8. **Transfer templates** — ✅ shipped. Five one-tap presets in the sender
   flow (Quick drop / Photo burst / Quiet hours / Ephemeral / Careful) that
   apply the transfer-affecting prefs; the toast lists exactly what changed.
   Safety knobs (trust, duress PIN, paranoid mode) are never templated.
9. **Arabic + RTL locale** — ✅ shipped. العربية joins the six launch
   locales; `<html dir=rtl lang=ar>` via prefs + provider effect, directional
   glyphs mirror via .flux-flip-rtl, logical margins (me-/ms-) on the flipped
   rows, and every future locale inherits the RTL plumbing.
10. **OLED black + custom accent picker** — ✅ shipped. `flux-oled` (scoped
    to .dark) takes the page to true black with near-black cards/glass and a
    dimmed mesh; a Custom accent preset with an oklch hue-wheel slider
    re-skins live and persists.
11. **ETA confidence bands** — ✅ shipped. computeEtaBand() turns the real
    speed history into a forecast range (median point, p25/p75 bounds,
    2.5× clamp) shown as "≈ 1m 12s (1m 05s–1m 30s)" once ≥5 samples exist;
    the classic point ETA covers the warm-up.

# D. Platform & Distribution — v5 shipped

12. **Ship the shells** — ✅ shipped. The web app gained a typed **native
    bridge** (`src/lib/fluxdrop/native-bridge.ts`) that probes
    `window.__TAURI__` / `window.Capacitor`, exposes the full capability
    matrix (tray, autostart, deep links, share target/out, foreground
    service, keep-awake, file-assoc reads), and degrades to a no-op on the
    plain web build. A first-class **simulation mode** (`?shellSim=` or
    Settings → Device) mirrors either shell in a browser — every bridge call
    logged — which is how D12/D13 are E2E-verified without native
    toolchains. **Desktop (Tauri 2)**: the Rust project is complete — tray
    with live status + Show/Quit, close→hide-to-tray, single-instance argv
    forwarding, `fluxdrop://` deep-link plugin (+ `.fluxdrop` room-link
    files), autostart (`--hidden`), file associations with a Rust-side read
    ALLOWLIST (`flux_read_file_chunk`, 4 MiB chunks — the webview can only
    read files the OS handed the app), committed PNG/ICO/ICNS icon set.
    **Android (Capacitor)**: `src-capacitor/plugin` — FluxDropShell plugin
    with ForegroundTransferService (partial wake lock, dataSync
    notification), share-sheet in (streams stashed to cache, cold-start
    replay) and out (FileProvider ACTION_SEND), intent deep links,
    keep-screen-awake, plus the app manifest snippets. Deep links and share
    opens route through ONE parser (`deep-links.ts`) shared with the web
    hash links, arming receiver-join / kiosk-claim / sender-queue exactly
    like the web paths.
13. **Background transfer resilience** (native shells) — ✅ shipped.
    `use-native-resilience.ts` subscribes to the transfer store and drives
    the shells' keep-alive machinery on active↔idle transitions: Android
    foreground service start/update/stop (with a 4 s terminal settle so the
    final status lands) + keep-screen-awake, desktop tray status mirror.
    The web build's hidden/frozen auto-pause is suppressed inside shells
    (`isNativeShell()` guard) — the service keeps the process fully alive,
    so pausing would fight a healthy DataChannel.

# E. Ecosystem & Infrastructure — v5 shipped

14. **Webhooks / event bus on signaling** — ✅ shipped. A lifecycle event
    bus (`mini-services/signaling/src/webhooks.ts`) fans ten event types
    (room.created/joined/closed, pairing.confirmed, transfer.started/
    complete, relay.quota, federation.link, leaderboard.entry, webhook.test)
    to admin-registered hooks. Deliveries are Stripe-style HMAC-signed
    (`t=<ts>,v1=HMAC-SHA256(secret, ts.body)`), 5 s timeout + 2 retries,
    never block the room path, and carry metadata only (room ids/counts/
    bytes — PINs, SDP and content are stripped defense-in-depth). Config
    persists to `data/webhooks.json`, env `WEBHOOKS=[…]` seeds extras. The
    admin dashboard became the automation hub: add/remove/pause/test hooks,
    per-hook delivery stats and a recent-deliveries strip.
15. **Serverless signaling adapter** — ✅ shipped.
    `serverless/signaling-worker/`: one Durable Object ("hub") with
    WebSocket hibernation speaks the SAME socket.io wire contract as the
    Bun server (engine.io v4 over WebSocket; socket.io-client connects
    unchanged). Rooms/PINs/oneJoin links, pairing + WebRTC relay, the
    transfer lifecycle, e2e-relay and the chunk relay with per-room token
    bucket + lifetime cap all run in the DO; room state persists in DO
    storage so eviction/hibernation never drops a transfer. Plain-HTTP
    endpoints (/healthz, /region, /link, /turn-credentials, JSON
    /admin/api). Verified by `test/smoke.ts` (12-check socket.io-client
    roundtrip against `wrangler dev`). Deltas vs the Bun server (no
    /nearby, no per-IP relay bucket, no admin HTML/federation/webhooks)
    are documented in its README.
16. **Publish `@fluxdrop/sdk` + docs site** — ✅ shipped (publish-runbook
    ready; `npm publish` from sdk/ is the remaining manual step — the
    package must ship from a clean checkout). The v0.1 scaffold became a
    real client: `createFluxdropClient()` runs the FULL transport
    (socket.io signaling → pairing → WebRTC DataChannel → manifest-first
    framing → 64 KiB chunks with ACK pacing + lost-ACK resweep →
    TRANSFER_COMPLETE verification), mirroring cli/src/send.ts.
    `<fluxdrop-widget>` is a framework-free custom element (shadow DOM,
    themable, RTL-aware, en/ar strings) with fluxdrop-ready/-progress/
    -complete/-error events; `@fluxdrop/sdk/react` wraps it. tsup builds
    ESM + d.ts + sourcemaps (22 files, ~246 kB packed); the engine layer
    remains the app's production wire code. The in-app face is Settings →
    Dev: a LIVE conformance badge (`/api/conformance` runs the
    golden-vector suite), copyable snippets, and a real widget demo wired
    to the instance's own signaling. `docs-site/index.html` is the static
    docs page (badges, API table, live demo slot).
17. **Federated signaling** — ✅ shipped.
    `mini-services/signaling/src/federation.ts`: servers peer over
    authenticated socket.io `/federation` links (per-pair shared secret;
    token = HMAC-SHA256(secret, selfId.ts), ±60 s window, function-form
    auth so reconnects re-sign). Rooms stay on their OWNER; a client joins
    cross-server with `ROOM@peer` — its home server tunnels join + every
    room frame (fed-join/leave/frame/broadcast/close), the owner runs all
    room logic (PIN, capacity, pairing, relay ladder — owner-side per-room
    bucket, home-side per-IP bucket). `from` is always pinned to the
    link-verified device (anti-spoof), room-scoped handlers on BOTH sides
    got tunnel interceptors, disconnects forward as fed-leave, and
    reconnects rebind through rejoin-room. The web join form accepts
    `AB3K7Q@berlin` codes; Settings → Network exposes a signaling-endpoint
    override (pref `signalingEndpoint`, pref-aware `signalingUrl()` —
    also what the Dev-tab widget uses). Admin UI: peer table with link
    state + latency, add/remove peers, federation cards in the snapshot.

# F. Quality & Fun — v5 shipped

18. **Chaos harness in CI** — ✅ shipped. `scripts/chaos-harness.ts`
    (playwright, headless Chromium) boots the stack, gates on wire
    conformance, then drives REAL 3 MiB two-browser transfers under
    in-app impairment profiles from `src/lib/fluxdrop/chaos.ts` — the same
    module Settings → Network → "Chaos lab" exposes (latency/jitter on
    signaling + DataChannel sends via a prototype wrapper, ICE-candidate
    loss, DC throttling, and periodic unexpected engine drops that
    exercise the rejoin-room ladder). Reports to ci/chaos-report.json and
    regenerates shields-style badges; `.github/workflows/chaos.yml` runs
    it on push/PR (steady + lossy-wifi by default, profile input on
    dispatch). Profiles verified 4/4 (steady/latency/lossy-wifi/flaky) —
    and the harness caught two real bugs on its first honest run (chaos
    boot no-op; Illegal-invocation in the DC wrapper).
19. **Speedrun ghosts + leaderboards** — ✅ shipped. The v4 intro dialog
    gained RACE MODE: "Start timed run" builds a fixed 2 MiB random file
    (`speedrun.ts`) and runs it through the NORMAL send pipeline; the
    timer runs receiver-accept → verified-complete while a recorder
    samples progress at 250 ms. Your best run persists as a ghost
    (fluxdrop:speedrun-best) — race again and a second progress bar
    replays it with a live "vs ghost" delta on completion. The opt-in
    global leaderboard (pref, default OFF) shares alias + time ONLY
    through the signaling server's validated, rate-limited (5/10 min/IP)
    in-memory+persisted store (`leaderboard.ts`); the dialog renders the
    top-10 with your submit rank, and the admin dashboard shows the same
    board. Strings localized in all 7 locales (incl. ar).

---

## Priority matrix

| Priority | Item | Why |
|---|---|---|
| 1 | A3 Delta sync | Clear differentiator; nobody in the LocalSend class does it well |
| 2 | C6 Pull mode | Biggest missing product interaction |
| 3 | A1 Fast lanes | Extends the speed story onto real mobile topologies |
| 4 | C9 Arabic + RTL | Highest value-per-effort for the target market; hardens i18n |
| 5 | F18 Chaos harness | Protects every other feature |

Dependencies: A2's driver interface ← WebTransport (future) · A1 lanes ←
A5 weather advice (auto-suggest) · A3 delta ← vault chunk store (exists) ·
C6 pull mode ← B4 scoped grants.

## Housekeeping (this release)

- `.gitignore` now excludes sandbox-local paths: `upload/`, `.zscripts/`,
  `agent-ctx/`, `examples/`, `download/` — and they are untracked from git
  (files remain on disk for local dev).
- `blake3` dependency attempt: registry can't resolve `blake3-wasm@2.1.7` —
  A4 pivoted to parallel SHA-256 (documented above).
