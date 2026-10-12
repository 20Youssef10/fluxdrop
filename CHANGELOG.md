# Changelog

All notable changes to FluxDrop will be documented in this file.

## [1.0.0] - 2025-07-30

### Added
- **Core**: Peer-to-peer file transfer via WebRTC DataChannels
- **Core**: End-to-end DTLS encryption (mandated by WebRTC)
- **Core**: SHA-256 checksum verification on arrival
- **Core**: 1 MB chunked transfer with backpressure-aware flow control
- **Core**: Resume support (IndexedDB persistence, resume from last chunk)
- **Core**: Binary wire protocol (9-byte header, big-endian)
- **Transfer**: Drag & drop file upload (full-page drop zone)
- **Transfer**: Folder uploads with structure preservation
- **Transfer**: Image thumbnail previews
- **Transfer**: Up to 10 GB per transfer, 100 files
- **UX**: QR code pairing with room ID + 6-digit PIN
- **UX**: Shareable deep-links (`#join=ROOM&pin=PIN`)
- **UX**: Keyboard shortcuts (S, R, Esc, ⌘K, ⌘J)
- **UX**: Dark/light theme (system-aware)
- **UX**: First-visit onboarding tour (5 steps)
- **UX**: Rotating tips banner (8 tips)
- **UX**: PWA support (manifest + service worker)
- **Diagnostics**: Connection quality indicator (excellent/good/fair/poor)
- **Diagnostics**: ICE candidate pair display (local/remote IPs, types)
- **Diagnostics**: Direct LAN detection badge
- **Diagnostics**: Live speed sparkline with average + peak markers
- **Diagnostics**: Chunk map visualizer
- **Diagnostics**: Bytes sent/received stats
- **History**: Transfer history (IndexedDB-backed)
- **History**: Filter tabs (all/sent/received/complete/incomplete)
- **History**: Search by filename, peer alias, transfer ID
- **History**: Batch select + bulk delete
- **History**: Export as JSON
- **History**: Transfer detail dialog with full manifest
- **History**: Stats dashboard (total transfers, data, avg speed)
- **Settings**: Device alias customization
- **Settings**: Custom TURN/STUN server configuration
- **Settings**: Privacy info tab
- **Help**: 9 FAQ items in accordion
- **Notifications**: Browser notification permission prompt
- **Notifications**: Background tab notification on transfer complete
- **Signaling**: Socket.IO signaling server (port 3003)
- **Signaling**: Room lifecycle with TTL (5 min pre-pairing, 30 min idle)
- **Signaling**: PIN authentication
- **Signaling**: Max 2 devices per room
- **Signaling**: ICE candidate queuing for out-of-order candidates
- **Engineering**: Connection retry with exponential backoff (3 retries)
- **Engineering**: Transfer complete celebration animation (confetti)
- **Engineering**: Connection ripple animation on WebRTC connect
- **Engineering**: Animated device-to-device connection visualization
- **Engineering**: ARIA live region for screen reader announcements
- **Engineering**: IndexedDB resilience (degrades to in-memory mode)
- **Engineering**: Smart WebRTC error filtering (benign errors logged, not toasted)
- **Engineering**: Hashing progress UI with yield-to-event-loop
- **Engineering**: Gradient hover borders on cards
- **Engineering**: Glassmorphism design system
- **Engineering**: Custom scrollbar styling
