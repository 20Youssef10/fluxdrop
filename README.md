# 🔷 FluxDrop

> Peer-to-peer file transfer that flows directly between your devices. No cloud, no servers holding your data — just a direct, encrypted WebRTC tunnel.

![FluxDrop](https://img.shields.io/badge/FluxDrop-P2P%20File%20Transfer-0d6e6e?style=for-the-badge&logo=webRTC)
![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript)
![WebRTC](https://img.shields.io/badge/WebRTC-DataChannel-333?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

---

## ✨ Features

### Core
- **Peer-to-peer transfer** — files flow directly between devices over WebRTC DataChannels
- **End-to-end encrypted** — DTLS encryption mandated by WebRTC; not even the signaling server can read your files
- **Zero server storage** — the signaling server only relays connection setup metadata, never file data
- **SHA-256 verified** — every file is checksummed on arrival; corrupted/tampered bytes are rejected
- **Resume support** — interrupted transfers resume from the last verified chunk (IndexedDB persistence)

### Transfer
- **Drag & drop anywhere** — drop files anywhere on the sender page
- **Folder uploads** — send entire directories with structure preserved (`webkitdirectory`)
- **Image thumbnails** — preview images in the file picker and transfer progress
- **1 MB chunking** — reliable transfer with backpressure-aware flow control
- **Up to 10 GB** per transfer, up to 100 files
- **Multi-file** — send multiple files in a single transfer session

### UX
- **QR code pairing** — scan to receive, no manual typing needed
- **Shareable deep-links** — `/#join=ROOM&pin=PIN` auto-joins the room
- **Keyboard shortcuts** — `S` send, `R` receive, `Esc` back, `⌘K` diagnostics, `⌘J` theme
- **Dark/light theme** — system-aware with manual toggle
- **Onboarding tour** — first-visit coach marks
- **Tips banner** — rotating usage tips on the landing page
- **PWA support** — installable app with offline landing page

### Diagnostics
- **Connection quality indicator** — excellent/good/fair/poor based on RTT
- **ICE candidate pair** — see local/remote IPs, candidate types (host/srflx/relay)
- **Direct LAN detection** — green badge when both devices are on the same network
- **Live speed sparkline** — speed history graph with average + peak markers
- **Chunk map visualizer** — grid showing which chunks have been ACK'd
- **Bytes sent/received** — real-time transport stats

### History
- **Transfer history** — all transfers stored locally in IndexedDB
- **Filter tabs** — all / sent / received / complete / incomplete
- **Search** — search by filename, peer alias, or transfer ID
- **Batch delete** — select multiple records for bulk removal
- **Export** — download history as JSON
- **Transfer details** — click any record for full manifest + checksums
- **Stats dashboard** — total transfers, files sent/received, data transferred

### Settings
- **Device alias** — customizable name shown to peers
- **Custom TURN/STUN servers** — for restrictive networks (corporate firewalls)
- **Privacy info** — what the server sees vs. what stays on your device
- **Help/FAQ** — 9 common questions answered

---

## 🏗️ Architecture

```
┌─────────────┐    Signaling (Socket.IO)    ┌──────────────┐
│   Sender    │◄──────────────────────────►│  Signaling    │
│   Browser   │                             │  Server       │
│             │    WebRTC DataChannel       │  (port 3003)  │
│  ┌────────┐ │◄──────────────────────────►│              │
│  │Chunk   │ │     (P2P file data)        │  No file      │
│  │Engine  │ │                             │  storage      │
│  └────────┘ │                             └──────────────┘
│             │                             ┌──────────────┐
│             │◄──────────────────────────►│  Receiver    │
│             │    WebRTC DataChannel       │  Browser      │
└─────────────┘                             └──────────────┘
```

**Core guarantee**: File bytes flow peer-to-peer. The signaling server is ephemeral and stateless after session establishment.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| State | Zustand |
| Signaling | Socket.IO (mini-service on port 3003) |
| Persistence | IndexedDB (via idb-keyval) |
| Checksums | Web Crypto API (SHA-256) |
| QR Codes | qrcode.react |
| Animations | Framer Motion |
| PWA | Web App Manifest + Service Worker |

### Binary Wire Protocol

```
┌──────────┬────────────┬──────────────┬──────────────┐
│ Type (1B)│ TransferID │ ChunkIndex   │ Payload      │
│          │ (4B UUID)  │ (4B uint32)  │ (variable)   │
└──────────┴────────────┴──────────────┴──────────────┘
```

- **9-byte header** — minimal overhead
- **64 KB chunks** — WebRTC spec default max-message-size, safe for all browsers
- **Negotiated chunk size** — after DataChannel opens, reads `pc.sctp.maxMessageSize` and uses the largest safe chunk (up to 256 KB)
- **Big-endian** — fixed-offset O(1) parsing
- **Native ArrayBuffer** — no encoding overhead on the hot path

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ or [Bun](https://bun.sh/) 1.0+
- A modern browser (Chrome 90+, Firefox 90+, Safari 15+, Edge 90+)

### Installation

```bash
# Clone the repository
git clone https://github.com/20Youssef10/fluxdrop.git
cd fluxdrop

# Install dependencies
bun install

# Install signaling server dependencies
cd mini-services/signaling && bun install && cd ../..
```

### Running

FluxDrop requires two services:

1. **Signaling server** (port 3003) — coordinates connection setup
2. **Next.js app** (port 3000) — the web UI

```bash
# Terminal 1: Start the signaling server
cd mini-services/signaling
bun run dev

# Terminal 2: Start the Next.js app
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

> **Note**: In production, a reverse proxy (like Caddy) routes `?XTransformPort=3003` queries to the signaling server. See `Caddyfile` for the configuration.

---

## 📖 How It Works

### Sender Flow
1. **Select files** — drag & drop or browse
2. **SHA-256 hashing** — each file is hashed for integrity verification
3. **Room creation** — signaling server creates a room with a 6-digit PIN
4. **Share** — show the QR code or share the link with the receiver
5. **Pairing** — receiver joins, WebRTC DataChannel opens
6. **Transfer** — files are chunked (1 MB) and streamed with backpressure
7. **Verification** — receiver verifies SHA-256 checksums on arrival

### Receiver Flow
1. **Enter room ID + PIN** — or scan the QR code, or open a shareable link
2. **Join room** — signaling server validates the PIN
3. **WebRTC negotiation** — offer/answer/ICE exchange via signaling
4. **DataChannel opens** — direct P2P tunnel established
5. **Receive chunks** — 1 MB chunks assembled in memory + IndexedDB
6. **Verify & save** — SHA-256 checksums verified, File System Access API or download fallback

### Connection Types

| Type | Description | Internet Data? |
|------|-------------|----------------|
| `host` → `host` | Direct LAN connection | No (few KB for signaling only) |
| `host` → `srflx` | Via STUN (NAT traversal) | No (few KB for STUN + signaling) |
| `relay` → `relay` | Via TURN server | Yes (relayed through server) |

FluxDrop shows a green **"Direct LAN"** badge in the Diagnostics panel (⌘K) when both devices are on the same network.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `S` | Start send flow |
| `R` | Start receive flow |
| `Esc` | Back to home / close dialog |
| `⌘K` / `Ctrl+K` | Toggle diagnostics panel |
| `⌘J` / `Ctrl+J` | Toggle dark/light theme |

---

## 📁 Project Structure

```
fluxdrop/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── layout.tsx          # Root layout (ThemeProvider, metadata)
│   │   ├── page.tsx            # Main page (landing/sender/receiver views)
│   │   └── globals.css         # FluxDrop design system
│   ├── components/fluxdrop/    # UI components (20+ files)
│   │   ├── flux-hero.tsx       # Landing hero with particles
│   │   ├── file-picker.tsx     # Drag-drop file picker
│   │   ├── qr-display.tsx      # QR code + room ID + PIN
│   │   ├── transfer-progress.tsx # Live progress + sparkline + chunk map
│   │   ├── diagnostics-panel.tsx # ICE/RTT/quality diagnostics
│   │   └── ...
│   ├── hooks/fluxdrop/         # React hooks
│   │   ├── use-fluxdrop.ts     # Master orchestration hook
│   │   ├── use-keyboard-shortcuts.ts
│   │   └── use-notifications.ts
│   ├── lib/fluxdrop/           # Core logic (framework-agnostic)
│   │   ├── protocol.ts         # Types, constants, message types
│   │   ├── encoding.ts         # Binary wire protocol
│   │   ├── webrtc.ts           # RTCPeerConnection lifecycle
│   │   ├── signaling.ts       # Socket.IO client wrapper
│   │   ├── manifest.ts        # Manifest builder + slice plan
│   │   ├── checksum.ts        # SHA-256 hashing
│   │   ├── resume.ts          # IndexedDB persistence
│   │   └── format.ts          # Formatting + validation utils
│   └── stores/                # Zustand stores
│       ├── session-store.ts   # Device identity, room, peers
│       └── transfer-store.ts  # Transfer state, progress, speed
├── mini-services/signaling/   # Socket.IO signaling server
│   └── src/index.ts           # Room lifecycle, ICE relay, PIN auth
├── public/                    # Static assets
│   ├── manifest.json           # PWA manifest
│   ├── sw.js                  # Service worker
│   └── logo.svg               # FluxDrop logo
├── prisma/                    # (Not used — no database)
├── Caddyfile                  # Reverse proxy config
└── package.json
```

---

## 🔒 Security

| Threat | Mitigation |
|--------|-----------|
| Man-in-the-middle on signaling | TLS on Socket.IO connections |
| Eavesdropping on file data | WebRTC DTLS (mandatory encryption) |
| Unauthorized transfer | 6-digit PIN + explicit pairing confirmation |
| Session hijacking | Ephemeral room IDs, 5-min TTL, single-use |
| Resource exhaustion | Max 10 GB, 100 files, backpressure flow control |
| File System Access abuse | User must explicitly grant directory access |
| XSS | CSP headers, no innerHTML, input sanitization |

### What the signaling server sees
- Your device alias
- Room ID and PIN
- WebRTC connection metadata (SDP, ICE candidates)
- File manifest (file names, sizes, types, checksums) — relayed via signaling for initial setup
- Device alias

### What stays on your device
- File contents (never relayed through signaling)
- Transfer history (IndexedDB)
- Device preferences

### What is never stored
- File data on any server — bytes flow directly peer-to-peer via WebRTC DataChannel

### Limitations
- Files > 256 MB use a Merkle-like hash construction (not standard SHA-256 of the file). Corruption is still detected, but `sha256sum` won't match for large files.
- E2E encryption depends on an honest signaling server. A malicious server could MITM the DTLS handshake. For maximum security, verify a short code shown on both devices.
- `crypto.randomUUID` and `crypto.subtle` are hidden by browsers on plain-HTTP LAN origins, so FluxDrop falls back to `crypto.getRandomValues` for IDs and `hash-wasm` for SHA-256 there — transfers work end-to-end without HTTPS. PWA install/service-worker caching still needs HTTPS or localhost (e.g., mkcert).

---

## 📜 License

MIT License — see [LICENSE](LICENSE).

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 🙏 Acknowledgments

- [WebRTC](https://webrtc.org/) — the technology that makes P2P possible
- [Socket.IO](https://socket.io/) — reliable signaling
- [Next.js](https://nextjs.org/) — the React framework
- [shadcn/ui](https://ui.shadcn.com/) — beautiful components
- [Framer Motion](https://www.framer.dev/motion/) — animations

---

<p align="center">
  <strong>FluxDrop</strong> — Files that flow directly between your devices.
</p>

---

## 🐳 Self-Hosting (Docker)

The repo ships a one-command self-host kit: web app, signaling server, TURN relay, and reverse proxy, wired together with Docker Compose.

### Quickstart (3 steps)

```bash
# 1. Copy the example env file next to docker-compose.yml
cp .env.docker.example .env

# 2. Edit .env — set TURN_SECRET (`openssl rand -hex 32`) and replace
#    YOUR_SERVER_IP in TURN_URL / TURN_URL_TCP with your server's public IPv4

# 3. Build & launch the whole stack
docker compose up -d --build
```

That's it — open `http://<your-server-ip>` (via Caddy) or `http://<your-server-ip>:3000` (direct) and start dropping files. The SQLite database persists across rebuilds in the `app-db` volume.

> **Tip**: already running the dev setup with a local `.env`? Just append the TURN_* variables from `.env.docker.example` to it instead of overwriting.

### What's in the stack

| Service | Source | Role |
|---------|--------|------|
| `app` | `Dockerfile` (multi-stage: Bun build → Node 22 runtime) | Next.js UI on port 3000; SQLite persisted in the `app-db` volume |
| `signaling` | `mini-services/signaling/Dockerfile` | Socket.IO room/pairing/ICE relay on :3003 — internal only; browsers reach it through Caddy via `?XTransformPort=3003` |
| `coturn` | `coturn/coturn` image | TURN/STUN relay for restrictive NATs — 3478 (UDP+TCP), 5349 (TLS), relay range 49160–49200/UDP |
| `caddy` | `caddy:2` image | Reverse proxy on :80/:443 — routes `/` → `app:3000`, `?XTransformPort=3003` → `signaling:3003` (see `deploy/Caddyfile.docker`) |

### TURN notes

- `TURN_SECRET` is shared between coturn (`--static-auth-secret`) and the signaling server, which mints time-limited browser credentials from `TURN_URL` / `TURN_URL_TCP` / `TURN_SECRET` / `TURN_REALM`.
- ☁️ **Cloud deploys**: if the host sits behind 1:1 NAT (most VMs), coturn must advertise its public IP or relay candidates will be unreachable. Uncomment the `--external-ip=${TURN_EXTERNAL_IP}` line in the `coturn` service of `docker-compose.yml` and set `TURN_EXTERNAL_IP=<public-ipv4>` in `.env`.
- 🏠 **Direct-internet hosts**: leave `TURN_EXTERNAL_IP` empty — nothing else to configure.
- 🔒 For automatic HTTPS, replace the `:80` site address in `deploy/Caddyfile.docker` with your domain and keep ports 80/443 published.

### Bare metal (no Docker)

Prefer running services directly? See the [Running](#running) section above — signaling on :3003, Next.js on :3000, with the repo-root `Caddyfile` as the gateway.
