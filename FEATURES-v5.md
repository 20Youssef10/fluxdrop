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
| D–F | Everything below section C | ⬜ |

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

# D. Platform & Distribution — ⬜

12. **Ship the shells** — Capacitor/Tauri are scaffolds. Minimum lovable
    desktop: tray, autostart, native share-sheet, `fluxdrop://` scheme, file
    associations. Android: foreground transfer service. (Large.)
13. **Background transfer resilience** (native shells) — keep the pipeline
    alive when the screen locks. (Medium, in shell.)

# E. Ecosystem & Infrastructure — ⬜

14. **Webhooks / event bus on signaling** — `transfer.complete` hooks
    (Home Assistant/scripts); admin dashboard as automation hub. (Small.)
15. **Serverless signaling adapter** — Durable Objects/Workers template for
    zero-cost self-hosting next to the Bun server. (Medium.)
16. **Publish `@fluxdrop/sdk` to npm + docs site** — widget as a web
    component; conformance badge. (Medium.)
17. **Federated signaling** — server-to-server room peering with shared
    secrets. Strategic moonshot. (XL.)

# F. Quality & Fun — ⬜

18. **Chaos harness in CI** — headless Chrome + network impairment profiles
    driving the conformance suite; would have caught the perf-resume-1 bug
    class pre-release. (Medium — protects everything else.)
19. **Speedrun ghosts + leaderboards** — opt-in global times/ghost replays. (Small.)

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
