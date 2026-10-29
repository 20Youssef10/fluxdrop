// FluxDrop shared protocol types & constants.
// Used by both the Next.js client and (mirrored by) the signaling server.

// v5-a3w: delta scan blocks (pure constants — no runtime dependency the
// server mirror would need to know about).
import { DELTA_BLOCK_SIZE, type BlockHash } from './delta'

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
  /**
   * v5-a3w: delta-sync candidacy — set by the SENDER only when the deltaSync
   * pref is on, the transfer is exactly ONE file, and its size is at least
   * DELTA_MIN_FILE_BYTES. A hint that invites the receiver to fingerprint its
   * vault copy of the same name (DELTA_HASHES) so the sender can stream a
   * compact patch instead of the full bytes. The manifest's checksum/size
   * always describe the ORIGINAL file (the patch must reconstruct to it);
   * older receivers simply ignore the unknown field.
   */
  deltaCandidate?: boolean
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
  /**
   * v4 (1.7): streaming Merkle tree over per-chunk SHA-256 leaves. The
   * sender computes a leaf per 64 KB chunk during manifest hashing and
   * seals the root here; the receiver rebuilds the identical tree from the
   * bytes it actually stored and compares roots at completion. A mismatch
   * localizes corruption to a subtree (binary descent over the leaves) so
   * only the affected chunks get wiped for re-request instead of failing
   * the whole transfer. Optional: older receivers ignore the field.
   */
  merkle?: {
    root: string // hex SHA-256 of the root node
    leaves: number // leaf count == totalChunks
  }
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
  // v4 (4.6): opt-in clipboard sync between paired devices. Payload is a
  // JSON body { text, at } — sealed with the PAKE session key while E2E is
  // active (AAD 'clipboard'), plaintext otherwise. Only flows while BOTH
  // peers enabled clipboard sync; receivers surface a copy toast (direct
  // clipboard writes need a user gesture on most browsers).
  CLIPBOARD: 0x13,
} as const

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType]

// Header layout: [type:1B][transferId:4B][chunkIndex:4B] = 9 bytes
export const HEADER_SIZE = 9
export const TRANSFER_ID_BYTES = 4

// === v5-a1: fast lanes (additive multi-PC striping) ===
// Lanes only spin for transfers bigger than this (16 MB): below it the offer
// round-trips + extra ICE cost more than the striping gains.
export const FAST_LANE_MIN_BYTES = 16 * 1024 * 1024
// Hard cap on transports per peer (primary + 3 extra lanes).
export const FAST_LANE_MAX = 4

// === v5-a3w: delta sync (rsync-lite) — patch streaming for known files ===
// Sender→receiver PATCH streaming when the receiver already holds a similar
// older copy (vault). The NEGOTIATION rides the sealed signaling path (the
// opaque e2e-relay envelope carrying enc1.<hex> AES-GCM bodies — exactly the
// v5-a2 sealed-manifest family, ZERO server changes); the patch itself then
// streams over the normal per-peer-encrypted chunk transports. Any failure
// anywhere declines to a silent full send.

/** Absolute cap on a patch blob — the receiver accumulates it in RAM. */
export const DELTA_MAX_PATCH_BYTES = 256 * 1024 * 1024 // 256 MiB
/** Smallest file that may become a delta candidate (4 scan blocks). */
export const DELTA_MIN_FILE_BYTES = 4 * DELTA_BLOCK_SIZE // 4 × 256 KiB = 1 MiB
/** Largest sender-side source fully read into RAM for buildPatch. */
export const DELTA_SOURCE_MAX = 512 * 1024 * 1024 // 512 MiB
/**
 * Receiver-side bounded wait for DELTA_PLAN before proceeding as a full
 * send — sized to cover the sender's buildPatch round on the biggest
 * allowed source (DELTA_SOURCE_MAX) on modest hardware.
 */
export const DELTA_PLAN_WAIT_MS = 60_000

// v5-a3w: delta control message types — the `data.type` discriminator inside
// the opaque e2e-relay envelope (each body is a sealed enc1.<hex> payload;
// the envelope rides the existing server relay untouched).
export const DELTA_MSG = {
  /** receiver → sender: BlockHash[] of the vault's same-name prior file. */
  HASHES: 'delta-hashes',
  /** receiver → sender: no usable prior — full send, don't wait. */
  DECLINED: 'delta-declined',
  /** sender → receiver: accepted? + patchedSize + patchDigest. */
  PLAN: 'delta-plan',
} as const

/** v5-a3w: sealed body of DELTA_MSG.HASHES (receiver → sender). */
export interface DeltaHashesBody {
  transferId: string
  fileIndex: number
  /** blockHashes(priorFile) — offsets tile the prior file in DELTA_BLOCK_SIZE steps. */
  blocks: BlockHash[]
  /** Human-readable note (e.g. the prior size) — diagnostics only. */
  patchNote?: string
}

/** v5-a3w: sealed body of DELTA_MSG.DECLINED (receiver → sender). */
export interface DeltaDeclinedBody {
  transferId: string
  fileIndex: number
}

/**
 * v5-a3w: sealed body of DELTA_MSG.PLAN (sender → receiver).
 * accepted=false means full send (patch over the guard, build failure, or a
 * race with an already-streaming transfer). patchDigest is the SHA-256 hex of
 * the patch Blob — the receiver's resume-determinism anchor (a digest change
 * resets its stored patch-stream progress).
 */
export interface DeltaPlanBody {
  transferId: string
  fileIndex: number
  accepted: boolean
  patchedSize: number
  patchDigest: string
  originalSize: number
}

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
  // perf: max chunks pushed per peer per scheduler round. The wave loop used
  // to send ONE 64 KB chunk per round with the file read awaited inside the
  // critical path — disk latency serialized the wire (few MB/s ceiling on
  // mobile). Bursts keep the SCTP pipe full; the flow window (canSend)
  // remains the real throttle.
  SENDER_BURST_CHUNKS: 64,
  // === v5-a2: server-relayed fallback transport ===
  // Relay is the LAST rung of the recovery ladder (engages only when P2P is
  // impossible). Window/retries/timeout mirror the in-transport semantics
  // of the DataChannel path so the send loop treats it uniformly: 8 chunks
  // in flight max, up to 3 transmission tries per seq, one retransmit timer
  // tick every 4 s. Rate limiting on the SERVER side is enforced by the
  // signaling service (see mini-services/signaling RELAY_RATE_BYTES_PER_SEC).
  RELAY_WINDOW_CHUNKS: 8,
  RELAY_RETRY_MAX: 3,
  RELAY_RETRY_TIMEOUT_MS: 4_000,
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

// === v5-a2: server-relayed fallback transport events ===
// Deliberately OUTSIDE SIGNALING_EVENTS: that map auto-subscribes the
// transparency recorder to every event name, and relay chunks arrive at wire
// rate (~64 frames/s) — a notify() per chunk would storm the transparency
// panel. The relay path tracks its own byte counters instead (see
// relay-transport.ts getRelayStats, surfaced through the debug bundle).
export const RELAY_EVENTS = {
  RELAY_DATA: 'relay-data',   // sender -> server -> receiver (chunk payload)
  RELAY_ACK: 'relay-ack',    // receiver -> server -> sender (per-seq ack)
  RELAY_ERROR: 'relay-error', // server -> sender (e.g. quota exceeded)
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
