# FluxDrop — Architecture Documentation

## Table of Contents
1. [System Overview](#system-overview)
2. [Module Boundaries](#module-boundaries)
3. [Protocol Design](#protocol-design)
4. [Transfer State Machine](#transfer-state-machine)
5. [Chunked Transfer Design](#chunked-transfer-design)
6. [Device Discovery & Pairing](#device-discovery--pairing)
7. [Security Design](#security-design)
8. [Resume & Persistence](#resume--persistence)

---

## System Overview

FluxDrop is a peer-to-peer, browser-based file transfer application that sends files directly between nearby devices using WebRTC DataChannels. A lightweight signaling server coordinates session setup (offer/answer exchange, ICE candidates) but never touches file data.

```
┌─────────────┐    Signaling (Socket.IO)    ┌──────────────┐
│   Sender    │◄──────────────────────────►│  Signaling    │
│   Browser   │                             │  Server       │
│             │    WebRTC DataChannel       │  (Node.js)    │
│  ┌────────┐ │◄──────────────────────────►│              │
│  │Chunk   │ │     (P2P file data)        │  No file      │
│  │Engine  │ │                             │  storage      │
│  └────────┘ │                             └──────────────┘
│             │                             ┌──────────────┐
│             │◄──────────────────────────►│  Receiver     │
│             │    WebRTC DataChannel       │  Browser      │
└─────────────┘                             └──────────────┘
```

**Core guarantee**: File bytes flow peer-to-peer. The signaling server is ephemeral and stateless after session establishment.

---

## Module Boundaries

| Module | Responsibility | Never Does |
|--------|---------------|------------|
| `services/webrtc.ts` | DataChannel lifecycle, buffered amount monitoring, connection state | File I/O, UI state |
| `services/signaling.ts` | Socket.IO connect/disconnect, room join/leave, offer/answer relay | Store file data, persist sessions |
| `services/transfer.ts` | State machine, chunk scheduling, ACK tracking, resume coordination | Direct WebRTC or socket access |
| `services/checksum.ts` | SHA-256 streaming hash via Web Crypto API | UI updates, file storage |
| `services/resume.ts` | IndexedDB read/write of transfer manifests | Network operations, UI |
| `services/file-io.ts` | File System Access API orchestration + download fallback | Transfer logic |
| `server/socket.ts` | Room creation, ICE relay, pairing coordination | File inspection, storage |
| `server/rooms.ts` | Room lifecycle, TTL enforcement, max occupancy | Network relay |

---

## Protocol Design

### Binary Wire Protocol (DataChannel)

All file data flows through a single ordered DataChannel. Messages use a compact binary envelope:

```
┌──────────┬────────────┬──────────────┬──────────────┐
│ Type (1B)│ TransferID │ ChunkIndex   │ Payload      │
│          │ (4B UUID)  │ (4B uint32)  │ (variable)   │
└──────────┴────────────┴──────────────┴──────────────┘
```

**Message Types (1 byte)**:

| Byte | Type | Direction | Payload |
|------|------|-----------|---------|
| 0x01 | CHUNK_DATA | Sender→Receiver | Raw file bytes |
| 0x02 | CHUNK_ACK | Receiver→Sender | `{ chunkIndex: u32, ok: boolean }` |
| 0x03 | MANIFEST | Sender→Receiver | JSON-encoded manifest |
| 0x04 | MANIFEST_ACK | Receiver→Sender | `{ accepted: boolean }` |
| 0x05 | TRANSFER_COMPLETE | Sender→Receiver | `{ finalChecksum: string }` |
| 0x06 | TRANSFER_COMPLETE_ACK | Receiver→Sender | `{ verified: boolean }` |
| 0x07 | TRANSFER_CANCEL | Either | `{ reason: string }` |
| 0x08 | RESUME_REQUEST | Receiver→Sender | `{ lastChunkIndex: u32 }` |
| 0x09 | RESUME_RESPONSE | Sender→Receiver | `{ acknowledged: boolean }` |

**Why binary over JSON**: Reduces overhead per chunk. For a 1 MB chunk, 9 bytes of envelope is negligible (0.0009%). JSON would add 33%+ overhead from Base64 encoding alone.

---

## Transfer State Machine

```
                          ┌──────────────┐
                          │   IDLE       │
                          └──────┬───────┘
                                 │ file selected
                                 ▼
                          ┌──────────────┐
                          │  VALIDATING  │─── invalid ──► ERROR
                          └──────┬───────┘
                                 │ valid
                                 ▼
                          ┌──────────────┐
                          │  PAIRING     │─── timeout ──► CANCELLED
                          └──────┬───────┘
                                 │ paired & confirmed
                                 ▼
                          ┌──────────────┐
                          │ CONNECTING   │─── failure ──► RETRYING ──► CONNECTING
                          └──────┬───────┘                            │
                                 │ connected                          │ max retries
                                 ▼                                    ▼
                          ┌──────────────┐                      ┌──────────────┐
                          │ MANIFEST     │                      │   FAILED     │
                          │ EXCHANGE     │─── rejected ────────►│              │
                          └──────┬───────┘                      └──────────────┘
                                 │ accepted
                                 ▼
                          ┌──────────────┐
                          │  TRANSFERRING│─── interrupted ──► RESUMING
                          └──────┬───────┘                        │
                                 │ all chunks ACK'd               │ reconnected
                                 ▼                                ▼
                          ┌──────────────┐                 back to TRANSFERRING
                          │ VERIFYING    │
                          └──────┬───────┘
                                 │ checksum match
                                 ▼
                          ┌──────────────┐
                          │  COMPLETE    │
                          └──────────────┘
```

---

## Chunked Transfer Design

### Chunk Format
- **Chunk size**: 1 MB (1,048,576 bytes) — configurable, last chunk may be smaller
- **Transfer ID**: UUID v4, persists across resume

### Backpressure Strategy
- `MAX_BUFFERED_BYTES`: 16 MB hard limit
- `TARGET_BUFFERED_BYTES`: 4 MB soft threshold
- Sender checks `canSend()` before each chunk
- `waitForDrain()` listens for `bufferedamountlow` event with 2s safety timeout

### Receiver Buffer Management
- Chunks stored in IndexedDB (key: `transferId:chunkIndex`)
- ACK sent after each chunk is persisted
- Last chunk triggers assembly + checksum verification

---

## Device Discovery & Pairing

### Methods (Priority Order)
1. **QR Code** — primary, works across networks
2. **Manual Code** — 6-char room ID + 6-digit PIN
3. **Room List** — secondary
4. **Shareable Link** — `/#join=ROOM&pin=PIN` deep-link

### Room Lifecycle
- Created when sender initiates
- Expires after 5 minutes (pre-pairing)
- Max 2 devices per room
- PIN validated before pairing completes

---

## Security Design

| Threat | Mitigation |
|--------|------------|
| MITM on signaling | TLS on Socket.IO |
| Eavesdropping on file data | WebRTC DTLS (mandatory) |
| Unauthorized transfer | 6-digit PIN + explicit pairing |
| Session hijacking | Ephemeral room IDs, short TTLs |
| Resource exhaustion | Max 10 GB, 100 files, backpressure |
| File System Access abuse | User must explicitly grant access |
| XSS | CSP headers, no innerHTML, sanitization |

---

## Resume & Persistence

### IndexedDB Schema (database: `fluxdrop`)

#### Object Store: `transfers`
```typescript
interface TransferRecord {
  transferId: string
  manifest: TransferManifest
  status: TransferStatus
  chunksAcked: number[]
  bytesTransferred: number
  createdAt: number
  updatedAt: number
  expiresAt: number  // Auto-cleanup after 24h
}
```

#### Object Store: `chunks`
```typescript
interface ChunkRecord {
  key: string  // "{transferId}:{chunkIndex}"
  data: ArrayBuffer
  receivedAt: number
}
```

### Write Debouncing
- In-memory `Set` cache for O(1) deduplication
- IndexedDB writes debounced (flush every 2s or 50 chunks)
- `flushAllPendingAcks()` on page unload and cleanup
