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
} as const

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType]

// Header layout: [type:1B][transferId:4B][chunkIndex:4B] = 9 bytes
export const HEADER_SIZE = 9
export const TRANSFER_ID_BYTES = 4

// === Tunables ===
export const CONSTANTS = {
  // Chunk size: 256 KB + 9-byte header = 262,153 bytes.
  // We negotiate a=max-message-size:1048576 (1 MB) via SDP munging in
  // webrtc.ts, so 256 KB chunks are well within the 1 MB limit.
  // For a 1.5 GB file: 6,144 chunks — good throughput with manageable overhead.
  CHUNK_SIZE: 256 * 1024,                       // 256 KB (with SDP-negotiated 1 MB max)
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
