/**
 * Shared protocol constants between the FluxDrop client and signaling server.
 * This module is imported by both the Next.js client and the signaling server
 * to prevent constants from drifting.
 *
 * The signaling server should import from this file instead of hand-mirroring types.
 */

// === Message types (DataChannel wire protocol) ===
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

// === Tunables ===
export const CHUNK_SIZE = 64 * 1024                          // 64 KB
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024           // 32 MB
export const TARGET_BUFFERED_BYTES = 8 * 1024 * 1024         // 8 MB
export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024         // 10 GB
export const MAX_FILES_PER_TRANSFER = 100
export const MAX_FILE_NAME_LENGTH = 255
export const PAIRING_TIMEOUT_MS = 60_000
export const CONNECT_RETRY_MAX = 3
export const CONNECT_RETRY_BASE_MS = 1_000
export const ROOM_TTL_MS = 5 * 60 * 1000
export const ROOM_IDLE_TTL_MS = 30 * 60 * 1000
export const RESUME_RECORD_TTL_MS = 24 * 60 * 60 * 1000
export const BLOCKED_EXTENSIONS = ['.exe', '.bat', '.cmd', '.com', '.scr', '.vbs', '.js', '.jar', '.msi', '.dll', '.sh']

// === Signaling events ===
export const SIGNALING_EVENTS = {
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
  ROOM_CREATED: 'room-created',
  ROOM_JOINED: 'room-joined',
  ROOM_EXPIRED: 'room-expired',
  ROOM_CLOSED: 'room-closed',
  DEVICE_DISCOVERED: 'device-discovered',
  DEVICE_LEFT: 'device-left',
  SIGNALING_ERROR: 'signaling-error',
} as const

// === Wire protocol header ===
export const HEADER_SIZE = 9
export const TRANSFER_ID_BYTES = 4

// === Room config ===
export const ROOM_ID_LENGTH = 6
export const JOIN_CODE_LENGTH = 6
export const PIN_LENGTH = 6
export const MAX_DEVICES_PER_ROOM = 2
export const MAX_PIN_ATTEMPTS = 5
export const PIN_LOCKOUT_MS = 60 * 1000
