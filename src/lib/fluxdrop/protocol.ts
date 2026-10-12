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
  MAX_FILE_SIZE: 10 * 1024 * 1024 * 1024,      // 10 GB
  MAX_FILES_PER_TRANSFER: 100,
  MAX_FILE_NAME_LENGTH: 255,
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
  // server -> client
  ROOM_CREATED: 'room-created',
  ROOM_JOINED: 'room-joined',
  ROOM_EXPIRED: 'room-expired',
  ROOM_CLOSED: 'room-closed',
  DEVICE_DISCOVERED: 'device-discovered',
  DEVICE_LEFT: 'device-left',
  SIGNALING_ERROR: 'signaling-error',
} as const

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
