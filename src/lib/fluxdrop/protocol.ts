// FluxDrop shared protocol types & constants.
// Used by both the Next.js client and (mirrored by) the signaling server.

// === Roles ===
export type DeviceRole = 'sender' | 'receiver'

export interface Device {
  id: string
  alias: string
  role: DeviceRole
}

// === Transfer manifest ===
export interface FileManifestEntry {
  name: string
  size: number
  type: string
  lastModified: number
  checksum: string
  relativePath: string
}

export interface TransferManifest {
  transferId: string
  version: 1
  files: FileManifestEntry[]
  totalSize: number
  totalChunks: number
  chunkSize: number
  createdAt: number
  expiresAt: number
  /**
   * Wire compression for chunk payloads (v1.1). When 'gzip', every chunk is
   * gzipped independently BEFORE framing (opcode CHUNK_DATA_GZ) and the
   * checksums stay over the ORIGINAL bytes — the receiver decompresses each
   * chunk before storing it, so resume bitmaps and byte offsets are unchanged.
   * Optional/additive: older peers that don't know the field treat frames of
   * an unknown type as a protocol error and fail the transfer gracefully.
   */
  compression?: 'gzip'
}

// === Transfer state machine ===
export type TransferState =
  | 'IDLE'
  | 'VALIDATING'
  | 'PAIRING'
  | 'CONNECTING'
  | 'RETRYING'
  | 'MANIFEST_EXCHANGE'
  | 'TRANSFERRING'
  | 'PAUSED'
  | 'RESUMING'
  | 'VERIFYING'
  | 'COMPLETE'
  | 'CANCELLED'
  | 'FAILED'
  | 'ERROR'

// === DataChannel wire protocol (binary) ===
export const MessageType = {
  CHUNK_DATA: 0x01,
  CHUNK_ACK: 0x02,
  MANIFEST: 0x03,
  MANIFEST_ACK: 0x04,
  TRANSFER_COMPLETE: 0x05,
  TRANSFER_COMPLETE_ACK: 0x06,
  TRANSFER_CANCEL: 0x07,
  RESUME_REQUEST: 0x08,
  RESUME_RESPONSE: 0x09,
  PAUSE: 0x0a,
  RESUME_STREAM: 0x0b,
  // Sender → receiver: "how much of this transferId do you already have?"
  // Lets a resumed send skip chunks the receiver already stored.
  RESUME_QUERY: 0x0c,
  // v1.1: gzip-compressed chunk payload. Wire format identical to CHUNK_DATA,
  // but the payload must be gunzipped before storing. Receiver stores the
  // DECOMPRESSED bytes — everything downstream (bitmap, offsets, checksums)
  // operates on original bytes only.
  CHUNK_DATA_GZ: 0x0d,
  // v1.2: E2E-encrypted payload (AES-256-GCM under the SPAKE2 session key).
  // Payload layout: nonce(12B) || ciphertext(16B GCM tag incl.). For CHUNK_ENC
  // the plaintext is the chunk bytes AFTER optional gzip (compress-then-
  // encrypt); the receiver decrypts, then gunzips iff manifest.compression
  // says so. For MANIFEST_ENC the plaintext is the manifest JSON.
  CHUNK_ENC: 0x0e,
  MANIFEST_ENC: 0x0f,
  // v1.2: consent-dialog rich previews (request/response over the DataChannel,
  // encrypted when the E2E session is active).
  PREVIEW_REQ: 0x10,
  PREVIEW_DATA: 0x11,
  // v1.3 (6.3): in-room chat over the DataChannel. Payload is a JSON body
  // { id, text, at } — encrypted with the PAKE session key while E2E is
  // active (AAD 'chat'), plaintext otherwise. Control-style frame.
  CHAT: 0x12,
} as const

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType]

// Header layout: [type:1B][transferId:4B][chunkIndex:4B] = 9 bytes
export const HEADER_SIZE = 9
export const TRANSFER_ID_BYTES = 4

// === Tunables ===
export const CONSTANTS = {
  // Chunk size: 64 KB + 9-byte header = 65,545 bytes.
  // This is the WebRTC spec DEFAULT max-message-size — guaranteed to work
  // on every browser without any SDP munging.
  // We tried 256 KB with SDP munging (a=max-message-size:1MB) but some
  // browsers/networks still reject it with "Failure to send data".
  // 64 KB is the sweet spot: large enough for good throughput, small
  // enough to work everywhere without negotiation.
  // For a 1.5 GB file: 24,576 chunks (vs 98,304 at 16 KB) — 4x fewer.
  // Throughput is maintained via aggressive buffering (32 MB target).
  CHUNK_SIZE: 64 * 1024,                        // 64 KB (WebRTC spec default max)
  MAX_BUFFERED_BYTES: 32 * 1024 * 1024,        // 32 MB backpressure threshold
  TARGET_BUFFERED_BYTES: 8 * 1024 * 1024,      // 8 MB target (higher = more throughput)
  // v1.1 adaptive flow window (AIMD) — dynamic in-flight budget on the SEND
  // path. Chunk SIZE stays fixed per manifest (resume offsets depend on it);
  // the WINDOW adapts to the transport instead.
  FLOW_WINDOW_MIN: 256 * 1024,                 // 256 KB floor (lossy/relayed)
  FLOW_WINDOW_DEFAULT: 8 * 1024 * 1024,        // neutral start (parity with old constant)
  FLOW_WINDOW_LAN: 16 * 1024 * 1024,           // host↔host pairs get a fat window
  FLOW_WINDOW_RELAYED: 4 * 1024 * 1024,        // TURN/srflx paths stay conservative
  FLOW_WINDOW_GROW_FACTOR: 1.25,               // window growth per 64 clean sends
  FLOW_WINDOW_SHRINK_FACTOR: 0.5,              // halve on send-queue pressure
  FLOW_WINDOW_CLEAN_STREAK: 64,                // clean sends between growth steps
  GZIP_MIN_TRANSFER_BYTES: 4 * 1024,           // don't bother below 4 KB
  MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024,      // 10 GB
  MAX_FILES_PER_TRANSFER: 100,
  MAX_FILE_NAME_LENGTH: 255,
  // v1.3 (6.1): group rooms — the signaling server accepts up to this many
  // devices per room (1 sender + N-1 receivers). The server caps it via the
  // MAX_DEVICES_PER_ROOM env (this constant mirrors the default for UI copy).
  MAX_DEVICES_PER_ROOM: 8,
  // v1.3 (6.1): per-chunk read cache shared across fan-out peers (wave
  // scheduler). Chunks up to 256 KB — the cap bounds it to ~16 MB.
  FANOUT_READ_CACHE: 64,
  PAIRING_TIMEOUT_MS: 60_000,
  CONNECT_RETRY_MAX: 3,
  CONNECT_RETRY_BASE_MS: 1_000,
  ROOM_TTL_MS: 5 * 60 * 1000,
  ROOM_IDLE_TTL_MS: 30 * 60 * 1000,
  RESUME_RECORD_TTL_MS: 24 * 60 * 60 * 1000,
  BLOCKED_EXTENSIONS: ['.exe', '.bat', '.cmd', '.com', '.scr', '.vbs', '.js', '.jar', '.msi', '.dll', '.sh'],
} as const

// === Signaling events (Socket.IO) ===
export const SIGNALING_EVENTS = {
  // client -> server
  CREATE_ROOM: 'create-room',
  JOIN_ROOM: 'join-room',
  PAIRING_REQUEST: 'pairing-request',
  PAIRING_CONFIRM: 'pairing-confirm',
  PAIRING_REJECT: 'pairing-reject',
  WEBRTC_OFFER: 'webrtc-offer',
  WEBRTC_ANSWER: 'webrtc-answer',
  WEBRTC_ICE: 'webrtc-ice',
  TRANSFER_MANIFEST: 'transfer-manifest',
  TRANSFER_ACCEPTED: 'transfer-accepted',
  TRANSFER_COMPLETE: 'transfer-complete',
  TRANSFER_CANCEL: 'transfer-cancel',
  RESUME_REQUEST: 'resume-request',
  RESUME_RESPONSE: 'resume-response',
  HEARTBEAT: 'heartbeat',
  LEAVE_ROOM: 'leave-room',
  // v1.2: opaque PAKE handshake relay (server forwards between room members
  // without looking inside — membership-checked like every other relay).
  E2E_RELAY: 'e2e-relay',
  // server -> client
  ROOM_CREATED: 'room-created',
  ROOM_JOINED: 'room-joined',
  ROOM_EXPIRED: 'room-expired',
  ROOM_CLOSED: 'room-closed',
  DEVICE_DISCOVERED: 'device-discovered',
  DEVICE_LEFT: 'device-left',
  SIGNALING_ERROR: 'signaling-error',
} as const

// === v1.1: per-connection transport hint ===
// Populated from the selected ICE candidate pair once the DataChannel opens;
// drives the initial adaptive flow window (see webrtc.ts AIMD).
export type TransportClass = 'lan' | 'relayed' | 'unknown'

export interface TransferSummary {
  fileCount: number
  totalSize: number
  totalName: string
  fileTypes: string[]
}

export interface TransferRecord {
  transferId: string
  role: DeviceRole
  manifest: TransferManifest
  status: TransferState
  chunksAcked: number
  bytesTransferred: number
  peerAlias: string
  startedAt: number
  finishedAt?: number
  checksumVerified?: boolean
}
