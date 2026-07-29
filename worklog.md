# FluxDrop — Work Log

## Project Overview
FluxDrop is a peer-to-peer, browser-based file transfer application using WebRTC DataChannels.
A lightweight Socket.IO signaling server coordinates session setup; file bytes flow directly peer-to-peer.

## Tech Stack
- Next.js 16 (App Router) + TypeScript 5
- Tailwind CSS 4 + shadcn/ui (New York)
- Socket.IO signaling server (mini-service on port 3003)
- Zustand for client state
- idb-keyval for IndexedDB resume persistence
- Web Crypto API for SHA-256 checksums
- qrcode.react for QR display
- Framer Motion for transitions

## Architecture Decisions
- Signaling server is a separate mini-service (`mini-services/signaling/`) on port 3003.
- Frontend connects via `io("/?XTransformPort=3003")` (Caddy gateway forwards).
- Only the `/` route is user-visible. All flows live in a single page with view state (landing/sender/receiver).
- Binary wire protocol: 9-byte header (1B type + 4B transferId + 4B chunkIndex) + payload.
- Color palette: emerald/teal/cyan accents (no indigo/blue per design rules).
- Dark mode default via next-themes.

---

Task ID: 1
Agent: main
Task: Build the complete FluxDrop application — signaling server, WebRTC transport, UI, and verification.

Work Log:
- Installed deps: socket.io-client, socket.io, qrcode.react, idb-keyval
- Built signaling server mini-service (`mini-services/signaling/`): room lifecycle, 6-digit PIN auth, pairing handshake, WebRTC offer/answer/ICE relay, transfer-manifest/accepted/complete/cancel relay, resume coordination, heartbeat, TTL expiry, max 2 devices per room.
- Built shared protocol layer (`src/lib/fluxdrop/protocol.ts`): types, constants, message types, signaling event names.
- Built binary encoding (`encoding.ts`): 9-byte header encode/decode, chunk data/ack, control messages with JSON bodies.
- Built manifest builder (`manifest.ts`): SHA-256 per-file hashing, slice plan for multi-file chunking, chunk→file resolution.
- Built checksum service (`checksum.ts`): streaming SHA-256 via Web Crypto (segment-based for large files).
- Built resume store (`resume.ts`): IndexedDB via idb-keyval for transfer records, chunk acks, chunk payloads, device prefs.
- Built file-io (`file-io.ts`): Blob assembly, File System Access API save with download fallback.
- Built WebRTC service (`webrtc.ts`): RTCPeerConnection lifecycle, DataChannel binding, backpressure-aware chunk sending (16MB threshold / 4MB target), binary message encode helpers.
- Built signaling client (`signaling.ts`): Socket.IO wrapper with all event callbacks.
- Built Zustand stores: `session-store.ts` (device identity, room, peers, RTC state) and `transfer-store.ts` (manifest, state machine, progress, speed tracking, per-file progress).
- Built master orchestration hook `use-fluxdrop.ts`: wires signaling↔WebRTC↔transfer with ref-based state reads to avoid stale closures. Sender flow (createRoom→pairing→offer→DC→manifest→stream→complete) and receiver flow (joinRoom→pairing→answer→DC→manifest→receive→verify→save).
- Built UI: theme provider, FluxHeader (logo, connection badge, theme toggle, settings dialog), FluxHero (animated mesh bg, gradient text, feature cards, how-it-works steps), FilePicker (drag-drop + file list + validation), QRDisplay (QRCodeSVG + room ID/PIN + countdown), JoinForm (InputOTP for PIN), DeviceList, ConnectionStatus (state pipeline viz), TransferProgress (progress bar, stats grid, chunk-map visualizer, per-file list), TransferHistory (IndexedDB-backed), FluxFooter (sticky), SenderPanel, ReceiverPanel.
- Built shared FileIcon + DeviceIcon components (avoided react-hooks/static-components lint errors).
- Rewrote globals.css with FluxDrop design system: emerald/teal palette, glassmorphism, gradient mesh bg, animated grid overlay, gradient text, shimmer/pulse/float/orb animations, custom scrollbar, chunk-cell flash.
- Updated layout.tsx: ThemeProvider (default dark), Sonner toaster, FluxDrop metadata.
- Wired main page.tsx: AnimatePresence view transitions (landing/sender/receiver), settings dialog.

Verification (agent-browser + VLM):
- Lint: clean (0 errors) after fixing icon-during-render, setState-in-effect, and JSX nesting issues.
- Dev server compiles in ~3s, HTTP 200, no runtime errors in dev.log.
- Signaling server starts cleanly on port 3003.
- Landing page renders: hero, feature cards, how-it-works, recent transfers — all correct.
- Send flow: clicking "Send files" → sender panel with FilePicker + "What happens next" steps. ✓
- Receive flow: clicking "Receive files" → join form with Room ID input + 6-slot PIN OTP + disabled Join button until valid. ✓
- Theme toggle: switches dark↔light. ✓
- Settings dialog: opens with alias editor + privacy note. ✓
- Join form fill: Room ID accepts input (verified "AB3K7Q" in snapshot). ✓
- VLM verdict on landing: "Good" — cohesive emerald/teal palette, clear hierarchy, polished dark mode, no layout issues.
- Sticky footer verified on sender panel: footer at bottom, no empty gap.
- Mobile (390px) verified: responsive, text wraps, no horizontal overflow, usable.

Stage Summary:
- FluxDrop is fully functional end-to-end for the UI/UX golden path.
- Signaling + WebRTC infrastructure is in place for real P2P transfers (requires two browser tabs/devices to fully exercise the data path, which agent-browser single-session cannot do).
- All 6 lint errors resolved; design quality confirmed by VLM.
- Known sandbox constraint: background processes are killed when a Bash tool call ends, so servers must be started within the same command as any verification.

Unresolved / Next-phase opportunities:
- Multi-tab end-to-end transfer test (sender↔receiver data path) — needs two browser sessions.
- Folder/directory upload support (webkitRelativePath already captured in manifest).
- TURN server config for restrictive networks (currently STUN-only).
- Resume UI: surface stored partial transfers and offer "resume" button.
- Transfer history is read-only; could add re-send / re-download actions.
- Connection retry with exponential backoff (state machine supports RETRYING but not yet wired).
