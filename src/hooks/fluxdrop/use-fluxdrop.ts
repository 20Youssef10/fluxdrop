// useFluxDrop: the master orchestration hook.
// Coordinates signaling + WebRTC + chunk streaming + resume + verification.
//
// IMPORTANT: store actions (setters) from Zustand are stable and safe to capture
// in long-lived callbacks. But *reading* state values inside those callbacks would
// produce stale closures. We therefore mirror the state we need to read into refs
// that are updated every render.

'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'
import { FluxDropSignaling } from '@/lib/fluxdrop/signaling'
import { FluxDropWebRTC, sdpOrigin } from '@/lib/fluxdrop/webrtc'
import { buildManifest, buildSlicePlan, resolveChunk } from '@/lib/fluxdrop/manifest'
import { verifyChecksum, hashBlobRange } from '@/lib/fluxdrop/checksum'
// v5-a4: pooled hashing — also used by v5-a3w to hash the delta patch Blob.
import { destroyHashWorker, hashFileWorker } from '@/lib/fluxdrop/hash-worker-client'
import { validateFiles, formatBytes, computeTotalChunks } from '@/lib/fluxdrop/format'
import { randomUUID } from '@/lib/fluxdrop/random'
import {
  saveTransferRecord,
  updateTransferRecord,
  getTransferRecord,
  deleteTransferRecord,
  markChunkAcked,
  markChunksAcked,
  saveChunk,
  getChunk,
  getStoredChunkIndices,
  flushAllPendingAcks,
  saveSenderFiles,
  deleteSenderFiles,
  type StoredTransfer,
} from '@/lib/fluxdrop/resume'
import { assembleBlob, saveBlobWithPicker, saveFilesToDirectory } from '@/lib/fluxdrop/file-io'
// v1.3 (4.1): Files vault (OPFS) — verified received transfers are kept on
// device before the save pickers, with a byte budget + LRU eviction.
import { saveToVault, vaultSupported, enforceVaultBudget, listVault, getVaultFileBlob, deleteVaultEntry } from '@/lib/fluxdrop/vault'
import { resolveSaveConflicts } from '@/components/fluxdrop/save-conflict-dialog'
import type { FilePreview } from '@/stores/transfer-store'
import { useChatStore } from '@/stores/chat-store'
import { addRecentRoom } from '@/lib/fluxdrop/recent-rooms'
// v5-e/f: chaos lab (F18) — flake timer + active-profile probe.
import { activeChaosProfile, chaosStartFlake, chaosStopFlake } from '@/lib/fluxdrop/chaos'
import { isTrustedPeer, addTrustedPeer } from '@/lib/fluxdrop/trusted-peers'
import { playSuccess, playError, playConnect, playPause, playResume } from '@/lib/fluxdrop/sound'
import { MessageType, CONSTANTS, FAST_LANE_MAX, FAST_LANE_MIN_BYTES, DELTA_MSG, DELTA_MAX_PATCH_BYTES, DELTA_SOURCE_MAX, DELTA_PLAN_WAIT_MS, PULL_MSG, PULL_MAX_FILES, type TransferManifest, type TransferSummary, type TransferState, type DeltaHashesBody, type DeltaPlanBody, type DeltaDeclinedBody, type SessionGrants, type PullOfferBody, type PullRequestBody, type PullFileEntry } from '@/lib/fluxdrop/protocol'
import { gzipCompress, gzipDecompress, shouldCompressTransfer, isCompressionSupported } from '@/lib/fluxdrop/compress'
import { fetchTurnCredentials, mergeTurnIntoIceServers } from '@/lib/fluxdrop/turn'
import {
  E2EHandshake,
  activateE2ESession,
  decryptWirePayload,
  decryptJsonFromSignaling,
  encryptWirePayload,
  encryptJsonForSignaling,
  isE2EActive,
  isE2EActiveForPeer,
  isE2EActiveForRoom,
  isEncryptedSignalingPayload,
  resetE2ESession,
  setE2EStatus,
  type E2ERelayMessage,
} from '@/lib/fluxdrop/e2e'
// v5-a2: server-relayed fallback transport (last rung of the recovery ladder).
import { RelayTransport, createRelayReceiver } from '@/lib/fluxdrop/relay-transport'
// v5-a3w: delta sync (rsync-lite) — the pure library from v5-a3; this task
// wires it into the engine (sealed signaling negotiation + patch streaming
// over the normal chunk transports).
import {
  DELTA_BLOCK_SIZE,
  blockHashes,
  buildPatch,
  encodePatch,
  decodePatchStream,
  applyPatch,
} from '@/lib/fluxdrop/delta'
import { toast } from 'sonner'
// v5-b1/b2/b4: disappearing transfers (TTL + remote wipe), panic mode
// (duress PIN), and scoped session grants.
import { isDuressPin, executePanicWipe } from '@/lib/fluxdrop/panic'
import { grantAllows, grantedToUse, recordIncomingGrants, recordOutgoingGrants, clearGrants } from '@/lib/fluxdrop/session-grants'
// v4: merkle integrity tree (1.7), clipboard sync (4.6), prefs (1.3/5.4/etc).
import { computeTransferMerkle } from '@/lib/fluxdrop/merkle'
import { isValidClipboardFrame, deliverClipboardSync, attachClipboardSender, CLIPBOARD_MAX_LEN } from '@/lib/fluxdrop/clipboard-sync'
import { usePrefsStore } from '@/lib/fluxdrop/prefs'
// v5-c7: kiosk receive station (auto-accept + wall state).
import { useKioskStore } from '@/stores/kiosk-store'
// v5-a1: inline-fallback translations for the (muted) lane-drop toast.
import { t } from '@/lib/fluxdrop/i18n'

/**
 * v1.1: file-interleaved send order (pipelining).
 *
 * The wire format is a continuous byte stream over all files (chunkIndex maps
 * to global byte offsets via the slice plan), so "pipelining" is implemented
 * as the ORDER in which global chunk indices are scheduled: round-robin
 * across the per-file chunk ranges. Chunk counts per file are proportional to
 * file sizes, so progress is proportionally fair — a huge first file no
 * longer starves the remaining files in the queue.
 *
 * The receiver stores chunks by INDEX (out-of-order arrival is already the
 * norm on parallel DataChannels), so no protocol change is needed.
 *
 * Deterministic: the same manifest always produces the same order, so resume
 * positions (indices INTO this array) stay stable across reconnections.
 */
function buildSendOrder(manifest: TransferManifest, plan: { fileIndex: number; startByte: number; endByte: number }[]): number[] {
  if (manifest.files.length <= 1) {
    return Array.from({ length: manifest.totalChunks }, (_, i) => i)
  }
  const ranges = plan
    .map((seg) => ({
      next: Math.floor(seg.startByte / manifest.chunkSize),
      endChunk: Math.floor((seg.endByte - 1) / manifest.chunkSize),
    }))
    .filter((r) => r.endChunk >= r.next)
  const order: number[] = []
  const seen = new Set<number>()
  let progressed = true
  while (order.length < manifest.totalChunks && progressed) {
    progressed = false
    for (const r of ranges) {
      while (r.next <= r.endChunk && seen.has(r.next)) r.next++
      if (r.next > r.endChunk) continue
      seen.add(r.next)
      order.push(r.next)
      r.next++
      progressed = true
      if (order.length >= manifest.totalChunks) break
    }
  }
  if (order.length < manifest.totalChunks) {
    // Safety net (zero-size edge cases): append any unscheduled indices.
    for (let i = 0; i < manifest.totalChunks; i++) {
      if (!seen.has(i)) order.push(i)
    }
  }
  return order
}

/**
 * v1.3 (6.1): one fan-out peer on the SENDER side. Every connected receiver
 * gets its own DataChannel (own FluxDropWebRTC instance), its own position in
 * the deterministic send order, its own resume-skip bitmap and its own E2E
 * session key. The receiver side keeps the single-peer model unchanged.
 */
interface SenderPeer {
  id: string
  // v5-a2: null for a relay-mode peer (no PC exists — the relay transport in
  // relayModeRef is its ONLY transport). Non-relay peers always hold a live
  // (or dead-but-present) FluxDropWebRTC.
  rtc: FluxDropWebRTC | null
  active: boolean                 // participating in the current transfer
  nextPos: number                 // position in the send order array
  skip: Set<number>               // chunks this peer already stores (resume bitmap)
  skipCount: number
  acked: Set<number>              // chunks acked by this peer
  enc: boolean                    // this leg uses the encrypted wire framing
  accepted: boolean               // manifest acked (consent given)
  skipQueryPending: boolean       // resumed send: awaiting this peer's bitmap
  completedSent: boolean          // TRANSFER_COMPLETE sent to this peer
  completed: boolean              // peer confirmed verification
}

// v5-a1: one EXTRA striped transport for the fast-lane subsystem. Lanes are
// additive parallel RTCPeerConnections used only for large single-receiver
// transfers: the primary (in peerRtcsRef) keeps every control message and the
// resume bitmap continuity; lanes only ever carry chunk payloads + their acks.
// Array index 0 in fastLaneRtcsRef === lane 1, etc. (0 is the primary, never
// stored here).
interface FastLane {
  lane: number                       // 1..FAST_LANE_MAX-1
  rtc: FluxDropWebRTC
  bytesSent: number                  // wire bytes pushed through this lane (observability)
  bytesReceived: number              // wire bytes ingested through this lane
  graceTimer: ReturnType<typeof setTimeout> | null   // 3 s drop grace
}

const PREVIEW_HEAD_BYTES = 24 * 1024
const PREVIEW_MAX_FILES = 8
const PREVIEW_WAIT_MS = 4000

// v1.3 (6.3): in-room chat constraints (mirrored by the chat panel UI).
const CHAT_MAX_LEN = 2000
// Chat frames are transfer-agnostic: the header's transferId field stays zero.
const CHAT_WIRE_TRANSFER_ID = '0'

// v4 (1.7): sender-side Merkle leaves kept in memory for this send session
// (the manifest only carries the root; leaves enable spot-verifications).
let merkleLeavesCache: string[] | null = null

// v4 (6.2): verified received files, cached per transferId for "send onward"
// (relay-to-peer chaining) — the completion screen can re-queue them into a
// fresh send without touching the vault. Bounded: only the LAST transfer's
// blobs are kept (memory), older entries are dropped.
const receivedFilesCache = new Map<string, { name: string; blob: Blob; type: string }[]>()
function cacheReceivedFiles(transferId: string, files: { name: string; blob: Blob; type: string }[]): void {
  if (receivedFilesCache.size > 2) {
    const oldest = receivedFilesCache.keys().next().value
    if (oldest !== undefined) receivedFilesCache.delete(oldest)
  }
  receivedFilesCache.set(transferId, files)
}

/** v4 (1.8): optional post-transfer automation — auto-open the first file. */
function maybeAutoOpenFirstFile(m: TransferManifest): void {
  try {
    if (!usePrefsStore.getState().autoOpenFirstFile) return
    const files = receivedFilesCache.get(m.transferId)
    const first = files?.[0]
    if (!first) return
    const url = URL.createObjectURL(first.blob)
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 120_000)
  } catch { /* best-effort automation */ }
}

// --- v1.3 (1.6): streamed receive ---
// Transfers above this cutoff never assemble full Blobs in RAM: chunks spill
// into one OPFS temp file at their byte offsets, and per-file bytes are cut
// from it lazily at completion (File.slice() is disk-backed).
const STREAM_RECEIVE_CUTOFF = 64 * 1024 * 1024

/** OPFS (Origin Private File System) availability for streamed receive. */
function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'storage' in navigator && !!navigator.storage?.getDirectory
}

/**
 * The ONE gate shared by processReceivedChunk (spill + RAM trim) and
 * finishReceiverTransfer (streamed completion) — both sides must agree, or
 * trimmed chunks would have nowhere to live.
 */
function shouldStreamReceive(m: TransferManifest): boolean {
  return m.totalSize > STREAM_RECEIVE_CUTOFF && opfsAvailable()
}

/** v4 (6.2): direct access to the verified-received cache (summary card UI). */
export function getReceivedFilesFromCache(transferId: string): { name: string; blob: Blob; type: string }[] | null {
  const cached = receivedFilesCache.get(transferId)
  if (!cached || cached.length === 0) return null
  return cached
}

// ================= v5-a3w: delta sync (rsync-lite) wiring =================
// Sealed CONTROL channel for the delta negotiation. It mirrors the v5-a2
// sealed-manifest plumbing ("enc1.<hex>" — AES-256-GCM under the PAKE session
// key, AAD 'manifest') but binds to the SPECIFIC peer: a group sender holds
// one key per receiver, and encryptJsonForSignaling's peer-less fallback only
// resolves on 1:1 legs. The messages themselves ride the OPAQUE e2e-relay
// signaling envelope (server forwards `data` verbatim — ZERO server changes).

function fdBytesToHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}

function fdHexToBytes(h: string): Uint8Array {
  const clean = h.length % 2 ? '0' + h : h
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Seal a delta control body → "enc1.<hex>", or null when E2E is unavailable
 *  (callers then decline — delta never falls back to plaintext control). */
async function sealDeltaMessage(body: unknown, peerId: string | null): Promise<string | null> {
  try {
    const json = new TextEncoder().encode(JSON.stringify(body))
    const enc = new Uint8Array(await encryptWirePayload(json, 'manifest', peerId))
    return `enc1.${fdBytesToHex(enc)}`
  } catch {
    return null
  }
}

/** Inverse of sealDeltaMessage — null on any tamper/desync/shape problem. */
async function unsealDeltaMessage<T>(sealed: string, peerId: string | null): Promise<T | null> {
  try {
    if (typeof sealed !== 'string' || !sealed.startsWith('enc1.')) return null
    const json = await decryptWirePayload(fdHexToBytes(sealed.slice(5)), 'manifest', peerId)
    return JSON.parse(new TextDecoder().decode(json)) as T
  } catch {
    return null
  }
}

// v5-a3w: receiver-side resume-determinism anchor, persisted in localStorage
// (survives the mid-delta reload that wipes every in-memory ref): the digest
// of the patch stream THIS device is (or was) accumulating for a transferId.
// A digest change on re-negotiation means the prior file changed — the stored
// patch-stream chunks are garbage and the progress/bitmap resets (fresh start).
const DELTA_RECORD_KEY_PREFIX = 'fluxdrop:delta:'

function readDeltaRecord(transferId: string): { patchDigest: string; patchedSize: number } | null {
  try {
    const raw = localStorage.getItem(DELTA_RECORD_KEY_PREFIX + transferId)
    if (!raw) return null
    const v = JSON.parse(raw) as { patchDigest?: unknown; patchedSize?: unknown }
    if (typeof v.patchDigest !== 'string' || !v.patchDigest) return null
    return { patchDigest: v.patchDigest, patchedSize: Number(v.patchedSize) || 0 }
  } catch {
    return null
  }
}

function writeDeltaRecord(transferId: string, v: { patchDigest: string; patchedSize: number }): void {
  try {
    localStorage.setItem(DELTA_RECORD_KEY_PREFIX + transferId, JSON.stringify(v))
  } catch { /* best-effort */ }
}

function clearDeltaRecord(transferId: string): void {
  try {
    localStorage.removeItem(DELTA_RECORD_KEY_PREFIX + transferId)
  } catch { /* best-effort */ }
}

// v5-a3w: module-level mirror of the live delta mode (either side) for the
// debug bundle — the engine owns the authoritative refs, this answers the
// "is a delta transfer in flight" question outside the hook tree.
let deltaModeActiveMirror = false

/** v5-a3w: true while THIS device is streaming/receiving a delta patch. */
export function isDeltaModeActive(): boolean {
  return deltaModeActiveMirror
}

// v5-a3w: sender-side armed delta plan — when set for the live transfer, the
// wire stream is the PATCH Blob, not the original file.
interface DeltaSenderPlan {
  transferId: string
  patchBlob: Blob
  patchedSize: number
  patchDigest: string
  /** Chunk count of the PATCH stream (ceil(patchedSize / chunkSize)). */
  totalChunks: number
}

// v5-a3w: receiver-side armed delta mode — incoming chunk bytes are the PATCH
// stream; they are accumulated by index (memory + IndexedDB for resume) and
// decoded + reconstructed against the vault prior at completion.
interface DeltaReceiverMode {
  transferId: string
  patchDigest: string
  patchedSize: number
  originalSize: number
  totalChunks: number
  /** The vault prior file the DELTA_HASHES were computed from (block source). */
  priorBlob: Blob
}

export function useFluxDrop() {
  const session = useSessionStore()
  const transfer = useTransferStore()

  // Refs that always hold the latest values for use inside long-lived callbacks.
  const sessionRef = useRef(session)
  const transferRef = useRef(transfer)
  useEffect(() => { sessionRef.current = session }, [session])
  useEffect(() => { transferRef.current = transfer }, [transfer])

  const signalingRef = useRef<FluxDropSignaling | null>(null)
  // v5-f19: leaderboard CustomEvent bridge teardown + handlers (rebuilt on
  // every signaling (re)connect — see the connect() wiring).
  const leaderboardTeardownRef = useRef<(() => void) | null>(null)
  const onLeaderboardFetchRef = useRef<(() => void) | null>(null)
  const onLeaderboardSubmitRef = useRef<((ev: Event) => void) | null>(null)
  // v1.3 (6.1): ALL peer connections live here (sender → one per receiver;
  // receiver → one entry keyed by the sender's deviceId). Lookup helper below.
  const peerRtcsRef = useRef<Map<string, FluxDropWebRTC>>(new Map())
  // v5-a1: EXTRA fast-lane transports per peer (index 0 = lane 1). The
  // primary stays in peerRtcsRef and is NEVER restructured — an empty map
  // (fastLanes=1, the default) is byte-identical legacy behavior.
  const fastLaneRtcsRef = useRef<Map<string, FastLane[]>>(new Map())
  // v5-a1 fix: fair-share striping cursor. Budget-max alone STARVES lanes on
  // any link with headroom (equal windows → primary wins every tie → the
  // lane PC idles for the whole transfer). The cursor rotates tie-breaks so
  // equal-budget transports alternate chunk slots; congested transports are
  // still excluded by the canSend gate, so lossy links keep budget-max
  // behavior (the drained lane simply isn't a candidate).
  const laneRotationRef = useRef<Map<string, number>>(new Map())
  // v5-a1 fix: synchronous in-flight marker for maybeStartFastLanes — see
  // the idempotency note there (racing triggers must not double-spin lanes).
  const laneSpinningRef = useRef<Set<string>>(new Set())
  // v5-a1: per-peer protocol capabilities learned from the receiver's
  // pairing-request (see onPairingRequest). No advertisement → never send
  // lane messages to that peer (hard backwards rule).
  const peerCapsRef = useRef<Map<string, { fastLanes: boolean; relay: boolean }>>(new Map())
  // v5-a2: active server-relay fallback transports per peer (relay mode).
  // A peer in this map has NO usable P2P path — the send loop treats its
  // RelayTransport as the ONLY transport (lanes/primary are dead by
  // definition). While P2P works this map stays empty (dead weight only).
  const relayModeRef = useRef<Map<string, RelayTransport>>(new Map())
  // v5-a2: one-shot dev flag armed by window.__fluxdropRelay.forceNext() —
  // the NEXT pairing skips PC creation entirely and goes straight to relay.
  // Auto-cleared after a single use (engaged or not).
  const forceRelayNextRef = useRef(false)
  // v5-a2: dispose handle of the page-lifetime relay receiver (connect()
  // arms it; cleanup()/unmount disposes it).
  const relayReceiverRef = useRef<{ dispose(): void } | null>(null)
  // v1.3 (6.1): sender-side per-peer fan-out state.
  const senderPeersRef = useRef<Map<string, SenderPeer>>(new Map())
  // Device ids that MUST receive this transfer (paired+accepted when the send
  // started). Peers that leave stop being required; late joiners are extra.
  const requiredPeersRef = useRef<Set<string>>(new Set())
  // Per-chunk ack tracking for the aggregate ("delivered to every required
  // peer") — chunks drop out of the map once fully delivered.
  const chunkAckVotersRef = useRef<Map<number, Set<string>>>(new Map())
  /** Resolve a peer connection (defaults to the current primary peer). */
  const getRtc = (peerId?: string | null): FluxDropWebRTC | null =>
    peerRtcsRef.current.get(peerId ?? peerDeviceIdRef.current ?? '') ?? null
  const filesRef = useRef<File[]>([])
  const manifestRef = useRef<TransferManifest | null>(null)
  // v1.1: PIN the receiver typed (kept for the signaling rejoin path — the
  // room-joined event doesn't echo it back).
  const receiverPinRef = useRef<string | null>(null)
  const slicePlanRef = useRef<ReturnType<typeof buildSlicePlan>>([])
  const sendingRef = useRef<boolean>(false)
  const receiverBuffersRef = useRef<Map<number, ArrayBuffer>>(new Map())
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const speedTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const peerDeviceIdRef = useRef<string | null>(null)
  const checksumVerifiedRef = useRef<boolean | null>(null)
  const silentConnectRef = useRef(false)
  // Pause/Resume flow control: either side can pause the stream.
  const pauseLocalRef = useRef<boolean>(false)
  const pausePeerRef = useRef<boolean>(false)
  // Next chunk the sender loop should push. Updated by the loop itself so a
  // dead loop can be restarted from the right position (see kickSenderLoop).
  const senderNextIndexRef = useRef<number>(0)
  // Generation counter for send loops: each beginSending() bumps it, and a
  // superseded loop aborts when it sees a newer generation (prevents two
  // loops racing after a watchdog force-restart).
  const sendLoopGenRef = useRef<number>(0)
  const beginSendingRef = useRef<((resumeFrom?: number) => Promise<void>) | null>(null)
  // Late-bound ref for verifyReceiverTransfer (declared further below — the
  // signaling onTransferComplete handler runs long after render, so a ref
  // avoids the temporal-dead-zone of a direct reference from connect()).
  const verifyReceiverTransferRef = useRef<(() => Promise<void>) | null>(null)
  // Watchdog bookkeeping: last chunk index seen + consecutive stalled ticks.
  const stallLastIdxRef = useRef<number>(-1)
  const stallTicksRef = useRef<number>(0)
  // Receiver self-completion poll: consecutive ticks with all chunks acked.
  const receiverCompleteTicksRef = useRef<number>(0)
  // Resumed-send state: set when startSend reuses a stored manifest so the
  // MANIFEST_ACK path knows to query the receiver before streaming.
  const resumeSkipPendingRef = useRef<boolean>(false)
  const resumeQueryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Chunks the receiver already holds (from its acked bitmap) — the send loop
  // skips these so stored chunks never travel the wire twice.
  const skipIndicesRef = useRef<Set<number>>(new Set())
  // True once a resumed send actually skipped stored chunks — used to give a
  // more helpful error message if the receiver's verification then fails.
  const resumeSkipUsedRef = useRef<boolean>(false)
  // Receiver chunk persistence: which received chunks have already been
  // written to IndexedDB (lazy delta flush — see flushReceiverBuffers).
  const flushedChunkIdsRef = useRef<Set<number>>(new Set())
  const flushChainRef = useRef<Promise<void>>(Promise.resolve())

  // --- v1.3 (1.6): streamed receive state (OPFS temp file) ---
  // The temp file IS the transfer's byte stream: one file per transferId in
  // OPFS `fluxdrop-tmp/<transferId>.bin`, filled by positional writes. ONE
  // writable stays open for the whole transfer (per-chunk open/close would
  // re-copy OPFS's swap file every chunk), so reads must wait for close().
  const receiverTempDirRef = useRef<FileSystemDirectoryHandle | null>(null)
  const receiverTempHandleRef = useRef<FileSystemFileHandle | null>(null)
  const receiverTempNameRef = useRef<string | null>(null)
  const receiverWritableRef = useRef<FileSystemWritableFileStream | null>(null)
  // Order-keeper for positional temp writes (same pattern as flushReceiverBuffers).
  const opfsWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  // Chunk indices CONFIRMED written to the temp — the third "chunk location"
  // alongside the memory map and the IndexedDB cache.
  const opfsWrittenRef = useRef<Set<number>>(new Set())
  // Set when an OPFS write fails: stop trimming (chunks stay in memory/IDB)
  // and let completion seal the gap (or fall back to the in-memory pipeline).
  const receiverStreamBrokenRef = useRef<boolean>(false)

  // --- v5-a3w: delta sync state ---
  // SENDER: the armed plan (patch Blob as the chunk source). Set ONLY when
  // no send loop is running (the atomic engage in onDeltaHashes re-checks
  // synchronously before swapping), so a running loop can never observe a
  // source change mid-stream.
  const deltaPlanRef = useRef<DeltaSenderPlan | null>(null)
  // RECEIVER: armed delta mode (incoming chunks are the PATCH stream).
  const deltaModeRef = useRef<DeltaReceiverMode | null>(null)
  // RECEIVER: the vault prior file of the CURRENT negotiation (kept for
  // reconstruction — the plan's copy ops index into it).
  const deltaPriorBlobRef = useRef<Blob | null>(null)
  // RECEIVER: the pending pre-accept DELTA_PLAN wait (negotiation flow).
  const deltaPlanWaitRef = useRef<{ transferId: string; resolve: (b: DeltaPlanBody | null) => void } | null>(null)

  // ================= v5-c6: pull mode ("browse & request") =================
  // SENDER: the shared library (files + id). Armed by startSend({pullMode});
  // the offer goes out per-peer after the E2E handshake settles, and the
  // first REQUEST builds the real manifest from exactly the picked files.
  const pullLibraryRef = useRef<{ id: string; files: File[] } | null>(null)
  // RECEIVER: "name:size" keys of the files we requested — the arrival
  // manifest must be a SUBSET of this set to qualify for consent-free
  // auto-accept (a substituted manifest falls back to the normal dialog).
  const pullExpectRef = useRef<Set<string> | null>(null)
  // RECEIVER: the 4s window gating inbound library PREVIEW_DATA frames.
  const libraryPreviewsWaitingRef = useRef<boolean>(false)
  const libraryPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- v1.2 (4.4): consent-dialog rich previews (receiver side) ---
  // One PREVIEW_REQ per manifest; PREVIEW_DATA frames resolve per-file entries
  // in the transfer store. `previewsWaitingRef` gates the 4s window after the
  // request — frames outside the window (or after accept) are silently
  // ignored. Everything here is fail-soft: a preview problem NEVER touches
  // the transfer pipeline.
  const previewsWaitingRef = useRef<boolean>(false)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewResolvedRef = useRef<Set<number>>(new Set())
  const previewRequestedForRef = useRef<string | null>(null)

  // --- v1.1: mid-transfer auto-retry (bounded resume attempts) ---
  // The DC-close → re-offer → bitmap-handshake path already existed; what
  // was missing was a CAP — an unreachable peer used to loop resume attempts
  // forever. 3 attempts with exponential backoff, reset on restored traffic.
  const resumeAttemptsRef = useRef<number>(0)
  const RESUME_ATTEMPT_MAX = 3
  // --- v1.1: ICE 'disconnected' grace timer (often self-heals) ---
  const disconnectGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // --- perf/resume-1: in-place ICE restart bookkeeping (per peer) ---
  const iceRestartAttemptsRef = useRef<Map<string, number>>(new Map())
  const iceRestartLastAtRef = useRef<Map<string, number>>(new Map())
  // Late-bound recovery helpers: connect() is defined BEFORE attemptResume/
  // performIceRestart in this file, so those closures reach them via refs
  // (same TDZ-avoidance pattern as beginSendingRef).
  const performIceRestartRef = useRef<(peerId: string) => Promise<boolean>>(async () => false)
  const attemptResumeRef = useRef<() => Promise<void>>(async () => {})
  const kickSenderLoopRef = useRef<() => void>(() => {})
  // Receiver stall watchdog: poke-the-sender bookkeeping. The receiver is the
  // ICE ANSWERER — it cannot restart the transport itself, so when its stream
  // stalls with a dead channel it asks the sender over signaling to recover.
  const receiverStallTicksRef = useRef<number>(0)
  const receiverPokeCountRef = useRef<number>(0)
  const receiverLastPokeAtRef = useRef<number>(0)
  // v5-a2: last relay-data frame routed into the ingest (receiver side). A
  // recent frame means the server-relay fallback is carrying the transfer —
  // the stall watchdog must NOT mistake that for a dead transport and poke
  // (which would trigger the sender's P2P re-offer ladder mid-relay).
  const relayLastChunkAtRef = useRef<number>(0)
  // --- v1.1: file-interleaved send order (pipelining) ---
  // Deterministic per manifest: same manifest → same order, so resume
  // positions (order indices) stay stable across reconnection.
  const sendOrderRef = useRef<number[]>([])
  // --- v1.1: wire compression decision for the active transfer ---
  const wireCompressionRef = useRef<'gzip' | undefined>(undefined)
  // --- v1.2: E2E payload encryption (SPAKE2 over the room PIN) ---
  // In-progress handshake(s): one per pairing attempt, per peer (v1.3 groups:
  // the sender runs an independent handshake with every receiver).
  const e2eHandshakesRef = useRef<Map<string, E2EHandshake>>(new Map())
  // True when the CURRENT send/receive leg uses the encrypted wire framing
  // (CHUNK_ENC / MANIFEST_ENC). Decided once per leg: sender freezes it when
  // the DataChannel opens, receiver freezes it on the (encrypted) manifest.
  const e2eWireRef = useRef<boolean>(false)
  // Handshake generation — a newer pairing supersedes an older handshake.
  const e2eGenRef = useRef<number>(0)

  const isPaused = () => pauseLocalRef.current || pausePeerRef.current

  // v5-a3w: receiver-side effective stream length — while a delta plan is
  // armed for THIS transfer the live stream is the PATCH (fewer, smaller
  // chunks than the manifest's ORIGINAL counts). Every receiver-side
  // "totalChunks" consumer that gates on the live stream must use this.
  const deltaStreamChunks = useCallback((m: TransferManifest): number => {
    const d = deltaModeRef.current
    return d && d.transferId === m.transferId ? d.totalChunks : m.totalChunks
  }, [])

  // v5-a3w: has the sender's stream kicked off? Read fresh from the LIVE
  // store (never a narrowed ref path) — onDeltaHashes checks this twice
  // (before the build, and synchronously before the source swap).
  const deltaStreamingStarted = (): boolean =>
    sendingRef.current || useTransferStore.getState().transferState === 'TRANSFERRING'

  // ---- Receiver chunk persistence ----
  // Chunks live in memory while streaming (per-chunk IDB writes would kill
  // throughput). This flushes NEW chunks to IndexedDB in the background so a
  // resumed transfer can skip them later (and assembly can read them back).
  const flushReceiverBuffers = useCallback(() => {
    const m = manifestRef.current
    if (!m) return
    const pending: Array<[number, ArrayBuffer]> = []
    for (const [idx, buf] of receiverBuffersRef.current) {
      if (!flushedChunkIdsRef.current.has(idx)) pending.push([idx, buf])
    }
    if (pending.length === 0) return
    for (const [idx] of pending) flushedChunkIdsRef.current.add(idx)
    // Sequence flushes to keep IndexedDB writes ordered and non-concurrent.
    flushChainRef.current = flushChainRef.current.then(async () => {
      for (const [idx, buf] of pending) {
        try { await saveChunk(m.transferId, idx, buf) } catch { /* best-effort */ }
      }
    }).catch(() => { /* ignore */ })
  }, [])

  // ---- v1.3 (1.6): OPFS streamed receive helpers ----
  /** Open (once) the transfer's temp file + its single long-lived writable. */
  const ensureReceiverWritable = useCallback(async (transferId: string): Promise<FileSystemWritableFileStream | null> => {
    if (receiverWritableRef.current) return receiverWritableRef.current
    try {
      const root = await navigator.storage.getDirectory()
      const tmpDir = await root.getDirectoryHandle('fluxdrop-tmp', { create: true })
      const name = `${transferId}.bin`
      // create:true + keepExistingData:false → the temp starts EMPTY and its
      // contents are exactly what THIS session writes (tracked in
      // opfsWrittenRef) — stale bytes from an earlier attempt can't leak in.
      const handle = await tmpDir.getFileHandle(name, { create: true })
      const writable = await handle.createWritable({ keepExistingData: false })
      receiverTempDirRef.current = tmpDir
      receiverTempHandleRef.current = handle
      receiverTempNameRef.current = name
      receiverWritableRef.current = writable
      return writable
    } catch (err: any) {
      console.warn('[FluxDrop] OPFS temp unavailable — streamed receive disabled:', err?.message)
      return null
    }
  }, [])

  /** Commit the open writable so getFile()/slice() see every written byte. */
  const closeReceiverWritable = useCallback(async (): Promise<void> => {
    const w = receiverWritableRef.current
    receiverWritableRef.current = null
    if (!w) return
    try { await w.close() } catch { /* already closed or aborted */ }
  }, [])

  /**
   * Best-effort teardown: abort the writable (discards OPFS's swap file) and
   * delete the temp file. Used by the streamed finish's finally AND cleanup().
   */
  const discardReceiverTemp = useCallback(async (): Promise<void> => {
    const w = receiverWritableRef.current
    const dir = receiverTempDirRef.current
    const name = receiverTempNameRef.current
    receiverWritableRef.current = null
    receiverTempHandleRef.current = null
    receiverTempNameRef.current = null
    receiverTempDirRef.current = null
    opfsWrittenRef.current = new Set()
    if (w) {
      try { await w.abort() } catch { /* already closed — fine */ }
    }
    if (dir && name) {
      try { await dir.removeEntry(name) } catch { /* best-effort */ }
    }
  }, [])

  // ---- Transfer-history persistence ----
  // Single helper that records every transfer lifecycle transition so the
  // landing-page history shows the real outcome (COMPLETE / ERROR / CANCELLED).
  // Runs as an atomic read-modify-write INSIDE the record write queue — a
  // stale read here would clobber newer ack data committed by ack flushes.
  const persistTransferRecord = useCallback(async (
    role: 'sender' | 'receiver',
    status: TransferState,
    extra?: { checksumVerified?: boolean }
  ) => {
    const m = manifestRef.current
    if (!m) return
    try {
      const finished = status === 'COMPLETE' || status === 'ERROR' || status === 'CANCELLED' || status === 'FAILED'
      await updateTransferRecord(m.transferId, (existing) => {
        // TERMINAL-STATE GUARD: never downgrade a verified-complete record.
        // A cleanup path firing after completion (Leave room, peer-left
        // handler, page unload) used to overwrite COMPLETE with CANCELLED —
        // corrupting history (observed: record with 320/320 acks marked
        // CANCELLED). Once verified COMPLETE, the record is immutable.
        if (existing?.status === 'COMPLETE' && status !== 'COMPLETE') {
          return null // abort this write — keep the COMPLETE record intact
        }
        return {
          transferId: m.transferId,
          role,
          manifest: m,
          status,
          chunksAcked: existing?.chunksAcked ?? [],
          bytesTransferred: transferRef.current.bytesTransferred || existing?.bytesTransferred || 0,
          peerAlias: existing?.peerAlias ?? sessionRef.current.peers[0]?.alias ?? 'peer',
          peerDeviceId: existing?.peerDeviceId ?? peerDeviceIdRef.current ?? existing?.peerDeviceId ?? '',
          startedAt: existing?.startedAt ?? transferRef.current.startedAt ?? Date.now(),
          updatedAt: Date.now(),
          finishedAt: finished ? Date.now() : existing?.finishedAt,
          checksumVerified: extra?.checksumVerified ?? existing?.checksumVerified,
          resumedAt: existing?.resumedAt,
          resumedSavedBytes: transferRef.current.skippedBytes || existing?.resumedSavedBytes,
        }
      })
    } catch { /* best-effort — history must never break transfers */ }
  }, [])
  const clearPaused = () => { pauseLocalRef.current = false; pausePeerRef.current = false }

  // ---- Speed ticker ----
  useEffect(() => {
    speedTickerRef.current = setInterval(() => {
      transferRef.current.tickSpeed(Date.now())
    }, 500)
    return () => {
      if (speedTickerRef.current) clearInterval(speedTickerRef.current)
    }
  }, [])

  // ---- Heartbeat ----
  useEffect(() => {
    if (!session.roomId) return
    heartbeatRef.current = setInterval(() => {
      signalingRef.current?.heartbeat(session.roomId!)
    }, 15_000)
    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    }
  }, [session.roomId])

  // ---- Init device identity on mount ----
  const deviceInitPromiseRef = useRef<Promise<void> | null>(null)
  useEffect(() => {
    deviceInitPromiseRef.current = session.initDevice()
  }, [])

  /** Ensure device identity is initialized before proceeding. */
  const ensureDeviceReady = useCallback(async (): Promise<void> => {
    // Wait for the initial initDevice() call to complete.
    if (deviceInitPromiseRef.current) {
      try {
        await deviceInitPromiseRef.current
      } catch { /* ignore — we'll retry below */ }
    }
    // Check the LIVE store state (not the ref, which may be stale).
    const state = useSessionStore.getState()
    if (!state.deviceId || !state.alias) {
      // Force-init if still empty.
      await state.initDevice()
    }
    // Final check — if STILL empty, generate synchronously as a last resort.
    const final = useSessionStore.getState()
    if (!final.deviceId || !final.alias) {
      const id = randomUUID()
      const alias = 'FluxDevice-' + Math.floor(Math.random() * 1000)
      final.setAlias(alias)
      // setAlias doesn't set deviceId, so set it directly via localStorage + store
      try {
        localStorage.setItem('fluxdrop:device', JSON.stringify({ id, alias }))
      } catch { /* ignore */ }
      // Update store state directly
      useSessionStore.setState({ deviceId: id, alias })
    }
  }, [])

  // ---- Cleanup on unmount ----
  useEffect(() => {
    const onBeforeUnload = () => { void flushAllPendingAcks() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      void flushAllPendingAcks()
      for (const rtc of peerRtcsRef.current.values()) {
        try { rtc.close() } catch { /* ignore */ }
      }
      peerRtcsRef.current.clear()
      // v5-a1: lanes die with the component — no leaked PCs or grace timers.
      for (const lanes of fastLaneRtcsRef.current.values()) {
        for (const l of lanes) {
          if (l.graceTimer) clearTimeout(l.graceTimer)
          try { l.rtc.close() } catch { /* ignore */ }
        }
      }
      fastLaneRtcsRef.current.clear()
      peerCapsRef.current.clear()
      // v5-a2: relay legs + the page-lifetime receiver die with the component.
      teardownRelay()
      relayReceiverRef.current?.dispose()
      relayReceiverRef.current = null
      signalingRef.current?.disconnect()
      destroyHashWorker()
    }
  }, [])

  // ================= v1.2: E2E (PAKE) orchestration =================
  // The room PIN is the shared secret. The SPAKE2 handshake runs over the
  // signaling relay (membership-checked, payload opaque to the server) in
  // parallel with ICE negotiation. On success a module-level AES-256-GCM
  // session activates and the send/receive paths switch to encrypted framing
  // (CHUNK_ENC / MANIFEST_ENC). Confirmation-mac failure ABORTS the transfer
  // with an interception warning — it never silently downgrades.

  /** Sender-side handshake kickoff for ONE receiver (v1.3 groups). */
  const startSenderE2EHandshake = useCallback((peerId: string | null) => {
    const s = useSessionStore.getState()
    const pin = s.pin || receiverPinRef.current
    const roomId = s.roomId
    if (!s.e2eEnabled || !pin || !roomId || !peerId) return
    // Resume leg of the SAME room+peer — the surviving session covers it.
    if (isE2EActiveForPeer(roomId, peerId)) return
    try {
      const hs = new E2EHandshake('sender', {
        roomId,
        pin,
        senderDeviceId: s.deviceId,
        receiverDeviceId: peerId,
      })
      const hello = hs.createHello()
      e2eHandshakesRef.current.set(peerId, hs)
      e2eGenRef.current++
      s.setE2EStatus('handshaking')
      signalingRef.current?.sendE2ERelay({
        roomId,
        from: s.deviceId,
        to: peerId,
        data: { type: 'hello', v: 1, ...hello } satisfies E2ERelayMessage,
      })
      console.log(`[FluxDrop] E2E: hello sent to peer ${peerId.slice(0, 8)} (SPAKE2/P-256)`)
    } catch (err: any) {
      console.warn('[FluxDrop] E2E handshake failed to start:', err?.message)
      e2eHandshakesRef.current.delete(peerId)
      s.setE2EStatus('idle')
    }
  }, [])

  /** Poll until the handshake with `peerId` activates (or timeout / failure). */
  const waitForE2EActive = useCallback(async (timeoutMs: number, peerId?: string | null): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (isE2EActive(peerId)) return true
      if (useSessionStore.getState().e2eStatus === 'failed') return false
      await new Promise((r) => setTimeout(r, 60))
    }
    return isE2EActive(peerId)
  }, [])

  /** Abort the transfer on confirmation failure — never downgrade silently. */
  const failE2E = useCallback((reason: string, peerId?: string | null) => {
    if (peerId) e2eHandshakesRef.current.delete(peerId)
    else e2eHandshakesRef.current.clear()
    e2eWireRef.current = false
    resetE2ESession(peerId)
    useSessionStore.getState().setE2EStatus('failed')
    useSessionStore.getState().setE2ESas(null)
    playError()
    transferRef.current.setTransferState('FAILED')
    transferRef.current.setError(reason)
    toast.error('Encryption verification failed', {
      description: `${reason} — for your safety the transfer was stopped. Check that both devices show the same verification code.`,
      duration: 15000,
    })
    void persistTransferRecord(filesRef.current.length > 0 ? 'sender' : 'receiver', 'FAILED')
  }, [persistTransferRecord])

  /** Route an opaque PAKE message relayed through the signaling server. */
  const handleE2ERelayPayload = useCallback(async (payload: { roomId?: string; from: string; to: string; data: E2ERelayMessage }) => {
    const data = payload?.data
    if (!data || typeof data !== 'object' || !data.type) return
    const roomId = payload.roomId ?? useSessionStore.getState().roomId ?? ''
    const s = useSessionStore.getState()
    switch (data.type) {
      case 'hello': {
        // We are the RECEIVER. Older peers (or opted-out) simply ignore it.
        if (!s.e2eEnabled) return
        const pin = receiverPinRef.current || s.pin
        if (!pin || !roomId) return
        try {
          const hs = new E2EHandshake('receiver', {
            roomId,
            pin,
            senderDeviceId: payload.from,
            receiverDeviceId: s.deviceId,
          })
          // v5-b3: forward the ML-KEM-768 public key when the sender offered
          // the hybrid leg; encapsulation happens inside processHello.
          const { reply } = hs.processHello({ salt: data.salt, xPub: data.xPub, kemPub: data.kemPub })
          e2eHandshakesRef.current.set(payload.from, hs)
          e2eGenRef.current++
          s.setE2EStatus('handshaking')
          signalingRef.current?.sendE2ERelay({
            roomId,
            from: s.deviceId,
            to: payload.from,
            data: { type: 'reply', v: 1, yPub: reply.yPub, ...(reply.kemCt ? { kemCt: reply.kemCt } : {}) } satisfies E2ERelayMessage,
          })
          console.log('[FluxDrop] E2E: hello received — reply sent')
        } catch (err: any) {
          console.warn('[FluxDrop] E2E hello processing failed:', err?.message)
        }
        break
      }
      case 'reply': {
        // We are the SENDER.
        const hs = e2eHandshakesRef.current.get(payload.from)
        if (!hs || hs.role !== 'sender' || hs.isComplete) return
        try {
          // v5-b3: forward the KEM ciphertext when the receiver encapsulated.
          const { confirmMac } = hs.processReply({ yPub: data.yPub, kemCt: data.kemCt })
          signalingRef.current?.sendE2ERelay({
            roomId,
            from: useSessionStore.getState().deviceId,
            to: payload.from,
            data: { type: 'confirm', v: 1, mac: confirmMac } satisfies E2ERelayMessage,
          })
          console.log('[FluxDrop] E2E: reply received — confirm sent')
        } catch (err: any) {
          signalingRef.current?.sendE2ERelay({
            roomId,
            from: useSessionStore.getState().deviceId,
            to: payload.from,
            data: { type: 'fail', v: 1, reason: 'handshake error' } satisfies E2ERelayMessage,
          })
          failE2E('Key agreement failed', payload.from)
        }
        break
      }
      case 'confirm': {
        const hs = e2eHandshakesRef.current.get(payload.from)
        if (!hs || hs.isComplete) return
        const myRole = hs.role
        try {
          const { sas } =
            myRole === 'sender' ? hs.verifyReceiverConfirm(data.mac) : hs.verifyPeerConfirm(data.mac)
          if (!hs.aesKeyRaw) throw new Error('key material missing')
          // v5-b3: pqHybrid records whether the ML-KEM-768 leg contributed —
          // surfaced in the verification card + trusted-peer TOFU record.
          await activateE2ESession(hs.aesKeyRaw, sas, roomId, payload.from, hs.isPqHybrid)
          e2eGenRef.current++
          useSessionStore.getState().setE2EStatus('active')
          useSessionStore.getState().setE2ESas(sas)
          console.log(`[FluxDrop] E2E: session ACTIVE (SAS ${sas}${hs.isPqHybrid ? ' · PQ hybrid' : ''})`)
          if (myRole === 'receiver') {
            // Receiver answers with its own (role-tagged) confirmation so the
            // sender's activation is mutual.
            signalingRef.current?.sendE2ERelay({
              roomId,
              from: useSessionStore.getState().deviceId,
              to: payload.from,
              data: { type: 'confirm', v: 1, mac: hs.ourConfirmMac() } satisfies E2ERelayMessage,
            })
          } else {
            toast.success('End-to-end encryption active', {
              description: 'Payloads are sealed with a key derived from the room PIN. Compare the verification codes.',
              duration: 6000,
            })
          }
        } catch (err: any) {
          // Confirmation mismatch = wrong PIN state or active MITM. Tell the
          // peer, then abort locally. NEVER continue in the clear.
          try {
            signalingRef.current?.sendE2ERelay({
              roomId,
              from: useSessionStore.getState().deviceId,
              to: payload.from,
              data: { type: 'fail', v: 1, reason: 'confirmation mismatch' } satisfies E2ERelayMessage,
            })
          } catch { /* best-effort */ }
          failE2E('The two devices could not verify each other', payload.from)
        }
        break
      }
      case 'fail': {
        failE2E('Peer aborted the encryption handshake', payload.from)
        break
      }
    }
  }, [failE2E])

  // ================= v5-a3w: delta sync negotiation =================
  // Flow (single-file transfers only; every failure = silent full send):
  //   receiver manifest ── has vault prior? ──> DELTA_HASHES (sealed)
  //          │ no prior → DELTA_DECLINED (sealed)                 │
  //          ▼                                                 ▼
  //   [consent / full send]                    sender: buildPatch → guard →
  //                                            DELTA_PLAN { accepted, patchedSize,
  //                                            patchDigest } (sealed), chunk source
  //                                            swapped to the patch Blob
  //   receiver: plan accepted → delta mode armed BEFORE any chunk arrives
  //   (the negotiation completes before the consent dialog / auto-accept can
  //   send transfer-accepted; a late plan is still handled defensively).

  /** Send one sealed delta control message over the opaque e2e-relay envelope. */
  const sendDeltaControl = useCallback(async (to: string, type: string, body: unknown): Promise<boolean> => {
    const roomId = sessionRef.current.roomId
    if (!roomId) return false
    const sealed = await sealDeltaMessage(body, to)
    if (!sealed) return false // E2E unavailable — never a plaintext fallback
    try {
      signalingRef.current?.sendE2ERelay({
        roomId,
        from: sessionRef.current.deviceId,
        to,
        data: { type, v: 1, sealed },
      })
      return true
    } catch {
      return false
    }
  }, [])

  // v5-c6: pull control messages ride the SAME sealed envelope (seal/unseal
  // are body-agnostic; the delta naming is historical). Never a plaintext
  // fallback — pull without E2E simply doesn't engage.
  const sendPullControl = useCallback(async (to: string, type: string, body: unknown): Promise<boolean> => {
    const roomId = sessionRef.current.roomId
    if (!roomId) return false
    const sealed = await sealDeltaMessage(body, to)
    if (!sealed) return false
    try {
      signalingRef.current?.sendE2ERelay({
        roomId,
        from: sessionRef.current.deviceId,
        to,
        data: { type, v: 1, sealed },
      })
      return true
    } catch {
      return false
    }
  }, [])

  /**
   * Find the NEWEST readable vault copy of `name` (disk-backed OPFS Blob —
   * no RAM copy). Newest-first so a re-send of v3 after v2 patches against
   * v2, not some older sibling.
   */
  const findVaultPriorFile = useCallback(async (name: string): Promise<Blob | null> => {
    try {
      const entries = await listVault() // newest first
      for (const e of entries) {
        if (e.verified === false) continue
        for (const f of e.files) {
          if (f.name !== name) continue
          const blob = await getVaultFileBlob(e, f)
          if (blob && blob.size > 0) return blob
        }
      }
    } catch { /* vault problems never break transfers */ }
    return null
  }, [])

  /** Bounded wait for DELTA_PLAN — resolved by onDeltaPlan, nulled on timeout. */
  const waitForDeltaPlan = (transferId: string, timeoutMs: number): Promise<DeltaPlanBody | null> =>
    new Promise((resolve) => {
      let settled = false
      const done = (b: DeltaPlanBody | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (deltaPlanWaitRef.current?.transferId === transferId) deltaPlanWaitRef.current = null
        resolve(b)
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      deltaPlanWaitRef.current = { transferId, resolve: done }
    })

  /**
   * RECEIVER, on manifest arrival — BEFORE any accept path (manual consent,
   * trusted auto-accept, resume auto-accept) so the sender swaps its chunk
   * source before a single byte streams. Bounded by DELTA_PLAN_WAIT_MS; on
   * timeout/decline we simply proceed with the normal (full-send) flow.
   */
  const negotiateDelta = useCallback(async (m: TransferManifest): Promise<void> => {
    // Sender devices never negotiate (their manifests are outgoing; a stray
    // inbound manifest on a sender is ignored here).
    if (filesRef.current.length > 0) return
    // A new transferId is in town — reset any previous negotiation state.
    deltaModeRef.current = null
    deltaPriorBlobRef.current = null
    const entry = m.files[0]
    // EDGE CASE: DELTA is single-file only. The sender never sets the flag on
    // multi-file manifests — this guard also keeps a hand-crafted/hostile
    // manifest from opting itself into delta.
    if (!entry?.deltaCandidate || m.files.length !== 1) return
    const senderId = peerDeviceIdRef.current
    const roomId = sessionRef.current.roomId
    if (!senderId || !roomId) return
    const declineNow = (): void => {
      // EDGE CASE: no vault prior (or unreadable) → DELTA_DECLINED so the
      // sender never waits — the full send is the default.
      void sendDeltaControl(senderId, DELTA_MSG.DECLINED, {
        transferId: m.transferId,
        fileIndex: 0,
      } satisfies DeltaDeclinedBody)
    }
    try {
      const prior = await findVaultPriorFile(entry.name)
      if (!prior) {
        declineNow()
        return
      }
      deltaPriorBlobRef.current = prior
      // Fingerprint the prior (main thread — blockHashes yields internally,
      // keeping the page responsive; no receiver-side status line exists for
      // manifest processing, so this stays UI-neutral by design).
      const blocks = await blockHashes(prior)
      if (blocks.length === 0) {
        declineNow()
        return
      }
      const sent = await sendDeltaControl(senderId, DELTA_MSG.HASHES, {
        transferId: m.transferId,
        fileIndex: 0,
        blocks,
        patchNote: `prior ${formatBytes(prior.size)}`,
      } satisfies DeltaHashesBody)
      if (!sent) return // E2E unavailable — silent full send
      // Plan wait: onDeltaPlan arms delta mode (or the timeout abandons it —
      // a late plan is still handled there defensively).
      await waitForDeltaPlan(m.transferId, DELTA_PLAN_WAIT_MS)
    } catch (err: any) {
      // Any negotiation failure → silent full send (decline best-effort so
      // the sender isn't left expecting hashes).
      console.log(`[FluxDrop] v5-a3w: delta negotiation abandoned: ${err?.message ?? err}`)
      declineNow()
    }
  }, [sendDeltaControl, findVaultPriorFile])

  /**
   * SENDER, on DELTA_HASHES — build the patch and (atomically) swap the
   * transfer's chunk source. Declines whenever anything is off; a decline is
   * always cheaper than a broken transfer.
   */
  const onDeltaHashes = useCallback(async (from: string, body: DeltaHashesBody) => {
    const m = manifestRef.current
    // EDGE CASE (ignored): DELTA for a stale/unknown transfer, or one that is
    // not EXACTLY one file — v5 delta is single-file only.
    if (!m || m.transferId !== body.transferId || filesRef.current.length !== 1) return
    const file = filesRef.current[0]
    if (!file) return
    const decline = (why: string): void => {
      console.log(`[FluxDrop] v5-a3w: delta declined (${why}) — full send`)
      void sendDeltaControl(from, DELTA_MSG.PLAN, {
        transferId: m.transferId,
        fileIndex: 0,
        accepted: false,
        patchedSize: 0,
        patchDigest: '',
        originalSize: m.totalSize,
      } satisfies DeltaPlanBody)
    }
    // The pref may have been switched off since the manifest was built (a
    // resumed delta transfer re-rides its candidacy) — honor the live value.
    if (!usePrefsStore.getState().deltaSync) {
      decline('pref off')
      return
    }
    // EDGE CASE: streaming already began (the receiver accepted before this
    // message arrived — auto-accept paths race the hash computation) — the
    // ORIGINAL bytes are in flight; swapping now would corrupt the stream.
    if (deltaStreamingStarted()) {
      decline('streaming already started')
      return
    }
    // EDGE CASE: source too big to read fully into RAM for buildPatch.
    if (file.size > DELTA_SOURCE_MAX) {
      decline('source above 512 MiB')
      return
    }
    try {
      const fileBytes = new Uint8Array(await file.arrayBuffer())
      const { ops } = await buildPatch(fileBytes, body.blocks)
      const patchBlob = encodePatch(ops)
      const patchedSize = patchBlob.size
      // EDGE CASE: patch bigger than the guard → declined (full send). The
      // patch must clear min(256 MiB, 50% of the original) to be worth it.
      if (patchedSize > Math.min(DELTA_MAX_PATCH_BYTES, m.totalSize * 0.5)) {
        decline(`patch ${patchedSize}B exceeds guard`)
        return
      }
      // patchDigest = SHA-256 hex of the patch Blob (≤ 256 MiB, so the hash
      // worker is preferred — keeps the main thread free).
      const patchDigest = await hashFileWorker(new File([patchBlob], 'fluxdrop-delta.bin'))
      // ATOMIC ENGAGE — no awaits from here on: re-check that streaming has
      // not begun (and the transfer is not terminal — the receiver may have
      // cancelled while we built), then swap the chunk source. JS is
      // single-threaded, so this check+swap pair cannot interleave with a
      // beginSending kickoff.
      if (deltaStreamingStarted()) {
        decline('streaming started during build')
        return
      }
      {
        const stNow = useTransferStore.getState().transferState
        if (stNow === 'CANCELLED' || stNow === 'FAILED' || stNow === 'ERROR') {
          // EDGE CASE: the transfer died while the patch was building —
          // promise orphans are fine, an armed plan for a dead transfer is not.
          decline('transfer terminal')
          return
        }
      }
      const totalChunks = computeTotalChunks(patchedSize, m.chunkSize)
      deltaPlanRef.current = { transferId: m.transferId, patchBlob, patchedSize, patchDigest, totalChunks }
      deltaModeActiveMirror = true
      // Sender-side progress totals → the patch stream (consistent %).
      const prevChunks = transferRef.current.chunksAcked
      const prevBytes = Math.min(transferRef.current.bytesTransferred, patchedSize)
      transferRef.current.resetProgress(totalChunks, patchedSize)
      // A re-negotiation (receiver reload) that arrives while nothing acked is
      // the common case; if progress existed, re-seed it (deterministic patch
      // → same stream) instead of silently zeroing the sender's counter.
      if (prevChunks > 0 && prevBytes > 0) transferRef.current.seedProgress(prevChunks, prevBytes)
      void sendDeltaControl(from, DELTA_MSG.PLAN, {
        transferId: m.transferId,
        fileIndex: 0,
        accepted: true,
        patchedSize,
        patchDigest,
        originalSize: m.totalSize,
      } satisfies DeltaPlanBody)
      console.log(
        `[FluxDrop] v5-a3w: delta plan armed — ${formatBytes(m.totalSize)} → ${formatBytes(patchedSize)} patch ` +
          `(${Math.round((1 - patchedSize / Math.max(1, m.totalSize)) * 100)}% saved)`
      )
    } catch (err: any) {
      // EDGE CASE: build failure → declined (full send). Any delta failure is
      // a silent full send — the transfer itself must never be at risk.
      decline(`build failed: ${err?.message ?? err}`)
    }
  }, [sendDeltaControl])

  /**
   * RECEIVER, on DELTA_PLAN — arm delta mode (chunks become the PATCH stream)
   * and re-target the progress totals. Declined plans are a no-op: default
   * mode IS the full send.
   */
  const onDeltaPlan = useCallback((from: string, body: DeltaPlanBody) => {
    // Plans are receiver-side; a sender never arms delta mode (EDGE CASE:
    // echoed/misdirected plans to a device with queued files are ignored).
    if (filesRef.current.length > 0) return
    const m = manifestRef.current
    // EDGE CASE (ignored): DELTA for a stale/unknown transfer or a
    // non-single-file manifest.
    if (!m || m.transferId !== body.transferId || m.files.length !== 1) return
    // Unblock the pre-accept negotiation wait when it belongs to this transfer.
    const wait = deltaPlanWaitRef.current
    if (wait && wait.transferId === m.transferId) {
      deltaPlanWaitRef.current = null
      wait.resolve(body)
    }
    // EDGE CASE: terminal transfer (e.g. the sender cancelled mid-build and
    // the plan raced the cancel notice) — resolve the wait, never arm. Read
    // the LIVE store (transferRef snapshots can lag a render).
    {
      const stNow = useTransferStore.getState().transferState
      if (stNow === 'CANCELLED' || stNow === 'FAILED' || stNow === 'ERROR' || stNow === 'COMPLETE') return
    }
    // EDGE CASE: declined (patch over guard / build failure / streaming race)
    // → full send. Default mode is the full send — nothing to arm.
    if (!body.accepted) return
    // Already armed for this exact stream (re-negotiation, same digest) —
    // re-arming would wipe the receiver's progress; the stream is identical.
    const already = deltaModeRef.current
    if (already && already.transferId === m.transferId && already.patchDigest === body.patchDigest) return
    // Resume determinism: if the digest recorded for this in-progress
    // transfer changed, the prior file (or the sender's source) changed — the
    // stored patch-stream chunks are garbage. RESET the progress/bitmap for a
    // fresh start of the NEW patch stream.
    const recorded = readDeltaRecord(m.transferId)
    if (recorded && recorded.patchDigest !== body.patchDigest) {
      console.warn('[FluxDrop] v5-a3w: delta patch digest changed — resetting stored progress for a fresh patch stream')
      receiverBuffersRef.current.clear()
      flushedChunkIdsRef.current = new Set()
      // The resume-skip bitmap sources from the record's chunksAcked —
      // emptying it makes the sender re-send the whole NEW patch stream.
      void updateTransferRecord(m.transferId, (rec) => (rec ? { ...rec, chunksAcked: [] } : null))
    }
    const patchChunks = computeTotalChunks(body.patchedSize, m.chunkSize)
    deltaModeRef.current = {
      transferId: m.transferId,
      patchDigest: body.patchDigest,
      patchedSize: body.patchedSize,
      originalSize: body.originalSize,
      totalChunks: patchChunks,
      // The prior the hashes were computed from. Missing (vault evicted
      // between hashes and plan) → an empty Blob: every readBlock fails and
      // reconstruction aborts loudly rather than writing a corrupt file.
      priorBlob: deltaPriorBlobRef.current ?? new Blob(),
    }
    deltaModeActiveMirror = true
    writeDeltaRecord(m.transferId, { patchDigest: body.patchDigest, patchedSize: body.patchedSize })
    // Receiver-side progress totals → the patch stream (the manifest keeps
    // the ORIGINAL size — verification targets it).
    const heldChunks = transferRef.current.chunksAcked
    const heldBytes = Math.min(transferRef.current.bytesTransferred, body.patchedSize)
    transferRef.current.resetProgress(patchChunks, body.patchedSize)
    // Pathological ordering (plan raced the first chunks over the DC): the
    // already-acked chunk indices ARE patch-stream indices — re-seed them so
    // the counter never restarts mid-stream.
    if (heldChunks > 0 && heldBytes > 0) transferRef.current.seedProgress(heldChunks, heldBytes)
    console.log(
      `[FluxDrop] v5-a3w: delta mode armed — ${formatBytes(body.originalSize)} → ${formatBytes(body.patchedSize)} on the wire`
    )
  }, [])

  /** Router for delta frames arriving over the opaque e2e-relay envelope. */
  const handleDeltaSignaling = useCallback(async (payload: { from: string; data: unknown }): Promise<void> => {
    const envelope = payload?.data as { type?: unknown; sealed?: unknown } | null | undefined
    if (!envelope || typeof envelope.sealed !== 'string') return
    const from = payload.from
    if (envelope.type === DELTA_MSG.HASHES) {
      const body = await unsealDeltaMessage<DeltaHashesBody>(envelope.sealed, from)
      if (body) await onDeltaHashes(from, body)
    } else if (envelope.type === DELTA_MSG.PLAN) {
      const body = await unsealDeltaMessage<DeltaPlanBody>(envelope.sealed, from)
      if (body) onDeltaPlan(from, body)
    } else if (envelope.type === DELTA_MSG.DECLINED) {
      const body = await unsealDeltaMessage<DeltaDeclinedBody>(envelope.sealed, from)
      // EDGE CASE: receiver declined (no vault prior). Full send is the
      // default; disarm any live plan for THIS transfer so a later resume
      // leg never streams a patch the receiver can't reconstruct. (A running
      // loop is unaffected — it captured its plan at start.)
      if (body) {
        console.log(`[FluxDrop] v5-a3w: receiver declined delta (${body.transferId.slice(0, 8)}) — full send`)
        if (deltaPlanRef.current?.transferId === body.transferId) {
          deltaPlanRef.current = null
          deltaModeActiveMirror = false
        }
      }
    }
  }, [onDeltaHashes, onDeltaPlan])

  // ================= v5-c6: pull mode handlers =================

  /**
   * RECEIVER: a sealed library offer arrived. Validated + stored in the
   * session store — the receiver panel swaps "Waiting for sender" for the
   * browse UI. A second offer (sender re-offer after reconnect) supersedes.
   */
  const onLibraryOffer = useCallback(async (from: string, body: PullOfferBody): Promise<void> => {
    try {
      if (!body || typeof body.libraryId !== 'string' || !Array.isArray(body.files)) return
      if (body.files.length === 0 || body.files.length > PULL_MAX_FILES) return
      const files: PullFileEntry[] = []
      for (const f of body.files) {
        if (!f || typeof f.name !== 'string' || !Number.isInteger(f.i)) continue
        files.push({
          i: f.i,
          name: f.name.slice(0, 255),
          relativePath: typeof f.relativePath === 'string' ? f.relativePath.slice(0, 512) : f.name,
          size: Number.isFinite(f.size) ? f.size : 0,
          type: typeof f.type === 'string' ? f.type : 'application/octet-stream',
          lastModified: Number.isFinite(f.lastModified) ? f.lastModified : 0,
        })
      }
      if (files.length === 0) return
      useSessionStore.getState().setPendingLibrary({ libraryId: body.libraryId, files, fromDeviceId: from })
      transferRef.current.clearLibraryPreviews()
      console.log(`[FluxDrop] v5-c6: library offer received — ${files.length} files browsable from ${from.slice(0, 8)}`)
      toast.success('Shared library available', {
        description: `${files.length} file${files.length !== 1 ? 's' : ''} — browse and pick what you want.`,
      })
    } catch (err: any) {
      console.warn('[FluxDrop] v5-c6: library offer rejected:', err?.message ?? err)
    }
  }, [])

  /**
   * SENDER: the receiver picked files. Builds the REAL manifest from exactly
   * the requested subset (hashing only what was picked) and pushes it over
   * the open DataChannel — from here the NORMAL transfer flow takes over
   * (consent on older receivers, pull-expect auto-accept on v5 ones).
   * First request wins; the room stays single-request by design (v5).
   */
  const onLibraryRequest = useCallback(async (from: string, body: PullRequestBody): Promise<void> => {
    const lib = pullLibraryRef.current
    if (!lib) return
    if (!body || body.libraryId !== lib.id || !Array.isArray(body.indices)) return
    if (manifestRef.current) {
      console.log('[FluxDrop] v5-c6: pull request ignored — a transfer is already active (single-request rooms in v5)')
      return
    }
    const peer = senderPeersRef.current.get(from)
    const rtc = peerRtcsRef.current.get(from)
    if (!peer || !rtc?.isOpen) {
      console.warn('[FluxDrop] v5-c6: pull request from a peer with no open channel — ignored')
      return
    }
    // Dedupe + bounds-check the indices against the library.
    const picked = [...new Set(body.indices)]
      .map((i) => Number(i))
      .filter((i) => Number.isInteger(i) && i >= 0 && i < lib.files.length)
      .map((i) => lib.files[i])
    if (picked.length === 0) return
    try {
      toast.info('Receiver picked files — hashing…', {
        description: `${picked.length} file${picked.length !== 1 ? 's' : ''} · ${formatBytes(picked.reduce((s, f) => s + f.size, 0))}`,
      })
      // VALIDATING renders the sender's HashingProgress card while the
      // picked subset is fingerprinted (same UI as a normal fresh send).
      transferRef.current.setTransferState('VALIDATING')
      const compress = shouldCompressTransfer(picked, sessionRef.current.compressionEnabled)
      const m = await buildManifest(picked, (progress) => {
        transferRef.current.setHashingProgress({
          current: progress.current,
          total: progress.total,
          fileName: progress.fileName,
        })
      }, compress ? 'gzip' : undefined)
      transferRef.current.setHashingProgress(null)
      wireCompressionRef.current = compress ? 'gzip' : undefined
      // CRITICAL: the send loop reads bytes from filesRef (via the slice
      // plan's fileIndex) — it MUST be rebound to the picked subset or the
      // manifest's indices would address the WRONG library files (found in
      // E2E: c-a.txt's bytes went out under c-b.txt's checksum).
      filesRef.current = picked
      manifestRef.current = m
      slicePlanRef.current = buildSlicePlan(m)
      transferRef.current.setManifest(m)
      transferRef.current.resetProgress(m.totalChunks, m.totalSize)
      transferRef.current.setTransferState('MANIFEST_EXCHANGE')
      // Resume support from here on, like any fresh send.
      void saveSenderFiles(m.transferId, picked)
      skipIndicesRef.current = new Set()
      resumeSkipUsedRef.current = false
      resumeAttemptsRef.current = 0
      // Send the manifest to the requester (E2E-sealed like the DC-open path).
      peer.enc = isE2EActive(from)
      if (peer.enc) {
        const encBody = await encryptWirePayload(new TextEncoder().encode(JSON.stringify(m)), 'manifest', from)
        if (rtc.isOpen) rtc.sendManifestEncrypted(m.transferId, encBody)
        console.log(`[FluxDrop] v5-c6: pulled manifest sent ENCRYPTED to ${from.slice(0, 8)} (${picked.length} files)`)
      } else if (rtc.isOpen) {
        rtc.sendManifest(m.transferId, m)
      }
    } catch (err: any) {
      console.error('[FluxDrop] v5-c6: pull request failed:', err?.message ?? err)
      transferRef.current.setHashingProgress(null)
      transferRef.current.setTransferState('ERROR')
      transferRef.current.setError(`Pull request failed: ${err?.message ?? err}`)
      playError()
    }
  }, [])

  /** Router for pull frames arriving over the opaque e2e-relay envelope. */
  const handlePullSignaling = useCallback(async (payload: { from: string; data: unknown }): Promise<void> => {
    const envelope = payload?.data as { type?: unknown; sealed?: unknown } | null | undefined
    if (!envelope || typeof envelope.sealed !== 'string') return
    const from = payload.from
    if (envelope.type === PULL_MSG.OFFER) {
      const body = await unsealDeltaMessage<PullOfferBody>(envelope.sealed, from)
      if (body) await onLibraryOffer(from, body)
    } else if (envelope.type === PULL_MSG.REQUEST) {
      const body = await unsealDeltaMessage<PullRequestBody>(envelope.sealed, from)
      if (body) await onLibraryRequest(from, body)
    }
  }, [onLibraryOffer, onLibraryRequest])

  /**
   * RECEIVER public API: send the picked library indices to the sender.
   * Arms pullExpectRef — the arriving manifest must match the selection
   * name+size-wise to be auto-accepted (a substituted manifest falls back
   * to the normal consent dialog).
   */
  const requestLibraryFiles = useCallback(async (indices: number[]): Promise<boolean> => {
    const lib = useSessionStore.getState().pendingLibrary
    const senderId = lib?.fromDeviceId ?? peerDeviceIdRef.current
    if (!lib || !senderId || indices.length === 0) return false
    const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < lib.files.length)
    if (valid.length === 0) return false
    pullExpectRef.current = new Set(valid.map((i) => `${lib.files[i].name}:${lib.files[i].size}`))
    const sent = await sendPullControl(senderId, PULL_MSG.REQUEST, {
      libraryId: lib.libraryId,
      indices: valid,
    } satisfies PullRequestBody)
    if (!sent) {
      pullExpectRef.current = null
      toast.error('Could not send the request', { description: 'The encrypted control channel is unavailable.' })
      return false
    }
    // The browse UI goes away; the (auto-accepted) manifest is imminent.
    useSessionStore.getState().setPendingLibrary(null)
    transferRef.current.clearLibraryPreviews()
    transferRef.current.setTransferState('MANIFEST_EXCHANGE')
    const totalBytes = valid.reduce((s, i) => s + lib.files[i].size, 0)
    toast.success('Request sent', {
      description: `${valid.length} file${valid.length !== 1 ? 's' : ''} · ${formatBytes(totalBytes)} — the sender is preparing them.`,
    })
    console.log(`[FluxDrop] v5-c6: pull request sent — ${valid.length} files (${formatBytes(totalBytes)})`)
    return true
  }, [sendPullControl])

  /**
   * RECEIVER public API: ask the sender for image thumbs of the first
   * PREVIEW_MAX_FILES image entries (libraryId doubles as the routing id).
   */
  const requestLibraryPreviews = useCallback((): void => {
    const lib = useSessionStore.getState().pendingLibrary
    const rtc = getRtc()
    if (!lib || !rtc?.isOpen) return
    const wanted = lib.files
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => (f.type || '').toLowerCase().startsWith('image/'))
      .slice(0, PREVIEW_MAX_FILES)
    if (wanted.length === 0) return
    const body = JSON.stringify({
      v: 1,
      files: wanted.map(({ i }) => ({ i, bytes: PREVIEW_HEAD_BYTES })),
    })
    const sent = rtc.sendRawFrame(MessageType.PREVIEW_REQ, lib.libraryId, 0, new TextEncoder().encode(body))
    if (!sent) return
    libraryPreviewsWaitingRef.current = true
    if (libraryPreviewTimerRef.current) clearTimeout(libraryPreviewTimerRef.current)
    libraryPreviewTimerRef.current = setTimeout(() => {
      libraryPreviewsWaitingRef.current = false
      libraryPreviewTimerRef.current = null
    }, PREVIEW_WAIT_MS)
  }, [])

  // ================= v1.3 (6.1): fan-out aggregate helpers =================

  /** Push one peer's live progress into the transfer store (roster UI). */
  const syncPeerProgress = useCallback((peer: SenderPeer) => {
    const m = manifestRef.current
    if (!m) return
    const alias = sessionRef.current.peers.find((p) => p.id === peer.id)?.alias ?? 'device'
    transferRef.current.setPeerProgress({
      deviceId: peer.id,
      alias,
      acked: Math.min(m.totalChunks, peer.acked.size + peer.skip.size),
      total: m.totalChunks,
      state: peer.completed ? 'complete' : peer.accepted ? 'transferring' : 'pairing',
    })
  }, [])

  /**
   * Count a chunk into the AGGREGATE progress once every peer REQUIRED for
   * this transfer holds it (acked or skipped). Dropped peers don't block.
   * With one receiver this is exactly the old per-ack behavior.
   */
  const tryAggregateChunk = useCallback((chunkIndex: number) => {
    const m = manifestRef.current
    if (!m) return
    if (!chunkAckVotersRef.current.has(chunkIndex)) return
    for (const id of requiredPeersRef.current) {
      const p = senderPeersRef.current.get(id)
      if (!p) continue // dropped — no longer required
      if (!p.acked.has(chunkIndex) && !p.skip.has(chunkIndex)) return // missing somewhere
    }
    chunkAckVotersRef.current.delete(chunkIndex)
    const resolved = resolveChunk(slicePlanRef.current, chunkIndex, m.chunkSize)
    const bytes = resolved?.totalLength ?? m.chunkSize
    const isNew = transferRef.current.ackChunk(chunkIndex, bytes)
    if (isNew && resolved) {
      for (const seg of resolved.segments) {
        transferRef.current.addFileBytes(seg.fileIndex, seg.length)
      }
    }
    void markChunkAcked(m.transferId, chunkIndex)
  }, [])

  /** Re-aggregate after a peer departs: chunks it was blocking may complete. */
  const recomputeAggregateAfterDrop = useCallback(() => {
    const pending = [...chunkAckVotersRef.current.keys()]
    for (const idx of pending) tryAggregateChunk(idx)
  }, [tryAggregateChunk])

  /** One receiver finished verification — complete globally when all did. */
  const markPeerCompleted = useCallback((peerId: string) => {
    const peer = senderPeersRef.current.get(peerId)
    if (!peer || peer.completed) return
    peer.completed = true
    syncPeerProgress(peer)
    resumeAttemptsRef.current = 0
    console.log(`[FluxDrop] Peer ${peerId.slice(0, 8)} verified the transfer`)
    const required = [...requiredPeersRef.current]
    const allDone = required.length > 0 && required.every((id) => senderPeersRef.current.get(id)?.completed)
    if (!allDone) {
      const done = required.filter((id) => senderPeersRef.current.get(id)?.completed).length
      if (required.length > 1) {
        toast.success(`Device ${done}/${required.length} verified`, { duration: 4000 })
      }
      return
    }
    // Global completion (idempotent with the DC-ack path).
    const alreadyComplete = transferRef.current.transferState === 'COMPLETE'
    transferRef.current.setTransferState('COMPLETE')
    if (alreadyComplete) return
    playSuccess()
    for (let fi = 0; fi < (manifestRef.current?.files.length ?? 0); fi++) {
      transferRef.current.markFileComplete(fi)
    }
    // v5-a3w: delta completion — record the bandwidth the patch saved
    // (originalSize - patchedSize; the receiver sets its own copy from the
    // plan body at its finish). Both sides badge the summary card from it.
    const dPlan = deltaPlanRef.current
    if (dPlan && dPlan.transferId === manifestRef.current?.transferId) {
      transferRef.current.setDeltaSavedBytes(Math.max(0, manifestRef.current.totalSize - dPlan.patchedSize))
      deltaModeActiveMirror = false
    }
    void persistTransferRecord('sender', 'COMPLETE', { checksumVerified: true })
    void flushAllPendingAcks()
    const m = manifestRef.current
    if (m) void deleteSenderFiles(m.transferId)
    toast.success('Transfer complete & verified!', {
      description: m
        ? `${m.files.length} file${m.files.length > 1 ? 's' : ''} · ${formatBytes(m.totalSize)} delivered to ${required.length} device${required.length > 1 ? 's' : ''}`
        : undefined,
    })
    const notifEnabled = useSessionStore.getState().notificationsEnabled
    if (notifEnabled && typeof document !== 'undefined' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification('FluxDrop — Transfer complete', {
          body: m ? `${m.files.length} file${m.files.length > 1 ? 's' : ''} · ${formatBytes(m.totalSize)} verified` : 'All files verified',
          icon: '/logo.svg',
        })
        setTimeout(() => n.close(), 8000)
        n.onclick = () => { window.focus(); n.close() }
      } catch { /* ignore */ }
    }
  }, [persistTransferRecord, syncPeerProgress])

  /** Sender-side cleanup when a device leaves the room mid-transfer. */
  const handlePeerDeparture = useCallback((deviceId: string) => {
    if (filesRef.current.length === 0) return // receiver side — resume paths handle it
    const peer = senderPeersRef.current.get(deviceId)
    if (!peer) return
    peer.active = false
    try { peer.rtc?.close() } catch { /* ignore */ }
    peerRtcsRef.current.delete(deviceId)
    // v5-a1: a departed peer's lanes are orphans — tear them all down. (The
    // capability entry stays: the same device may re-join and re-pair, and
    // only a fresh pairing-request refreshes it.)
    teardownFastLanes(deviceId)
    // v5-a2: its relay leg is an orphan too.
    teardownRelay(deviceId)
    senderPeersRef.current.delete(deviceId)
    requiredPeersRef.current.delete(deviceId)
    transferRef.current.removePeerProgress(deviceId)
    recomputeAggregateAfterDrop()
    const st = transferRef.current.transferState
    const anyActive = [...senderPeersRef.current.values()].some((p) => p.active && (relayModeRef.current.has(p.id) || !!p.rtc?.isOpen))
    if (!anyActive && (st === 'TRANSFERRING' || st === 'PAUSED')) {
      transferRef.current.setTransferState('RESUMING')
      toast.warning('All receivers left the room', {
        description: 'Waiting for a device to re-join — progress is kept and the transfer resumes automatically.',
      })
    } else if (st === 'TRANSFERRING' || st === 'PAUSED') {
      toast.info('A receiver left — continuing to the remaining devices')
    }
  }, [recomputeAggregateAfterDrop])

  // ====================================================================
  // v5-a2: SERVER-RELAYED FALLBACK TRANSPORT — the last rung of the recovery
  // ladder. Engages ONLY where transferState would become FAILED (retry
  // budget / resume budget exhausted) and P2P is provably impossible. When
  // P2P works, everything below is dead weight: relayModeRef stays empty and
  // the send loop never takes the relay branch.
  //
  // Encryption: the send loop seals every chunk with AES-256-GCM under the
  // per-peer PAKE key BEFORE it reaches any transport (see encryptWirePayload
  // in beginSending) — the relay carries opaque ciphertext. Engagement is
  // therefore hard-gated on isE2EActive(peerId): a relayed transfer can never
  // downgrade a session to plaintext.
  // ====================================================================

  /**
   * v5-a2: close + forget the relay transport(s). One peer, or the whole map
   * when `peerId` is omitted. Terminal states, cancel, cleanup, peer
   * departure and a restored P2P path all funnel through here.
   */
  const teardownRelay = useCallback((peerId?: string) => {
    const ids = peerId ? [peerId] : [...relayModeRef.current.keys()]
    for (const id of ids) {
      const t = relayModeRef.current.get(id)
      relayModeRef.current.delete(id)
      try { t?.close() } catch { /* ignore */ }
    }
  }, [])

  /**
   * v5-a2: put ONE peer into relay mode. Returns false (untouched state) when
   * any gate fails: pref off, no room, signaling down, no manifest, no relay
   * capability advertisement, or no active E2E session (chunks must be
   * ciphertext before we ever hand them to a server relay). A peer that is
   * ALREADY relaying reports true immediately — with a rewind + loop re-kick,
   * so a re-entered ladder (resume exhaustion while relaying) restarts the
   * stream instead of failing.
   */
  const engageRelayForPeer = useCallback((peerId: string, why: string): boolean => {
    const m = manifestRef.current
    const roomId = sessionRef.current.roomId
    if (!peerId || !m || !roomId || !signalingRef.current?.isConnected) return false
    const already = relayModeRef.current.has(peerId)
    if (!already) {
      if (peerCapsRef.current.get(peerId)?.relay !== true) return false
      // Hard crypto gate — see the subsystem comment above.
      if (!isE2EActive(peerId)) return false

      const transport = new RelayTransport(signalingRef.current, {
        roomId,
        deviceId: sessionRef.current.deviceId,
        peerDeviceId: peerId,
        transferId: m.transferId,
      })
      transport.onAck((chunkIndex) => {
        // v5-a2: exact mirror of the DC CHUNK_ACK bookkeeping (chunk-index
        // based, transport-agnostic).
        if (resumeAttemptsRef.current > 0) {
          resumeAttemptsRef.current = 0
          toast.success('Connection restored — transfer resumed')
        }
        const peer = senderPeersRef.current.get(peerId)
        if (peer) {
          if (!peer.acked.has(chunkIndex)) {
            peer.acked.add(chunkIndex)
            if (!chunkAckVotersRef.current.has(chunkIndex)) {
              chunkAckVotersRef.current.set(chunkIndex, new Set())
            }
            syncPeerProgress(peer)
          }
          tryAggregateChunk(chunkIndex)
        }
      })
      transport.onFatal((reason) => {
        // The relay itself died — the ladder is out of rungs. Fail for real.
        console.error(`[FluxDrop] v5-a2 relay transport fatal: ${reason}`)
        teardownRelay(peerId)
        playError()
        transferRef.current.setTransferState('FAILED')
        transferRef.current.setError(`Server relay failed — ${reason}`)
        void persistTransferRecord('sender', 'FAILED')
        toast.error('Relay fallback failed', { description: reason, duration: 10000 })
      })
      relayModeRef.current.set(peerId, transport)
    }

    // Fan-out entry for the relay leg: no PC exists (rtc: null) — the send
    // loop treats the relay transport as this peer's ONLY transport.
    // `accepted` is NOT forced true: a mid-transfer fallback peer keeps its
    // consent, while a forced (dev-hook) fresh leg waits for the receiver's
    // transfer-accepted over signaling — chunks never precede the manifest.
    let peer = senderPeersRef.current.get(peerId)
    if (!peer) {
      peer = {
        id: peerId,
        rtc: null,
        active: true,
        nextPos: 0,
        skip: new Set(),
        skipCount: 0,
        acked: new Set(),
        enc: true, // the E2E gate above guarantees the encrypted framing
        accepted: false,
        skipQueryPending: false,
        completedSent: false,
        completed: false,
      }
      senderPeersRef.current.set(peerId, peer)
    }
    if (!requiredPeersRef.current.has(peerId)) requiredPeersRef.current.add(peerId)
    // Rewind to the first chunk this peer doesn't hold: chunks that died
    // in-flight with the DC are re-sent over relay (the receiver's ackChunk
    // dedupes by index, so overlap is harmless). A fresh (forceNext) leg has
    // an empty acked set → starts at 0 naturally.
    {
      const held = new Set([...peer.acked, ...peer.skip])
      const order = sendOrderRef.current
      let pos = 0
      while (pos < order.length && held.has(order[pos])) pos++
      peer.nextPos = pos
    }

    // UI + state: TRANSFERRING (the send loop continues from the rewound
    // position — the resume bitmap semantics already track what's unsent).
    transferRef.current.setRelayed(true)
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    resumeAttemptsRef.current = 0
    if (!already) {
      console.log(`[FluxDrop] v5-a2 relay engaged for peer ${peerId.slice(0, 8)} (${why})`)
      toast.info(
        t(usePrefsStore.getState().locale, 'relay.engaged', 'P2P unreachable — relaying through server (end-to-end encrypted)'),
        { duration: 8000 }
      )
    }
    // Restart the send loop from the rewound position (generation bump
    // supersedes any loop still wedged in a dead-channel waitForDrain). Only
    // when the peer already consented — a fresh (forced) leg starts streaming
    // from the receiver's transfer-accepted event instead, mirroring the DC
    // MANIFEST_ACK handshake.
    if (peer.accepted) {
      sendLoopGenRef.current++
      sendingRef.current = false
      void beginSendingRef.current?.()
    }
    return true
  }, [persistTransferRecord, syncPeerProgress, tryAggregateChunk, teardownRelay])

  /**
   * v5-a2: the FAILED-site interception. Called at every recovery-ladder
   * exhaustion point BEFORE transferState becomes FAILED — engages relay for
   * every still-required peer that can relay; returns true when at least one
   * leg engaged (caller then skips the FAILED transition).
   */
  const tryEngageRelayFallback = useCallback((why: string): boolean => {
    if (!usePrefsStore.getState().relayFallback) return false
    const targets = new Set<string>(requiredPeersRef.current)
    if (peerDeviceIdRef.current) targets.add(peerDeviceIdRef.current)
    let engaged = false
    for (const peerId of targets) {
      if (engageRelayForPeer(peerId, why)) engaged = true
    }
    return engaged
  }, [engageRelayForPeer])

  /**
   * v5-a2: manifest over SIGNALING for a relay-mode leg with no DataChannel
   * (forced-relay / dev-hook path). Sealed with the PAKE session key
   * (enc1.<hex> — same envelope format e2e.ts ships for signaling payloads);
   * the receiver's anti-downgrade guard accepts sealed manifests only. Control
   * NEVER rides the chunk relay itself.
   */
  const sendManifestViaSignaling = useCallback(async (peerId: string) => {
    const m = manifestRef.current
    const roomId = sessionRef.current.roomId
    if (!m || !roomId) return
    if (!senderPeersRef.current.has(peerId)) return
    // engageRelayForPeer guarantees E2E here; the wait is a defensive belt.
    if (!isE2EActive(peerId)) await waitForE2EActive(3500, peerId)
    if (!isE2EActive(peerId)) return
    try {
      const sealed = await encryptJsonForSignaling(m, 'manifest')
      signalingRef.current?.sendTransferManifest({
        roomId,
        from: sessionRef.current.deviceId,
        to: peerId,
        manifest: sealed,
      })
      console.log(`[FluxDrop] v5-a2 manifest sent SEALED over signaling to ${peerId.slice(0, 8)} (relay mode)`)
    } catch (err: any) {
      // Fail CLOSED — never send a plaintext manifest while E2E is expected.
      console.error('[FluxDrop] v5-a2 manifest sealing failed:', err?.message)
      playError()
      transferRef.current.setTransferState('ERROR')
      transferRef.current.setError('Encryption failed — transfer aborted')
      void persistTransferRecord('sender', 'ERROR')
    }
  }, [persistTransferRecord])

  // ---- Connect to signaling server ----
  // silent=true suppresses the connect/disconnect toasts (used for the
  // proactive mount-time connection; user-initiated flows stay verbose).
  const connect = useCallback((silent = false) => {
    if (signalingRef.current) return
    silentConnectRef.current = silent
    const sig = new FluxDropSignaling({
      onConnect: () => {
        sessionRef.current.setSignalingConnected(true)
        if (!silentConnectRef.current) toast.success('Connected to FluxDrop network')
      },
      onDisconnect: () => {
        sessionRef.current.setSignalingConnected(false)
        if (!silentConnectRef.current) toast.warning('Disconnected from signaling server')
      },
      onConnectError: (err) => {
        sessionRef.current.setSignalingConnected(false)
        if (!silentConnectRef.current) toast.error('Signaling connection failed', { description: err.message })
      },
      onRoomCreated: (payload) => {
        sessionRef.current.setRoom({
          id: payload.roomId,
          joinCode: payload.joinCode,
          pin: payload.pin ?? null,
          qrData: payload.qrData ?? null,
        })
        // v1.1: capture rejoin identity — sender knows its own PIN here.
        sig.setRoomId(payload.roomId, {
          deviceId: sessionRef.current.deviceId,
          alias: sessionRef.current.alias,
          role: 'sender',
          pin: payload.pin ?? undefined,
        })
        toast.success(`Room ${payload.roomId} created`)
      },
      onRoomJoined: (payload) => {
        sessionRef.current.setRoom({
          id: payload.roomId,
          joinCode: payload.joinCode,
          pin: null,
          qrData: null,
        })
        // v1.1: capture rejoin identity — the PIN the receiver typed is kept
        // in receiverPinRef (set in startReceive) for the re-add path.
        sig.setRoomId(payload.roomId, {
          deviceId: sessionRef.current.deviceId,
          alias: sessionRef.current.alias,
          role: 'receiver',
          pin: receiverPinRef.current ?? undefined,
        })
        // Save to recent rooms for quick-join next time.
        const peerAlias = payload.peers?.[0]?.alias ?? 'Unknown'
        addRecentRoom({ roomId: payload.roomId, peerAlias, joinedAt: Date.now() })
        if (payload.peers?.length) {
          // v1.3 (6.1): a room can hold several receivers — the whole roster
          // is shown, but we only PAIR with the sender.
          const senderPeer = payload.peers.find((p: any) => p.role === 'sender') ?? payload.peers[0]
          for (const p of payload.peers) {
            sessionRef.current.addPeer({ id: p.id, alias: p.alias, role: p.role })
          }
          peerDeviceIdRef.current = senderPeer.id
          // v5-a1: capability negotiation — the receiver advertises
          // { fastLanes: true } on the pairing request it sends right after
          // joining. The signaling server relays pairing-request payloads
          // verbatim (verified: relayToDevice emits the payload object as-is),
          // so no server change is needed. A plain-object VARIABLE (not a
          // literal) is used so TypeScript's excess-property check for fresh
          // literals doesn't reject the extra field against sendPairingRequest's
          // narrower signature.
          // v5-a2: `relay: true` added — advertises the server-relay fallback
          // capability (chunk relay through the signaling service).
          const pairingReq: {
            roomId: string
            from: string
            to: string
            capabilities: { fastLanes: boolean; relay: boolean }
          } = {
            roomId: payload.roomId,
            from: sessionRef.current.deviceId,
            to: peerDeviceIdRef.current!,
            capabilities: { fastLanes: true, relay: true }, // v5 build marker
          }
          sig.sendPairingRequest(pairingReq)
        }
        toast.success(`Joined room ${payload.roomId}`)
      },
      onRoomExpired: () => {
        toast.warning('Room expired', { description: 'The pairing window timed out.' })
        sessionRef.current.clearRoom()
      },
      onRoomClosed: () => {
        toast.warning('Room closed')
        sessionRef.current.clearRoom()
      },
      onDeviceDiscovered: (payload) => {
        sessionRef.current.addPeer({ id: payload.device.id, alias: payload.device.alias, role: payload.device.role })
        // v1.3 (6.1): only a SENDER takes over the primary-peer pointer — a
        // second receiver joining our room must not steal it (the receiver
        // addresses control frames to its sender, not to sibling receivers).
        if (payload.device.role === 'sender' || filesRef.current.length > 0) {
          peerDeviceIdRef.current = payload.device.id
        }
        // v5-c7: kiosk ordering — a RECEIVER that joined an EMPTY room (the
        // kiosk mints + joins before any sender claims it) must pair when
        // the sender ARRIVES, not only at join time. onRoomJoined only fires
        // the pairing request when the sender was already present; this is
        // the late-arrival mirror (same capability advertisement, guarded so
        // a sender never pairs to itself and an already-paired leg stays put).
        if (
          payload.device.role === 'sender' &&
          filesRef.current.length === 0 &&
          !!sessionRef.current.roomId &&
          !peerRtcsRef.current.has(payload.device.id)
        ) {
          peerDeviceIdRef.current = payload.device.id
          const pairingReqLate: {
            roomId: string
            from: string
            to: string
            capabilities: { fastLanes: boolean; relay: boolean }
          } = {
            roomId: sessionRef.current.roomId!,
            from: sessionRef.current.deviceId,
            to: payload.device.id,
            capabilities: { fastLanes: true, relay: true }, // v5 build marker
          }
          sig.sendPairingRequest(pairingReqLate)
          console.log(`[FluxDrop] v5-c7: sender arrived after join — pairing request sent to ${payload.device.id.slice(0, 8)}`)
        }
        toast.info(`${payload.device.alias} joined the room`)
      },
      onDeviceLeft: (payload) => {
        sessionRef.current.removePeer(payload.deviceId)
        // v1.3 (6.1): sender-side — the peer stops being required; the
        // aggregate progress re-computes and the scheduler moves on.
        handlePeerDeparture(payload.deviceId)
        if (peerDeviceIdRef.current === payload.deviceId && !peerRtcsRef.current.has(payload.deviceId)) {
          // Keep the pointer if another peer is still live (receiver keeps
          // its sender; sender keeps its last live receiver for signaling).
          const remaining = [...peerRtcsRef.current.keys()]
          peerDeviceIdRef.current = remaining[remaining.length - 1] ?? null
        }
        toast.warning('Peer disconnected')
      },
      onPairingRequest: (payload: { from: string; transferSummary?: TransferSummary; capabilities?: { fastLanes?: boolean; relay?: boolean } }) => {
        // v5-a1: store the receiver's advertised capabilities. No
        // advertisement (older peer) → the entry is REMOVED so lanes are
        // never offered to that peer — the hard backwards rule.
        // v5-a2: the same rule gates the relay fallback — an unadvertising
        // peer never receives relayed chunks either.
        if (payload?.capabilities?.fastLanes === true || payload?.capabilities?.relay === true) {
          peerCapsRef.current.set(payload.from, {
            fastLanes: payload.capabilities.fastLanes === true,
            relay: payload.capabilities.relay === true,
          })
        } else {
          peerCapsRef.current.delete(payload.from)
        }
        // Sender receives pairing request from a receiver -> auto-accept &
        // initiate a DEDICATED WebRTC connection for this peer (v1.3 groups:
        // one offer per receiver; several can pair into the same room).
        if (!peerDeviceIdRef.current) peerDeviceIdRef.current = payload.from
        // perf/resume-1: a pairing-request means the receiver just (RE-)joined
        // the room — a reloaded page has NO in-memory E2E session, so any
        // stale session we still hold for this peer is a trap: the manifest
        // would be encrypted with a key the receiver no longer has ("Encrypted
        // manifest arrived but the key exchange did not complete"). Reset the
        // per-peer session so a FRESH handshake runs. Same-page resumes never
        // send pairing-request (rejoin-room only rebinds the socket), so their
        // surviving sessions stay untouched.
        resetE2ESession(payload.from)
        // v1.2: kick off the per-peer E2E (PAKE) handshake as soon as pairing
        // starts — it runs over the signaling relay in parallel with ICE
        // negotiation, so the session key is usually ready before the
        // DataChannel opens.
        startSenderE2EHandshake(payload.from)
        // v1.1: revive a sender session that died in FAILED/ERROR from a
        // connection loss. A peer re-pairing with us (same room, still alive
        // on the signaling server) means there is someone to talk to again —
        // re-enter the resume path instead of silently ignoring them.
        {
          const stRevive = transferRef.current.transferState
          if (
            (stRevive === 'FAILED' || stRevive === 'ERROR') &&
            filesRef.current.length > 0 &&
            manifestRef.current
          ) {
            console.log('[FluxDrop] Re-paired after failure — reviving transfer as resume')
            resumeAttemptsRef.current = 0
            transferRef.current.setTransferState('RESUMING')
          }
        }
        sessionRef.current.setPairingInProgress(true)
        sessionRef.current.setPairingAccepted(true)
        sessionRef.current.setPairingInProgress(false)
        // v5-a2 dev hook: forceNext consumed HERE — skip PC creation entirely
        // and go straight to the server relay (E2E handshake already kicked
        // off above; the manifest follows SEALED over signaling once the PAKE
        // session activates). One-shot: the flag clears whether or not relay
        // engages (falling back to normal P2P when a gate fails).
        if (forceRelayNextRef.current) {
          forceRelayNextRef.current = false
          const relayPeerId = payload.from
          console.log('[FluxDrop] v5-a2 dev hook: forceNext — skipping PC creation, going straight to relay')
          void (async () => {
            await waitForE2EActive(5000, relayPeerId)
            if (!engageRelayForPeer(relayPeerId, 'dev forceNext')) {
              console.warn('[FluxDrop] v5-a2 forceNext could not engage relay — falling back to normal P2P')
              void initiateWebRTCAsSender(relayPeerId)
              return
            }
            await sendManifestViaSignaling(relayPeerId)
          })()
          return
        }
        void initiateWebRTCAsSender(payload.from)
      },
      onPairingConfirm: (payload) => {
        sessionRef.current.setPairingInProgress(false)
        sessionRef.current.setPairingAccepted(payload.accepted)
      },
      onPairingReject: (payload) => {
        sessionRef.current.setPairingInProgress(false)
        sessionRef.current.setPairingAccepted(false)
        toast.error('Pairing rejected', { description: payload.reason ?? 'Peer declined' })
      },
      onWebRtcOffer: (payload) => {
        peerDeviceIdRef.current = payload.from
        // v5-a1: lane-tagged offers (lane >= 1) go to a DEDICATED lane PC on
        // the receiver — they never enter handleOfferAsReceiver, so the
        // SDP-origin in-place-answer logic can only ever match PRIMARY offer
        // traffic (no cross-contamination with ICE restarts).
        if (typeof payload.lane === 'number' && payload.lane >= 1) {
          void handleLaneOfferAsReceiver(payload.from, payload.lane, payload.sdp)
          return
        }
        void handleOfferAsReceiver(payload.sdp)
      },
      onWebRtcAnswer: (payload) => {
        // v5-a1: lane-tagged answers land on that lane instance only.
        if (typeof payload.lane === 'number' && payload.lane >= 1) {
          const laneRec = fastLaneRtcsRef.current.get(payload.from)?.find((l) => l.lane === payload.lane)
          if (laneRec) void laneRec.rtc.acceptAnswer(payload.sdp)
          return
        }
        getRtc(payload.from)?.acceptAnswer(payload.sdp)
      },
      onWebRtcIce: (payload) => {
        // v5-a1: ICE trickle tagged with a lane routes to that lane instance;
        // absent/zero (legacy) stays on the primary.
        if (typeof payload.lane === 'number' && payload.lane >= 1) {
          const laneRec = fastLaneRtcsRef.current.get(payload.from)?.find((l) => l.lane === payload.lane)
          if (laneRec) void laneRec.rtc.addIceCandidate(payload.candidate)
          return
        }
        getRtc(payload.from)?.addIceCandidate(payload.candidate)
      },
      onTransferManifest: (payload) => {
        peerDeviceIdRef.current = payload.from
        // v5-a2: relay-mode manifests arrive SEALED over signaling (enc1.<hex>
        // AES-GCM envelope under the PAKE key) — the DataChannel is dead by
        // definition on this path. Decrypt, freeze the encrypted-wire
        // expectation, then run the standard accept pipeline. The plaintext
        // anti-downgrade guard below never sees sealed envelopes.
        if (isEncryptedSignalingPayload((payload as { manifest?: unknown })?.manifest)) {
          void (async () => {
            try {
              const m = await decryptJsonFromSignaling(payload.manifest as string, 'manifest')
              if (!m) return
              e2eWireRef.current = true
              console.log('[FluxDrop] v5-a2 sealed manifest received over signaling — decrypted OK')
              void handleIncomingManifest(m as TransferManifest)
            } catch (err: any) {
              console.warn('[FluxDrop] v5-a2 sealed signaling manifest failed to decrypt:', err?.message)
            }
          })()
          return
        }
        // v1.2 anti-downgrade: once E2E is expected (enabled + handshake in
        // flight or active), a PLAINTEXT manifest over signaling is either a
        // legacy peer or an injected fake — drop it and wait for the real
        // (encrypted) DataChannel manifest instead.
        if (
          useSessionStore.getState().e2eEnabled &&
          (isE2EActive(payload.from) || e2eHandshakesRef.current.has(payload.from) || receiverPinRef.current)
        ) {
          console.warn('[FluxDrop] Ignoring plaintext manifest via signaling while E2E is expected')
          return
        }
        void handleIncomingManifest(payload.manifest)
      },
      onTransferAccepted: (payload) => {
        // v1.3 (6.1): `from` is the receiver that accepted. Mark THAT peer
        // accepted; the fan-out scheduler kicks off on the first acceptor.
        // v5-b4: the acceptor's session grants (chat/clipboard) are recorded
        // here — absent grants (older receiver) default to allow.
        if (payload.accepted) {
          const peerId = payload.from
          if (peerId) recordIncomingGrants(peerId, payload.grants)
          if (peerId && senderPeersRef.current.has(peerId)) {
            senderPeersRef.current.get(peerId)!.accepted = true
            if (!requiredPeersRef.current.has(peerId) && senderPeersRef.current.size > 0 && transferRef.current.transferState !== 'TRANSFERRING') {
              requiredPeersRef.current.add(peerId)
            }
          }
          const acceptors = [...senderPeersRef.current.values()].filter((p) => p.accepted).length
          toast.success(`Transfer accepted${acceptors > 1 ? ` by ${acceptors} devices` : ''}`)
          // v5-a1: kick the fast-lane trigger at ACCEPT time — the earliest
          // moment the manifest, the single-receiver shape and the peer's
          // capability are all known AND the transfer is about to stream.
          // Starting here (vs. at beginSending's TRANSFERRING flip) gives
          // lane ICE+DTLS the whole transfer duration to complete; on
          // LAN-speed links the wire can otherwise outrun the handshake.
          void maybeStartFastLanes()
          void beginSendingRef.current?.()
        } else {
          toast.error('Transfer rejected', { description: payload.reason ?? 'Receiver declined' })
          transferRef.current.setTransferState('FAILED')
        }
      },
      onTransferComplete: (payload) => {
        // Signaling-relayed completion (fires on the peer of whoever sent it).
        // SENDER: `from` is a receiver announcing its verified completion —
        // v1.3 marks THAT peer done; the transfer globally completes when all
        // required receivers are done. Idempotent with the DC ack path.
        if (filesRef.current.length > 0 && payload?.from && senderPeersRef.current.has(payload.from)) {
          markPeerCompleted(payload.from)
          return
        }
        const alreadyComplete = transferRef.current.transferState === 'COMPLETE'
        // RECEIVER: never stamp COMPLETE without real verification. The sender
        // can announce completion while chunks are still in flight (DC send-
        // buffer drain lag) — routing through verifyReceiverTransfer runs the
        // assembly + checksum pipeline with its completeness poll. A previous
        // bug stamped verified=true here, producing FALSE completion records.
        if (!alreadyComplete && filesRef.current.length === 0 && manifestRef.current) {
          void verifyReceiverTransferRef.current?.()
          return
        }
        transferRef.current.setTransferState('COMPLETE')
        if (!alreadyComplete) {
          playSuccess()
          void persistTransferRecord(filesRef.current.length > 0 ? 'sender' : 'receiver', 'COMPLETE', { checksumVerified: true })
          const m = manifestRef.current
          // Sender files were persisted for history-resume; done means done.
          if (m && filesRef.current.length > 0) void deleteSenderFiles(m.transferId)
          toast.success('Transfer complete!', {
            description: m
              ? `${m.files.length} file${m.files.length > 1 ? 's' : ''} · ${formatBytes(m.totalSize)} verified`
              : 'All files verified',
          })
          // Browser notification for background tabs (respects user preference)
          const notifEnabled = sessionRef.current.notificationsEnabled
          if (notifEnabled && typeof document !== 'undefined' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            try {
              const n = new Notification('FluxDrop — Transfer complete', {
                body: m ? `${m.files.length} file${m.files.length > 1 ? 's' : ''} · ${formatBytes(m.totalSize)} verified` : 'All files verified',
                icon: '/logo.svg',
              })
              setTimeout(() => n.close(), 8000)
              n.onclick = () => { window.focus(); n.close() }
            } catch { /* ignore */ }
          }
        }
      },
      onTransferCancel: (payload) => {
        transferRef.current.setTransferState('CANCELLED')
        transferRef.current.setError(payload.reason ?? 'Transfer cancelled')
        playError()
        // Persist received chunks so a later resume can skip them.
        flushReceiverBuffers()
        void persistTransferRecord(filesRef.current.length > 0 ? 'sender' : 'receiver', 'CANCELLED')
        toast.error('Transfer cancelled', { description: payload.reason })
      },
      onResumeRequest: (payload) => {
        // perf/resume-1: the receiver is the ICE ANSWERER — it cannot rebuild
        // the transport itself. A resume-request over signaling is its only
        // way to wake the sender up, so treat it as a recovery trigger, not
        // just a bitmap handshake.
        const rtcWake = getRtc(payload.from)
        if (!rtcWake || !rtcWake.isOpen) {
          // Our DataChannel to this receiver is gone — revive the transport.
          // The in-place ICE restart keeps everything else alive; the heavy
          // teardown+re-offer path (attemptResume) is the fallback.
          console.log(`[FluxDrop] Resume request from ${payload.from.slice(0, 8)} — transport down, recovering`)
          toast.info('Receiver asks to resume — reconnecting…', { duration: 4000 })
          void performIceRestartRef.current(payload.from).then((ok) => {
            if (!ok) {
              transferRef.current.setTransferState('RESUMING')
              void attemptResumeRef.current()
            }
          })
          return
        }
        if (rtcWake.iceConnectionState !== 'connected') {
          // Channel object alive but the transport dropped — restart ICE in
          // place; queued control frames complete once it revives.
          void performIceRestartRef.current(payload.from)
        }
        toast.info('Receiver reconnected — negotiating resume…')
        // v1.1: use the same bitmap handshake as the DataChannel path. A raw
        // "last chunk index" is meaningless as a send-order position, and only
        // genuinely-missing chunks should travel anyway.
        resumeSkipPendingRef.current = true
        if (resumeQueryTimerRef.current) clearTimeout(resumeQueryTimerRef.current)
        resumeQueryTimerRef.current = setTimeout(() => {
          if (!resumeSkipPendingRef.current) return
          resumeSkipPendingRef.current = false
          console.log('[FluxDrop] No resume-skip answer within 5s — sending from position 0')
          void beginSendingRef.current?.()
        }, 5000)
        getRtc(payload.from)?.sendResumeQuery(payload.transferId)
        // Legacy ack so the receiver's UI shows the resume was registered.
        getRtc(payload.from)?.sendResumeResponse(payload.transferId, true, payload.lastChunkIndex + 1)
      },
      onResumeResponse: (payload) => {
        if (payload.accepted) toast.success('Resume acknowledged')
        else {
          toast.error('Resume denied')
          transferRef.current.setTransferState('FAILED')
        }
      },
      onE2ERelay: (payload) => {
        // v5-a3w: delta control messages ride the SAME opaque e2e-relay
        // envelope (server forwards `data` verbatim — zero server changes).
        // PAKE frames stay plaintext-by-design (the handshake derives the
        // sealing key); delta frames are sealed enc1.<hex> bodies, split out
        // by their data.type so the PAKE switch above stays untouched.
        // v5-c6: pull-mode control messages use the same sealed envelope.
        const dtype = (payload as { data?: { type?: unknown } } | null | undefined)?.data as
          | { type?: unknown }
          | undefined
        if (
          typeof dtype?.type === 'string' &&
          (dtype.type === DELTA_MSG.HASHES || dtype.type === DELTA_MSG.PLAN || dtype.type === DELTA_MSG.DECLINED)
        ) {
          void handleDeltaSignaling(payload)
          return
        }
        if (
          typeof dtype?.type === 'string' &&
          (dtype.type === PULL_MSG.OFFER || dtype.type === PULL_MSG.REQUEST)
        ) {
          void handlePullSignaling(payload)
          return
        }
        void handleE2ERelayPayload(payload)
      },
      onSignalingError: (payload) => {
        toast.error(`Signaling error: ${payload.code}`, { description: payload.message })
      },
    })
    sig.connect()
    signalingRef.current = sig
    // ── v5-f19: leaderboard bridge ── the speedrun dialog talks through the
    // page's single signaling session via window CustomEvents (same pattern
    // as the library-preview bridge). Responses come back as
    // 'fluxdrop:leaderboard-data'.
    const offLeaderboardData = sig.onLeaderboardData((payload: unknown) => {
      window.dispatchEvent(new CustomEvent('fluxdrop:leaderboard-data', { detail: payload }))
    })
    leaderboardTeardownRef.current = () => {
      offLeaderboardData()
      window.removeEventListener('fluxdrop:leaderboard-fetch', onLeaderboardFetchRef.current!)
      window.removeEventListener('fluxdrop:leaderboard-submit', onLeaderboardSubmitRef.current!)
    }
    onLeaderboardFetchRef.current = () => sig.sendLeaderboardFetch()
    onLeaderboardSubmitRef.current = (ev: Event) => {
      const d = (ev as CustomEvent<{ alias?: string; timeMs?: number; sizeBytes?: number; timeline?: number[] }>).detail
      if (!d || typeof d.timeMs !== 'number') return
      sig.sendLeaderboardSubmit({
        alias: String(d.alias ?? 'racer'),
        timeMs: d.timeMs,
        sizeBytes: Number(d.sizeBytes) || 0,
        ...(Array.isArray(d.timeline) ? { timeline: d.timeline } : {}),
      })
    }
    window.addEventListener('fluxdrop:leaderboard-fetch', onLeaderboardFetchRef.current)
    window.addEventListener('fluxdrop:leaderboard-submit', onLeaderboardSubmitRef.current)
    // ── v5-f18: chaos flake ── a flaky profile forces periodic unexpected
    // transport drops; socket.io reconnects + rejoin-room rebinds (that
    // recovery ladder IS the thing under test). Test-only, session-scoped.
    const chaosNow = activeChaosProfile()
    if (chaosNow?.flakeEveryMs) {
      chaosStartFlake(() => sig.simulateDrop())
    }
    // v5-a2: the page-lifetime relay receiver — every inbound relay-data
    // frame routes through the SAME ingest as the DataChannel CHUNK_ENC path
    // (decrypt → gunzip → processReceivedChunk). The receiver itself sends
    // the transport-level relay-ack, so the engine never DC-acks a relay
    // chunk (a dead primary's sendChunkAck no-ops on a closed channel).
    relayReceiverRef.current?.dispose()
    relayReceiverRef.current = createRelayReceiver(sig, {
      onChunk: (chunkIndex, bytes, meta) => {
        const m = manifestRef.current
        // Unknown transferId / no active transfer with that peer → ignore
        // (mid-recovery races, post-completion stragglers, other rooms).
        if (!m || !meta || meta.transferId !== m.transferId) return
        if (meta.from !== peerDeviceIdRef.current) return
        const stR = transferRef.current.transferState
        if (stR === 'CANCELLED' || stR === 'FAILED' || stR === 'ERROR' || stR === 'COMPLETE') return
        if (!transferRef.current.relayed) transferRef.current.setRelayed(true)
        relayLastChunkAtRef.current = Date.now()
        // Synthesize the DC CHUNK_ENC frame and reuse the exact ingest —
        // fromRtc omitted: processReceivedChunk's sendChunkAck lands on the
        // (dead) primary and no-ops, while the relay receiver already sent
        // the transport-level relay-ack itself.
        void handleDataChannelMessage(
          { type: MessageType.CHUNK_ENC, chunkIndex, payload: bytes },
          meta.from,
          null
        )
      },
    })
  }, [persistTransferRecord, flushReceiverBuffers])

  // Proactively connect to signaling on mount (silent — no toast). Signaling only
  // carries pairing metadata, this makes the header badge truthful ("Online"), and
  // deep-link joins start negotiating instantly instead of waiting for a flow.
  useEffect(() => {
    connect(true)
  }, [connect])

  // ---- Diagnostics polling (ICE candidate pair + bytes) ----
  const diagnosticsRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startDiagnosticsPolling = useCallback(() => {
    if (diagnosticsRef.current) clearInterval(diagnosticsRef.current)
    diagnosticsRef.current = setInterval(async () => {
      // v1.3: poll the first OPEN peer connection (any of them reports the
      // local transport stats meaningfully).
      const rtc = [...peerRtcsRef.current.values()].find((p) => p.isOpen) ?? null
      if (!rtc) return
      const stats = await rtc.getStats()
      sessionRef.current.setDiagnostics(stats)
    }, 2000)
  }, [])
  const stopDiagnosticsPolling = useCallback(() => {
    if (diagnosticsRef.current) {
      clearInterval(diagnosticsRef.current)
      diagnosticsRef.current = null
    }
    sessionRef.current.setDiagnostics(null)
  }, [])

  // ---- Connection failure → retry with exponential backoff ----
  const handleConnectionFailure = useCallback((role: 'sender' | 'receiver') => {
    const currentRetry = sessionRef.current.retryCount
    if (currentRetry >= CONSTANTS.CONNECT_RETRY_MAX) {
      // v5-a2: retry budget exhausted — the server relay is the LAST rung
      // before FAILED. Sender-side only (the receiver cannot drive recovery);
      // tryEngageRelayFallback gates on the pref, the peer's relay
      // capability and the E2E session, and flips the transfer back to
      // TRANSFERRING when it engages.
      if (role === 'sender' && filesRef.current.length > 0 && tryEngageRelayFallback('connection retries exhausted')) {
        sessionRef.current.setRetryCount(0)
        return
      }
      transferRef.current.setTransferState('FAILED')
      transferRef.current.setError(`Connection failed after ${CONSTANTS.CONNECT_RETRY_MAX} retries`)
      toast.error('Connection failed permanently', {
        description: `Exceeded ${CONSTANTS.CONNECT_RETRY_MAX} retry attempts. Check your network or configure a TURN server.`,
        action: {
          label: 'Retry',
          onClick: () => {
            sessionRef.current.setRetryCount(0)
            if (role === 'sender') {
              // v1.1: revive through the resume path (same as attemptResume).
              if (manifestRef.current && filesRef.current.length > 0) {
                transferRef.current.setTransferState('RESUMING')
              }
              // v1.3: re-offer to every known receiver.
              const targets = new Set<string>(requiredPeersRef.current)
              if (peerDeviceIdRef.current) targets.add(peerDeviceIdRef.current)
              if (targets.size > 0) {
                for (const t of targets) void initiateWebRTCAsSender(t)
              } else {
                transferRef.current.setTransferState('FAILED')
              }
            }
          },
        },
      })
      return
    }
    const delay = CONSTANTS.CONNECT_RETRY_BASE_MS * Math.pow(2, currentRetry)
    sessionRef.current.setRetryCount(currentRetry + 1)
    transferRef.current.setTransferState('RETRYING')
    toast.warning(`Connection retry ${currentRetry + 1}/${CONSTANTS.CONNECT_RETRY_MAX}`, {
      description: `Waiting ${(delay / 1000).toFixed(1)}s before retry…`,
    })
    setTimeout(() => {
      if (role === 'sender') {
        const targets = new Set<string>(requiredPeersRef.current)
        if (peerDeviceIdRef.current) targets.add(peerDeviceIdRef.current)
        // perf/resume-1: an in-place ICE restart may have revived a peer
        // during the backoff window — re-offering now would tear down a LIVE
        // connection. Skip recovered peers and restart the stream instead.
        const liveTargets = [...targets].filter((t) => {
          const r = peerRtcsRef.current.get(t)
          return !!r && r.isOpen && r.connectionState === 'connected'
        })
        if (
          liveTargets.length > 0 &&
          transferRef.current.transferState !== 'FAILED' &&
          manifestRef.current
        ) {
          console.log('[FluxDrop] Connection recovered during backoff — skipping re-offer')
          transferRef.current.setTransferState('TRANSFERRING')
          void beginSendingRef.current?.()
          return
        }
        // v1.3: retry re-offers to every known receiver.
        if (targets.size > 0) {
          for (const t of targets) void initiateWebRTCAsSender(t)
        } else {
          transferRef.current.setTransferState('FAILED')
          toast.error('No receiver to reconnect to')
        }
      }
      // Receiver can't re-initiate (waits for sender offer); just reset state.
      else {
        transferRef.current.setTransferState('CONNECTING')
      }
    }, delay)
  }, [])

  // ---- perf/resume-1: receiver → sender resume poke over signaling ----
  // The receiver cannot re-offer (it is the ICE answerer). When its stream
  // stalls with a dead channel, this is the ONLY lever it has: ask the sender
  // to recover. Rate-limited (10s) and capped (12 pokes ≈ 2 min) so an
  // unreachable sender is surfaced as FAILED instead of poked forever.
  const pokeSenderForResume = useCallback((why: string) => {
    const senderId = peerDeviceIdRef.current
    const m = manifestRef.current
    if (!senderId || !m || !sessionRef.current.roomId) return
    const now = Date.now()
    if (now - receiverLastPokeAtRef.current < 10_000) return
    if (receiverPokeCountRef.current >= 12) return
    receiverPokeCountRef.current++
    receiverLastPokeAtRef.current = now
    console.log(`[FluxDrop] Receiver poke ${receiverPokeCountRef.current}/12 (${why}) — asking sender to resume`)
    signalingRef.current?.sendResumeRequest({
      roomId: sessionRef.current.roomId,
      from: sessionRef.current.deviceId,
      to: senderId,
      transferId: m.transferId,
      lastChunkIndex: Math.max(0, transferRef.current.chunksAcked - 1),
    })
  }, [])

  // ---- Real resume: attempt to reconnect after DataChannel loss ----
  // On DC close during TRANSFERRING, persist state and try to restart ICE.
  // The sender re-creates the offer; the receiver re-answers.
  // After reconnection, the receiver sends RESUME_REQUEST with the last
  // acked chunk index, and the sender resumes from there.
  const attemptResume = useCallback(async () => {
    const m = manifestRef.current
    if (!m) return

    // v5-a1: a full teardown+re-offer is coming — lanes never survive a
    // resume transition (their chunk traffic belongs to the dead session;
    // the re-pair re-offers via initiateWebRTCAsSender and fresh lanes spin
    // once the transfer is TRANSFERRING again).
    teardownFastLanes()

    // v1.1: bounded automatic retries with exponential backoff. The DC-close
    // → re-offer path already existed; what was missing was a cap — an
    // unreachable peer used to loop resume attempts forever.
    if (resumeAttemptsRef.current >= RESUME_ATTEMPT_MAX) {
      // v5-a2: resume budget exhausted — the LAST rung before FAILED is the
      // server relay. Sender-side only (the receiver waits for the sender to
      // drive recovery; its own watchdog paths handle that side).
      if (filesRef.current.length > 0 && tryEngageRelayFallback('resume attempts exhausted')) {
        return
      }
      transferRef.current.setTransferState('FAILED')
      transferRef.current.setError(`Connection lost — resume failed after ${RESUME_ATTEMPT_MAX} attempts`)
      playError()
      await persistTransferRecord(filesRef.current.length > 0 ? 'sender' : 'receiver', 'FAILED')
      toast.error('Could not reconnect', {
        description: `Resume failed after ${RESUME_ATTEMPT_MAX} attempts. Your progress is saved — retry to continue from where it stopped.`,
        duration: 15000,
        action: {
          label: 'Retry',
          onClick: () => {
            resumeAttemptsRef.current = 0
            if (filesRef.current.length > 0) {
              // v1.1: re-enter the resume path so the DC-open handler runs the
              // bitmap handshake (a raw restart from FAILED would no-op).
              transferRef.current.setTransferState('RESUMING')
              const targets = new Set<string>(requiredPeersRef.current)
              if (peerDeviceIdRef.current) targets.add(peerDeviceIdRef.current)
              for (const t of targets) void initiateWebRTCAsSender(t)
            }
          },
        },
      })
      return
    }
    const attempt = ++resumeAttemptsRef.current
    const backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 8000)

    console.log(`[FluxDrop] Attempting resume after DataChannel loss (attempt ${attempt}/${RESUME_ATTEMPT_MAX})...`)
    toast.info(`Connection lost — resuming (attempt ${attempt}/${RESUME_ATTEMPT_MAX})…`, { duration: 5000 })

    // Persist current state for resume (preserve existing acked chunks!).
    const isSender = filesRef.current.length > 0
    // Persist any in-memory received chunks so the resumed re-send can skip them.
    flushReceiverBuffers()
    await persistTransferRecord(isSender ? 'sender' : 'receiver', 'RESUMING')

    // Exponential backoff before reconnection attempt (2s → 4s → 8s).
    await new Promise((r) => setTimeout(r, backoffMs))

    // Check if we still have a signaling connection.
    if (!signalingRef.current?.isConnected) {
      // Reconnect to signaling first.
      connect()
      await new Promise((r) => setTimeout(r, 3000))
    }

    // If we have a room ID and peers, try to re-establish WebRTC (v1.3: to
    // EVERY required receiver — each gets a fresh offer).
    if (sessionRef.current.roomId && (peerDeviceIdRef.current || senderPeersRef.current.size > 0)) {
      if (isSender) {
        // Sender: re-initiate WebRTC per peer (new offer with ICE restart).
        try {
          const targets = new Set<string>(requiredPeersRef.current)
          if (peerDeviceIdRef.current) targets.add(peerDeviceIdRef.current)
          if (targets.size === 0) {
            transferRef.current.setTransferState('FAILED')
            toast.error('Cannot resume — no receiver available')
            return
          }
          for (const peerId of targets) {
            void initiateWebRTCAsSender(peerId)
          }
          toast.info('Reconnecting to peer...', { duration: 3000 })
        } catch (err: any) {
          console.warn('[FluxDrop] Resume failed:', err.message)
          transferRef.current.setTransferState('FAILED')
          toast.error('Resume failed', { description: err.message })
        }
      } else {
        // Receiver: wait for the sender to re-offer.
        // The sender's new offer will trigger handleOfferAsReceiver.
        toast.info('Waiting for sender to reconnect...', { duration: 3000 })
      }
    } else {
      transferRef.current.setTransferState('FAILED')
      toast.error('Cannot resume — no room or peer available')
    }
  }, [connect, persistTransferRecord, flushReceiverBuffers])

  // Late-bound ref for attemptResume — connect()'s handlers (defined above)
  // reach it through this to avoid the temporal-dead-zone.
  useEffect(() => {
    attemptResumeRef.current = attemptResume
  }, [attemptResume])

  // ---- perf/resume-1: rung 1 of the recovery ladder — in-place ICE restart ----
  // An ICE restart rebuilds the transport on the SAME RTCPeerConnection: the
  // DataChannel/SCTP state survives and the receiver answers on its existing
  // PC (no teardown, no re-pair, no fresh manifest). attemptResume (full
  // teardown + re-offer) remains the heavy fallback for a dead DataChannel.
  const ICE_RESTART_MAX = 3
  const performIceRestart = useCallback(async (peerId: string): Promise<boolean> => {
    const rtc = peerRtcsRef.current.get(peerId)
    if (!rtc) return false
    const attempts = iceRestartAttemptsRef.current.get(peerId) ?? 0
    if (attempts >= ICE_RESTART_MAX) return false
    const last = iceRestartLastAtRef.current.get(peerId) ?? 0
    if (Date.now() - last < 6000) return false // one attempt per 6s max
    const offer = await rtc.createIceRestartOffer()
    if (!offer) return false
    iceRestartAttemptsRef.current.set(peerId, attempts + 1)
    iceRestartLastAtRef.current.set(peerId, Date.now())
    try {
      signalingRef.current?.sendOffer({
        roomId: sessionRef.current.roomId!,
        from: sessionRef.current.deviceId,
        to: peerId,
        sdp: offer,
      })
      console.log(`[FluxDrop] ICE restart offer sent to ${peerId.slice(0, 8)} (attempt ${attempts + 1}/${ICE_RESTART_MAX})`)
      return true
    } catch {
      return false
    }
  }, [])
  useEffect(() => {
    performIceRestartRef.current = performIceRestart
  }, [performIceRestart])

  // perf/resume-1: dev-only diagnostics hook — lets the E2E test harness (and
  // power users in the dev console) force an ICE restart mid-transfer to prove
  // the recovery ladder works. Compiled out of production builds.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    ;(window as any).__fluxdropIce = {
      restart: (peerId?: string) => {
        const targets = peerId ? [peerId] : [...peerRtcsRef.current.keys()]
        return Promise.all(targets.map((t) => performIceRestartRef.current(t)))
      },
      peers: () =>
        [...peerRtcsRef.current.entries()].map(([id, r]) => ({
          id,
          isOpen: r.isOpen,
          conn: r.connectionState,
          ice: r.iceConnectionState,
        })),
    }
    return () => {
      delete (window as any).__fluxdropIce
    }
  }, [])

  // v5-a1: dev-only lane observability (mirrors __fluxdropIce above). Calling
  // window.__fluxdropLanes() returns
  //   { peers: [{ peerId, lanes: [{ lane, open, state, bytesSent,
  //                bytesReceived, bufferedAmount }] }] }
  // for E2E verification of the striping. Compiled out of production builds.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    ;(window as any).__fluxdropLanes = () => ({
      peers: [...fastLaneRtcsRef.current.entries()].map(([peerId, lanes]) => ({
        peerId,
        lanes: lanes.map((l) => ({
          lane: l.lane,
          open: l.rtc.isOpen,
          state: l.rtc.connectionState,
          bytesSent: l.bytesSent,
          bytesReceived: l.bytesReceived,
          bufferedAmount: l.rtc.bufferedAmount,
        })),
      })),
    })
    return () => {
      delete (window as any).__fluxdropLanes
    }
  }, [])

  // v5-a2: dev-only relay observability + E2E-test hook (mirrors
  // __fluxdropIce / __fluxdropLanes above).
  //   window.__fluxdropRelay.forceNext() — one-shot flag: the NEXT pairing
  //     skips PC creation entirely and goes straight to the server relay
  //     (auto-clears after a single use, engaged or not).
  //   window.__fluxdropRelay.status() — { forced, peers: [...] } for the
  //     orchestrator to assert the relay path engaged.
  // Compiled out of production builds.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    ;(window as any).__fluxdropRelay = {
      forceNext: () => {
        forceRelayNextRef.current = true
        console.log('[FluxDrop] v5-a2: forceNext armed — the next transfer skips P2P and relays via the server (one-shot)')
      },
      status: () => ({
        forced: forceRelayNextRef.current,
        peers: [...relayModeRef.current.entries()].map(([peerId, t]) => ({
          peerId,
          availableWindow: t.availableWindow(),
          bytesSent: t.bytesSent,
        })),
      }),
    }
    return () => {
      delete (window as any).__fluxdropRelay
    }
  }, [])

  // ---- Helper: get effective ICE servers ----
  // v1.1: async + TURN merge. User-configured custom servers win entirely;
  // otherwise short-lived auto-minted TURN credentials are appended as a
  // fallback (ICE still prefers direct host/srflx pairs). Any fetch failure
  // silently degrades to STUN-only, exactly the pre-v1.1 behavior.
  const getEffectiveIceServers = useCallback(async (): Promise<RTCIceServer[] | undefined> => {
    const s = sessionRef.current
    if (s.useCustomIce && s.customIceServers.length > 0) {
      return s.customIceServers.map((srv) => ({
        urls: srv.urls,
        username: srv.username || undefined,
        credential: srv.credential || undefined,
      }))
    }
    const turn = await fetchTurnCredentials()
    return mergeTurnIntoIceServers(undefined, turn, s.useTurnRelay)
  }, [])

  // ====================================================================
  // v5-a1: FAST LANES — additive multi-PC striping for single-receiver
  // large transfers. The primary (peerRtcsRef) is NEVER restructured; lanes
  // are extra RTCPeerConnections that only carry chunk payloads + their acks.
  // Trigger gates (maybeStartFastLanes): transfer TRANSFERRING, manifest
  // bigger than FAST_LANE_MIN_BYTES, pref fastLanes > 1, EXACTLY ONE receiver,
  // and the receiver advertised the fastLanes capability. fastLanes=1 (the
  // default) is a byte-identical legacy path — the only cost is one falsy
  // map lookup per chunk slot.
  // ====================================================================

  /** v5-a1: how long a dropped lane lingers before removal (self-heal window). */
  const FAST_LANE_GRACE_MS = 3000

  /**
   * v5-a1: apply the QoS cap as an AGGREGATE budget split across every live
   * transport of each peer (primary + lanes) so N parallel token buckets never
   * multiply the user's cap. Without lanes this is exactly the legacy call.
   */
  const applyQosCapSplit = useCallback((mbps: number) => {
    for (const peer of senderPeersRef.current.values()) {
      const lanes = fastLaneRtcsRef.current.get(peer.id)
      const per = mbps > 0 ? mbps / (1 + (lanes?.length ?? 0)) : null
      // v5-a2: relay-mode peers have no PC — the server bucket paces them.
      peer.rtc?.setQosCapMbps(per)
      for (const l of lanes ?? []) l.rtc.setQosCapMbps(per)
    }
    // No fan-out state (receiver side, or sender pre-pairing): the single
    // primary carries the full cap. (Sender PCs created before their first
    // DC-open already picked the cap up in the FluxDropWebRTC constructor.)
    if (senderPeersRef.current.size === 0) {
      getRtc()?.setQosCapMbps(mbps > 0 ? mbps : null)
    }
  }, [])

  /**
   * v5-a1: remove ONE lane — splice it out of the peer's lane array, clear its
   * grace timer and close its PC. `notify` shows the single muted toast (used
   * on the SENDER side only — the receiver has no lane UX).
   */
  const dropFastLane = useCallback((peerId: string, record: FastLane, notify: boolean) => {
    const lanes = fastLaneRtcsRef.current.get(peerId)
    if (lanes) {
      const i = lanes.indexOf(record)
      if (i >= 0) lanes.splice(i, 1)
      if (lanes.length === 0) fastLaneRtcsRef.current.delete(peerId)
    }
    if (record.graceTimer) {
      clearTimeout(record.graceTimer)
      record.graceTimer = null
    }
    try { record.rtc.close() } catch { /* ignore */ }
    // The QoS split changes with the transport count — re-assert it.
    applyQosCapSplit(usePrefsStore.getState().qosCapMbps)
    if (notify) {
      // ONE muted toast per lane drop; the transfer keeps flowing on the rest.
      const locale = usePrefsStore.getState().locale
      toast.info(
        t(locale, 'transfer.fastLaneDropped', 'Fast lane {n} dropped — continuing on remaining lanes').replace('{n}', String(record.lane)),
        { duration: 4000 }
      )
    }
  }, [])

  /**
   * v5-a1: tear down every lane (one peer, or the whole map when `peerId` is
   * omitted). Called from: cleanup, leave-room, transfer complete/cancel
   * (terminal states), peer departure, primary re-offer (attemptResume /
   * handleConnectionFailure via initiateWebRTCAsSender) and primary death.
   */
  const teardownFastLanes = useCallback((peerId?: string) => {
    const ids = peerId ? [peerId] : [...fastLaneRtcsRef.current.keys()]
    let touched = false
    for (const id of ids) {
      const lanes = fastLaneRtcsRef.current.get(id)
      if (!lanes) continue
      fastLaneRtcsRef.current.delete(id)
      touched = true
      for (const l of lanes) {
        if (l.graceTimer) {
          clearTimeout(l.graceTimer)
          l.graceTimer = null
        }
        try { l.rtc.close() } catch { /* ignore */ }
      }
    }
    if (touched) applyQosCapSplit(usePrefsStore.getState().qosCapMbps)
  }, [])

  /**
   * v5-a1: lane PC connection-state watcher. 'disconnected' often self-heals
   * and 'failed'/'closed' are terminal — every drop gets a 3 s grace before
   * removal; a revive ('connected') cancels the timer.
   */
  const laneConnState = useCallback((peerId: string, record: FastLane, state: RTCPeerConnectionState) => {
    if (state === 'connected') {
      if (record.graceTimer) {
        clearTimeout(record.graceTimer)
        record.graceTimer = null
      }
      return
    }
    if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      if (record.graceTimer) return
      record.graceTimer = setTimeout(() => {
        record.graceTimer = null
        // Muted toast on the sender only — the receiving side has no lane UX.
        dropFastLane(peerId, record, filesRef.current.length > 0)
      }, FAST_LANE_GRACE_MS)
    }
  }, [])

  /** v5-a1: a lane DataChannel opened — joins the striping rotation. */
  const laneOpened = useCallback((peerId: string, record: FastLane) => {
    const st = transferRef.current.transferState
    if (st !== 'TRANSFERRING' && st !== 'PAUSED') {
      // Lane DC opened after the transfer finished (or failed) — close
      // immediately so no zombie PC outlives the session.
      dropFastLane(peerId, record, false)
      return
    }
    console.log(`[FluxDrop] Fast lane ${record.lane} open — joining the striping rotation`)
  }, [])

  /**
   * v5-a1: a lane DataChannel closed — terminal (a closed DC never revives),
   * so drop without the grace window.
   */
  const laneClosed = useCallback((peerId: string, record: FastLane) => {
    dropFastLane(peerId, record, false)
  }, [])

  /**
   * v5-a1 (sender): spin up (fastLanes - 1) extra transports for the single
   * receiver, mirroring the primary's offer/ICE exchange with `lane`-tagged
   * signaling payloads. Payloads are passed as plain-object VARIABLES so the
   * extra `lane` field rides sendOffer/sendIce unchanged (TS excess-property
   * checks only apply to fresh literals; the server forwards payload objects
   * verbatim — verified in mini-services/signaling relayToDevice).
   */
  const maybeStartFastLanes = useCallback(async () => {
    const m = manifestRef.current
    const prefLanes = usePrefsStore.getState().fastLanes
    // fastLanes=1 → zero-overhead legacy path (one falsy check, nothing more).
    if (!m || prefLanes <= 1) return
    // Transfers below the threshold never spin lanes.
    if (m.totalSize <= FAST_LANE_MIN_BYTES) return
    // v5 bound: striping is single-receiver only. (A receiver joining later
    // gets no lanes — pickStripingTransport is per-peer and simply finds none.)
    if (senderPeersRef.current.size !== 1) return
    const peer = [...senderPeersRef.current.values()][0]
    if (!peer?.active || !peer.rtc?.isOpen) return
    // Capability: no advertisement → never send lane messages to that peer.
    if (peerCapsRef.current.get(peer.id)?.fastLanes !== true) return
    // Idempotency: a running loop (kick/restart) must not double the lanes.
    // Two triggers can race (accept-time + beginSending both fire within the
    // same tick) and BOTH pass a length check taken before the first
    // await — a synchronous in-flight marker is the only reliable guard
    // (the length>0 check stays as the steady-state fast path).
    if (laneSpinningRef.current.has(peer.id)) return
    if ((fastLaneRtcsRef.current.get(peer.id) ?? []).length > 0) return
    laneSpinningRef.current.add(peer.id)
    try {
    const roomId = sessionRef.current.roomId
    const deviceId = sessionRef.current.deviceId
    if (!roomId || !deviceId) return

    const wanted = Math.min(prefLanes, FAST_LANE_MAX) - 1
    const iceServers = await getEffectiveIceServers()
    const lanes: FastLane[] = []
    fastLaneRtcsRef.current.set(peer.id, lanes)
    console.log(
      `[FluxDrop] Fast lanes: opening ${wanted} extra lane(s) to ${peer.id.slice(0, 8)} ` +
      `(${formatBytes(m.totalSize)} > ${formatBytes(FAST_LANE_MIN_BYTES)} threshold)`
    )
    for (let n = 1; n <= wanted; n++) {
      // Cancel mid lane-negotiation must not leak PCs: verify the map entry
      // is still OURS before and after every await.
      if (fastLaneRtcsRef.current.get(peer.id) !== lanes) return
      const record = { lane: n, rtc: null, bytesSent: 0, bytesReceived: 0, graceTimer: null } as unknown as FastLane
      const laneRtc = new FluxDropWebRTC(
        {
          iceServers,
          channelLabel: `fluxdrop-lane${n}`,
          channelCount: 1, // a lane PC carries exactly ONE DataChannel
          onIceCandidate: (candidate) => {
            const ice = {
              roomId: sessionRef.current.roomId!,
              from: sessionRef.current.deviceId,
              to: peer.id,
              candidate,
              lane: n, // v5-a1: lane-tagged trickle
            }
            signalingRef.current?.sendIce(ice)
          },
          onConnectionStateChange: (state) => laneConnState(peer.id, record, state),
          onDataChannelOpen: () => laneOpened(peer.id, record),
          onDataChannelClose: () => laneClosed(peer.id, record),
          onDataChannelMessage: (msg) => {
            record.bytesReceived += msg?.payload?.byteLength ?? 0
            // Same ingest as the primary: CHUNK_ACK bookkeeping is
            // chunk-index-based and transport-agnostic. `fromRtc` makes the
            // receiver's ack-for-this-chunk ride THIS lane back.
            handleDataChannelMessage(msg, peer.id, laneRtc)
          },
          onError: (err) => {
            // Muted: lane errors never spam the primary error toasts.
            console.warn(`[FluxDrop] Fast lane ${n} error (muted):`, err.message)
          },
        },
        true
      )
      record.rtc = laneRtc
      lanes.push(record)
      if (fastLaneRtcsRef.current.get(peer.id) !== lanes) {
        try { laneRtc.close() } catch { /* ignore */ }
        return
      }
      try {
        const offer = await laneRtc.createOffer()
        if (fastLaneRtcsRef.current.get(peer.id) !== lanes) {
          try { laneRtc.close() } catch { /* ignore */ }
          return
        }
        const offerPayload = {
          roomId,
          from: deviceId,
          to: peer.id,
          sdp: offer,
          lane: n, // v5-a1: marks this as an extra-lane offer (>= 1)
        }
        signalingRef.current?.sendOffer(offerPayload)
      } catch (err: any) {
        console.warn(`[FluxDrop] Fast lane ${n} offer failed:`, err?.message)
        dropFastLane(peer.id, record, false)
      }
    }
    // Lanes change the per-transport QoS budget — re-split the cap.
    applyQosCapSplit(usePrefsStore.getState().qosCapMbps)
    } finally {
      // v5-a1 fix: release the in-flight marker on EVERY exit path (including
      // the guard-style early returns above — those return from inside the
      // try, so this finally always runs).
      laneSpinningRef.current.delete(peer.id)
    }
  }, [])

  /**
   * v5-a1 (receiver): a lane-tagged offer arrived. Creates a DEDICATED lane
   * PC (lane offers always mean NEW PCs — they never participate in the ICE
   * restart / in-place-answer ladder), attaches the SAME chunk ingest the
   * primary uses, and echoes the lane id on the answer + ICE trickle.
   */
  const handleLaneOfferAsReceiver = useCallback(async (senderId: string, lane: number, sdp: RTCSessionDescriptionInit) => {
    const st = transferRef.current.transferState
    // Only accept lanes while the transfer is still LIVE (TRANSFERRING or
    // VERIFYING — on fast links the wire finishes before lane ICE does, and
    // VERIFYING is seconds away from a lane still being useful for the tail
    // of the ACK drain). Mid-recovery/RESUMING/terminal → ignore: the
    // sender's own lane lifecycle tears its half down when the lane never
    // opens (3 s grace on its side).
    if ((st !== 'TRANSFERRING' && st !== 'VERIFYING') || !manifestRef.current) {
      console.warn(`[FluxDrop] Ignoring fast-lane ${lane} offer while ${st}`)
      return
    }
    const roomId = sessionRef.current.roomId
    const deviceId = sessionRef.current.deviceId
    if (!roomId || !deviceId) return
    // Duplicate lane id → close the old lane, accept the new one.
    const existing = fastLaneRtcsRef.current.get(senderId) ?? []
    const dup = existing.find((l) => l.lane === lane)
    if (dup) {
      console.warn(`[FluxDrop] Duplicate fast-lane ${lane} offer — replacing the old lane`)
      dropFastLane(senderId, dup, false)
    }
    const record = { lane, rtc: null, bytesSent: 0, bytesReceived: 0, graceTimer: null } as unknown as FastLane
    const laneRtc = new FluxDropWebRTC(
      {
        iceServers: await getEffectiveIceServers(),
        onIceCandidate: (candidate) => {
          const ice = {
            roomId: sessionRef.current.roomId!,
            from: sessionRef.current.deviceId,
            to: senderId,
            candidate,
            lane, // v5-a1: lane-tagged trickle (echoed)
          }
          signalingRef.current?.sendIce(ice)
        },
        onConnectionStateChange: (state) => laneConnState(senderId, record, state),
        onDataChannelOpen: () => laneOpened(senderId, record),
        onDataChannelClose: () => laneClosed(senderId, record),
        onDataChannelMessage: (msg) => {
          record.bytesReceived += msg?.payload?.byteLength ?? 0
          // SAME ingest as the primary offer path: chunk handling is
          // chunk-index-based and transport-agnostic, and `fromRtc` makes the
          // CHUNK_ACK for every lane-delivered chunk ride THIS lane back.
          handleDataChannelMessage(msg, senderId, laneRtc)
        },
        onError: (err) => {
          console.warn(`[FluxDrop] Fast lane ${lane} error (muted):`, err.message)
        },
      },
      false
    )
    record.rtc = laneRtc
    const lanes = fastLaneRtcsRef.current.get(senderId) ?? []
    lanes.push(record)
    fastLaneRtcsRef.current.set(senderId, lanes)
    try {
      const answer = await laneRtc.createAnswer(sdp)
      if (!fastLaneRtcsRef.current.get(senderId)?.includes(record)) {
        // Torn down while answering — do not revive a dead session's lane.
        try { laneRtc.close() } catch { /* ignore */ }
        return
      }
      const answerPayload = {
        roomId,
        from: deviceId,
        to: senderId,
        sdp: answer,
        lane, // v5-a1: lane echo
      }
      signalingRef.current?.sendAnswer(answerPayload)
      console.log(`[FluxDrop] Fast lane ${lane} answered — awaiting DataChannel`)
    } catch (err: any) {
      console.warn(`[FluxDrop] Fast lane ${lane} answer failed:`, err?.message)
      dropFastLane(senderId, record, false)
    }
  }, [])

  // ---- Sender: initiate WebRTC as the offerer (per receiver, v1.3 groups) ----
  // Every receiver gets its OWN RTCPeerConnection + DataChannel. The manifest
  // is (re-)sent on THIS peer's channel when it opens — each peer consents,
  // and its E2E handshake is negotiated independently.
  const initiateWebRTCAsSender = useCallback(async (peerId: string | null) => {
    if (!peerId) return
    // v5-a1: a fresh primary offer invalidates any lanes from the previous
    // leg — tear them down before re-pairing. This one hook covers every
    // re-offer site (attemptResume, handleConnectionFailure, retry buttons)
    // without touching the recovery ladder itself.
    teardownFastLanes(peerId)
    const oldRtc = peerRtcsRef.current.get(peerId)
    if (oldRtc) {
      try { oldRtc.close() } catch { /* ignore */ }
      peerRtcsRef.current.delete(peerId)
    }
    const rtc = new FluxDropWebRTC(
      {
        iceServers: await getEffectiveIceServers(),
        onIceCandidate: (candidate) => {
          signalingRef.current?.sendIce({
            roomId: sessionRef.current.roomId!,
            from: sessionRef.current.deviceId,
            to: peerId,
            candidate,
          })
        },
        onIceGatheringStateChange: (state) => {
          sessionRef.current.setIceGatheringState(state)
        },
        onIceConnectionStateChange: (state) => {
          sessionRef.current.setIceConnectionState(state)
          if (state === 'connected') {
            // perf/resume-1: transport revived — reset the restart budget.
            iceRestartAttemptsRef.current.set(peerId, 0)
            return
          }
          // perf/resume-1 rung 1: an in-place ICE restart usually revives a
          // dropped transport WITHOUT tearing down the connection — the
          // DataChannel/SCTP state survives. attemptResume (fresh PC per
          // peer) stays as the heavy fallback for a dead channel.
          if (state === 'disconnected' || state === 'failed') {
            void performIceRestart(peerId)
          }
        },
        onConnectionStateChange: (state) => {
          sessionRef.current.setRtcState(state)
          if (state === 'connected') {
            toast.success('Peer connection established')
            playConnect()
            startDiagnosticsPolling()
          } else if (state === 'disconnected') {
            // v1.1: ICE 'disconnected' often self-heals (brief network blip).
            // Give it a grace window before treating it as a drop — treating
            // it instantly tore down healthy-but-slow transfers.
            if (disconnectGraceRef.current) clearTimeout(disconnectGraceRef.current)
            disconnectGraceRef.current = setTimeout(() => {
              const rtcNow = peerRtcsRef.current.get(peerId)
              const stNow = transferRef.current.transferState
              // perf/resume-1: a stalled-but-live transfer in ANY active state
              // deserves recovery (the old check ignored PAUSED/RESUMING and
              // left those transfers frozen forever).
              const transferLive = ['TRANSFERRING', 'PAUSED', 'MANIFEST_EXCHANGE', 'RESUMING'].includes(stNow)
              if (rtcNow && rtcNow.connectionState !== 'connected' && transferLive) {
                console.warn('[FluxDrop] Still disconnected after grace period — trying ICE restart')
                void performIceRestart(peerId).then((ok) => {
                  if (!ok) {
                    // Restart impossible (budget exhausted / channel dead) —
                    // hand over to the teardown+re-offer path.
                    transferRef.current.setTransferState('RESUMING')
                    void attemptResume()
                  }
                })
              }
            }, 8000)
          } else if (state === 'failed') {
            // v1.3: a single peer failing doesn't kill a group send — drop
            // that peer and continue with the rest. Solo senders keep the
            // full retry flow.
            const othersLive = [...senderPeersRef.current.values()].some(
              (p) => p.id !== peerId && p.active && (relayModeRef.current.has(p.id) || !!p.rtc?.isOpen)
            )
            if (othersLive && requiredPeersRef.current.size > 1) {
              console.warn(`[FluxDrop] Peer ${peerId.slice(0, 8)} connection failed — dropping from group send`)
              handlePeerDeparture(peerId)
            } else {
              handleConnectionFailure('sender')
            }
          }
        },
        onDataChannelOpen: () => {
          sessionRef.current.setDataChannelOpen(true)
          sessionRef.current.setRetryCount(0)
          // v5-a2: P2P is (back) up — the relay leg becomes dead weight.
          // Tear it down so the send loop stripes over the live primary
          // again ("when P2P works, relay is dead weight only").
          if (relayModeRef.current.has(peerId)) {
            console.log('[FluxDrop] v5-a2: P2P DataChannel (re)opened — dropping the relay fallback leg')
            teardownRelay(peerId)
          }
          const rtcOpen = peerRtcsRef.current.get(peerId)
          // v1.1: seed the adaptive flow window from the transport class
          // (host↔host → fat window; relayed → conservative).
          if (rtcOpen) void rtcOpen.getTransportClass().then((t) => rtcOpen.seedFlowWindow(t))
          // v1.3: per-peer fan-out state (fresh peer or revived connection).
          const stOpen = transferRef.current.transferState
          const isFinishedState = ['CANCELLED', 'FAILED', 'ERROR', 'COMPLETE'].includes(stOpen)
          // A peer that pairs AFTER the transfer finished still gets the files:
          // treat it as a fresh redelivery leg (the source files are still in
          // memory — only the history copy was released).
          const isNewLeg =
            isFinishedState &&
            !!manifestRef.current &&
            filesRef.current.length > 0 &&
            !senderPeersRef.current.has(peerId)
          if (isFinishedState && !isNewLeg) return
          const wasResuming = stOpen === 'RESUMING'
          let peer = senderPeersRef.current.get(peerId)
          if (!peer) {
            peer = {
              id: peerId,
              rtc: rtcOpen!,
              active: true,
              nextPos: 0,
              skip: new Set(),
              skipCount: 0,
              acked: new Set(),
              enc: false,
              accepted: false,
              skipQueryPending: false,
              completedSent: false,
              completed: false,
            }
            senderPeersRef.current.set(peerId, peer)
          } else {
            peer.rtc = rtcOpen!
            peer.active = true
            peer.completedSent = false
            peer.completed = false
          }
          const m = manifestRef.current
          // v5-c6: pull mode has NO manifest yet — the shared library takes
          // its place (offered after the E2E wait below). Everything between
          // here and the offer that needs a manifest is guarded.
          if (!m && !pullLibraryRef.current) return
          // A late connection with a live transfer keeps the global state.
          if (isNewLeg && m) {
            // Fresh aggregate for the redelivery leg (files card, progress).
            transferRef.current.resetProgress(m.totalChunks, m.totalSize)
            transferRef.current.initFiles(m.files)
            transferRef.current.setTransferState('MANIFEST_EXCHANGE')
          } else if (m && stOpen !== 'TRANSFERRING' && stOpen !== 'PAUSED') {
            transferRef.current.setTransferState('MANIFEST_EXCHANGE')
          }
          // Resume leg for this peer: query its stored-chunk bitmap instead
          // of re-sending everything (v1.1 bitmap handshake, per peer now).
          if (m && wasResuming && filesRef.current.length > 0) {
            console.log(`[FluxDrop] Sender resume: querying receiver ${peerId.slice(0, 8)} stored-chunk bitmap`)
            peer.skipQueryPending = true
            transferRef.current.setTransferState('TRANSFERRING')
            rtcOpen?.sendResumeQuery(m.transferId)
            // perf/resume-1: on a FRESH receiver page (reloaded tab) this
            // query can arrive BEFORE the manifest — manifestRef is still
            // null there and the query is dropped silently. Arm the global
            // resume-skip flag so the MANIFEST_ACK handler re-asks once the
            // receiver can actually answer, with the same 5s fallback the
            // other resume paths use.
            resumeSkipPendingRef.current = true
            if (resumeQueryTimerRef.current) clearTimeout(resumeQueryTimerRef.current)
            resumeQueryTimerRef.current = setTimeout(() => {
              if (!resumeSkipPendingRef.current) return
              resumeSkipPendingRef.current = false
              console.log('[FluxDrop] No resume-skip answer within 5s — sending from position 0')
              void beginSendingRef.current?.()
            }, 5000)
          }
          // Send the manifest to THIS peer (after its E2E handshake settles).
          void (async () => {
            const sNow = useSessionStore.getState()
            const pinNow = sNow.pin || receiverPinRef.current
            if (sNow.e2eEnabled && pinNow && !isE2EActive(peerId) && !isE2EActiveForPeer(sNow.roomId, peerId)) {
              const ok = await waitForE2EActive(3500, peerId)
              if (!ok && useSessionStore.getState().e2eStatus !== 'failed') {
                toast.warning('Sending WITHOUT end-to-end encryption', {
                  description: 'A peer did not complete the encryption handshake (outdated FluxDrop or feature turned off). Data is still DTLS-encrypted in transit.',
                  duration: 9000,
                })
              }
            }
            const peerNow = senderPeersRef.current.get(peerId)
            const mEnc = manifestRef.current
            const rtcNow = peerRtcsRef.current.get(peerId)
            if (!peerNow || !rtcNow?.isOpen) return
            // v5-c6: pull mode — instead of a manifest, offer the browsable
            // library (sealed over the e2e-relay envelope). The receiver's
            // REQUEST will build + push the real manifest later.
            const lib = pullLibraryRef.current
            if (!mEnc && lib) {
              peerNow.enc = isE2EActive(peerId)
              const offered = await sendPullControl(peerId, PULL_MSG.OFFER, {
                libraryId: lib.id,
                files: lib.files.slice(0, PULL_MAX_FILES).map((f, i) => ({
                  i,
                  name: f.name,
                  relativePath: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
                  size: f.size,
                  type: f.type || 'application/octet-stream',
                  lastModified: f.lastModified,
                })),
              } satisfies PullOfferBody)
              if (offered) {
                console.log(`[FluxDrop] v5-c6: library offered to peer ${peerId.slice(0, 8)} — ${lib.files.length} files browsable`)
              }
              return
            }
            if (!mEnc) return
            peerNow.enc = isE2EActive(peerId)
            if (peerNow.enc) {
              try {
                const encBody = await encryptWirePayload(new TextEncoder().encode(JSON.stringify(mEnc)), 'manifest', peerId)
                rtcNow.sendManifestEncrypted(mEnc.transferId, encBody)
                console.log(`[FluxDrop] Manifest sent ENCRYPTED to peer ${peerId.slice(0, 8)} (AES-256-GCM)`)
              } catch (encErr: any) {
                // Fail CLOSED: an encryption error aborts rather than leaking.
                console.error('[FluxDrop] Manifest encryption failed:', encErr?.message)
                transferRef.current.setTransferState('ERROR')
                transferRef.current.setError('Encryption failed — transfer aborted')
                playError()
                void persistTransferRecord('sender', 'ERROR')
              }
            } else {
              rtcNow.sendManifest(mEnc.transferId, mEnc)
            }
          })()
        },
        onDataChannelClose: () => {
          if (peerRtcsRef.current.get(peerId) === rtc) {
            // The connection object itself is replaced on resume — only
            // update the shared flag when no other channel is open.
            const anyOpen = [...peerRtcsRef.current.values()].some((p) => p.isOpen && p !== rtc)
            if (!anyOpen) sessionRef.current.setDataChannelOpen(false)
          }
          if (transferRef.current.transferState === 'TRANSFERRING' || transferRef.current.transferState === 'PAUSED') {
            const othersLive = [...senderPeersRef.current.values()].some(
              // v5-a2: a relay-mode peer counts as live — its fallback leg
              // IS its transport while P2P is dead.
              (p) => p.id !== peerId && p.active && (relayModeRef.current.has(p.id) || !!p.rtc?.isOpen)
            )
            if (!othersLive) {
              // v5-a1: the PRIMARY died — lanes are orphans of the dead
              // session. Tear them all down, then let the EXISTING recovery
              // ladder run untouched (it re-offers via
              // initiateWebRTCAsSender, which spins fresh lanes after the
              // transfer resumes).
              teardownFastLanes(peerId)
              transferRef.current.setTransferState('RESUMING')
              // Real resume: persist state and attempt ICE restart.
              void attemptResume()
            } else {
              console.warn(`[FluxDrop] Peer ${peerId.slice(0, 8)} channel closed — group send continues`)
              handlePeerDeparture(peerId)
            }
          }
        },
        onDataChannelMessage: (msg) => handleDataChannelMessage(msg, peerId),
        onError: (err) => {
          // Log all WebRTC errors for diagnostics.
          console.warn('[FluxDrop] WebRTC error:', err.message)
          // Determine if this is a benign error that shouldn't clutter the UI.
          const msg = err.message.toLowerCase()
          const isBenign =
            msg.includes('ice candidate') ||
            msg.includes('abort') ||
            msg.includes('close') ||
            msg.includes('stun') ||
            msg.includes('gather')
          // Only add to error log and show toast for critical errors.
          if (!isBenign) {
            transferRef.current.addErrorLog({ message: err.message })
            toast.error('WebRTC error', { description: err.message, duration: 10000 })
          }
        },
      },
      true
    )
    peerRtcsRef.current.set(peerId, rtc)
    peerDeviceIdRef.current = peerDeviceIdRef.current ?? peerId
    // Only move the GLOBAL state machine forward for the first pairing —
    // additional group receivers must not clobber a running transfer state.
    const stInit = transferRef.current.transferState
    if (stInit === 'PAIRING' || stInit === 'IDLE' || stInit === 'RESUMING') {
      transferRef.current.setTransferState('CONNECTING')
    }
    try {
      const offer = await rtc.createOffer()
      signalingRef.current?.sendOffer({
        roomId: sessionRef.current.roomId!,
        from: sessionRef.current.deviceId,
        to: peerId,
        sdp: offer,
      })
    } catch (err: any) {
      toast.error('Failed to create offer', { description: err.message })
      transferRef.current.setTransferState('FAILED')
    }
  }, [])

  // ---- Receiver: handle incoming offer ----
  const handleOfferAsReceiver = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    const senderId = peerDeviceIdRef.current
    const oldRtc = senderId ? peerRtcsRef.current.get(senderId) : null
    // perf/resume-1: an offer whose SDP origin matches our CURRENT remote
    // description is a renegotiation of the SAME PC (an ICE restart or a
    // similar renegotiation) — never a reason to tear down a live connection.
    // Offers from a brand-new PC carry a different origin.
    const incomingOrigin = sdpOrigin(sdp.sdp ?? '')
    const isSamePcRenegotiation =
      !!oldRtc && !!incomingOrigin && oldRtc.remoteSessionOrigin === incomingOrigin
    // Ignore a redundant re-offer while a transfer is live on an OPEN
    // DataChannel — renegotiating would clobber the running state machine
    // (UI falls back to "Waiting for sender" while chunks keep flowing on
    // the old channel). Legit resume re-offers arrive with the DC closed.
    const st = transferRef.current.transferState
    const transferLive =
      st === 'TRANSFERRING' ||
      st === 'PAUSED' ||
      st === 'VERIFYING' ||
      st === 'MANIFEST_EXCHANGE'
    if (transferLive && sessionRef.current.dataChannelOpen && !isSamePcRenegotiation) {
      console.warn('[FluxDrop] Ignoring redundant offer — transfer already streaming on an open DataChannel')
      return
    }
    // perf/resume-1 rung 0: answer a same-PC renegotiation IN PLACE. The SCTP
    // association, the DataChannel object and all handlers survive — turning
    // the sender's ICE restart into a full reconnect here would waste seconds
    // and drop in-flight stream state.
    if (senderId && oldRtc && isSamePcRenegotiation && oldRtc.supportsInPlaceAnswer()) {
      try {
        const answer = await oldRtc.createAnswer(sdp)
        signalingRef.current?.sendAnswer({
          roomId: sessionRef.current.roomId!,
          from: sessionRef.current.deviceId,
          to: senderId,
          sdp: answer,
        })
        console.log('[FluxDrop] Answered re-offer IN PLACE — transport renegotiated, DataChannel preserved')
        sessionRef.current.setDataChannelOpen(true)
        if (manifestRef.current) {
          const stIp = transferRef.current.transferState
          if (stIp === 'CONNECTING' || stIp === 'RESUMING') {
            transferRef.current.setTransferState('TRANSFERRING')
          }
        }
        return
      } catch (errIp: any) {
        console.warn('[FluxDrop] In-place answer failed — falling back to a fresh connection:', errIp?.message)
      }
    }
    if (oldRtc) {
      try { oldRtc.close() } catch { /* ignore */ }
      if (senderId) peerRtcsRef.current.delete(senderId)
    }
    // v5-a1: a fresh-PC offer means the sender is rebuilding the primary —
    // any lanes from the dead session are orphans (the sender spins new
    // ones after the transfer resumes). The in-place-answer path above
    // already returned, so ICE-restart renegotiations NEVER reach this.
    teardownFastLanes(senderId ?? undefined)
    const rtc = new FluxDropWebRTC(
      {
        iceServers: await getEffectiveIceServers(),
        onIceCandidate: (candidate) => {
          signalingRef.current?.sendIce({
            roomId: sessionRef.current.roomId!,
            from: sessionRef.current.deviceId,
            to: peerDeviceIdRef.current!,
            candidate,
          })
        },
        onIceGatheringStateChange: (state) => {
          sessionRef.current.setIceGatheringState(state)
        },
        onIceConnectionStateChange: (state) => {
          sessionRef.current.setIceConnectionState(state)
        },
        onConnectionStateChange: (state) => {
          sessionRef.current.setRtcState(state)
          if (state === 'connected') {
            toast.success('Peer connection established')
            playConnect()
            startDiagnosticsPolling()
            // perf/resume-1: an in-place ICE restart keeps the DataChannel
            // open (its onopen never refires), so the resume-state restore
            // that normally runs in onDataChannelOpen must happen here too.
            if (manifestRef.current && transferRef.current.transferState === 'RESUMING') {
              transferRef.current.setTransferState('TRANSFERRING')
              receiverStallTicksRef.current = 0
              receiverPokeCountRef.current = 0
            }
          }
          if (state === 'failed') {
            // perf/resume-1: before the retry machine, ask the sender to
            // recover via signaling — the receiver cannot restart ICE itself.
            // The receiver stall watchdog keeps poking on a 5s cadence after
            // this.
            const m = manifestRef.current
            const stNow = transferRef.current.transferState
            const transferLive = ['TRANSFERRING', 'PAUSED', 'MANIFEST_EXCHANGE', 'CONNECTING', 'RESUMING'].includes(stNow)
            if (m && peerDeviceIdRef.current && transferLive && transferRef.current.chunksAcked < m.totalChunks) {
              transferRef.current.setTransferState('RESUMING')
              pokeSenderForResume('connection failed')
              return
            }
            handleConnectionFailure('receiver')
          }
        },
        onDataChannelOpen: () => {
          sessionRef.current.setDataChannelOpen(true)
          sessionRef.current.setRetryCount(0)
          // perf/resume-1: transport restored — reset the watchdog budget.
          receiverStallTicksRef.current = 0
          receiverPokeCountRef.current = 0
          // v1.2: freeze the wire-encryption expectation from the E2E session
          // (survives DC drops within the page; fresh pages get a new session).
          e2eWireRef.current = isE2EActive(peerDeviceIdRef.current)
          // Receiver-side re-offer (resume path): restore the live-transfer
          // state so the progress view and the completion poll stay alive.
          // Without this the UI stayed on "Waiting for sender" for the whole
          // resumed leg even while chunks streamed and acked.
          if (manifestRef.current) {
            const st = transferRef.current.transferState
            if (st === 'CONNECTING' || st === 'RESUMING') {
              transferRef.current.setTransferState('TRANSFERRING')
            }
          }
        },
        onDataChannelClose: () => {
          sessionRef.current.setDataChannelOpen(false)
          stopDiagnosticsPolling()
          // v5-a1: the primary died on the receiver side — its lanes are
          // orphans. The sender re-offers (fresh PC) when it recovers and
          // spins new lanes for the resumed leg.
          teardownFastLanes(peerDeviceIdRef.current ?? undefined)
        },
        onDataChannelMessage: (msg) => handleDataChannelMessage(msg, peerDeviceIdRef.current),
        onError: (err) => {
          // Log all WebRTC errors for diagnostics.
          console.warn('[FluxDrop] WebRTC error:', err.message)
          // Determine if this is a benign error that shouldn't clutter the UI.
          const msg = err.message.toLowerCase()
          const isBenign =
            msg.includes('ice candidate') ||
            msg.includes('abort') ||
            msg.includes('close') ||
            msg.includes('stun') ||
            msg.includes('gather')
          // Only add to error log and show toast for critical errors.
          if (!isBenign) {
            transferRef.current.addErrorLog({ message: err.message })
            toast.error('WebRTC error', { description: err.message, duration: 10000 })
          }
        },
      },
      false
    )
    if (senderId) peerRtcsRef.current.set(senderId, rtc)
    transferRef.current.setTransferState('CONNECTING')
    try {
      const answer = await rtc.createAnswer(sdp)
      signalingRef.current?.sendAnswer({
        roomId: sessionRef.current.roomId!,
        from: sessionRef.current.deviceId,
        to: peerDeviceIdRef.current!,
        sdp: answer,
      })
    } catch (err: any) {
      toast.error('Failed to create answer', { description: err.message })
    }
  }, [pokeSenderForResume])

  // ---- DataChannel message router ----
  // v1.3 (6.1): `fromPeerId` identifies which peer connection the frame came
  // from. SENDER-side cases (MANIFEST_ACK / CHUNK_ACK / completion acks /
  // preview requests) route per peer; RECEIVER-side cases use it to address
  // replies back to the sender.
  const handleDataChannelMessage = useCallback(async (msg: any, fromPeerId?: string | null, fromRtc?: FluxDropWebRTC | null) => {
    const m = manifestRef.current
    const peerId = fromPeerId ?? peerDeviceIdRef.current
    // v5-a1: `fromRtc` is the transport the frame PHYSICALLY arrived on (a
    // fast lane). Replies — above all the CHUNK_ACK inside
    // processReceivedChunk — go back on that SAME transport, so a lane's acks
    // never detour through the primary. The primary paths pass nothing and
    // resolve exactly as before.
    const rtcFrom = fromRtc ?? getRtc(peerId)

    // Shared chunk-accept pipeline (v1.1): used by BOTH CHUNK_DATA and the
    // gzip variant. Bytes arriving here are always ORIGINAL (decompressed)
    // data — bitmaps, byte offsets, and checksums never see the wire format.
    const processReceivedChunk = async (mm: TransferManifest, chunkIndex: number, bytes: ArrayBuffer) => {
      // v5-a3w: while a delta plan is armed for THIS transfer, the incoming
      // bytes are the PATCH stream. They keep living in the memory map (+ the
      // IndexedDB resume cache) exactly like original bytes — only the OPFS
      // temp spill is bypassed: the patch never lands in the output file's
      // byte layout, it is decoded + reconstructed against the vault prior at
      // completion (see finishReceiverDelta).
      const dMode = deltaModeRef.current?.transferId === mm.transferId ? deltaModeRef.current : null
      // Keep chunk in memory (fast). Only save to IndexedDB if the transfer
      // is interrupted — we do this lazily to avoid IDB write overhead on
      // every single chunk, which is the #1 throughput killer.
      receiverBuffersRef.current.set(chunkIndex, bytes)
      // Send ACK immediately (non-blocking) so the sender can keep streaming.
      rtcFrom?.sendChunkAck(mm.transferId, chunkIndex, true)
      // ackChunk dedupes by index: a re-delivered chunk (lost-ack retry) must
      // not double-count bytes or per-file progress.
      const isNewChunk = transferRef.current.ackChunk(chunkIndex, bytes.byteLength)
      // Update per-file progress for ALL files this chunk spans (new chunks only).
      if (isNewChunk) {
        const resolved = resolveChunk(slicePlanRef.current, chunkIndex, mm.chunkSize)
        if (resolved) {
          for (const seg of resolved.segments) {
            transferRef.current.addFileBytes(seg.fileIndex, seg.length)
          }
        }
      }
      // Track ack in memory (fast). IndexedDB flush is debounced.
      void markChunkAcked(mm.transferId, chunkIndex)
      // v1.3 (1.6): memory-bounded receive above the 64 MB cutoff. The chunk
      // spills into the OPFS temp at its byte offset (positional write,
      // serialized on a promise queue like flushReceiverBuffers) and is then
      // trimmed from RAM — but only AFTER the byte is safely on disk. IDB
      // resume persistence is untouched: the %1024 lazy flush below keeps
      // covering whatever is still in memory, and completion reads trimmed
      // chunks back from the temp itself.
      if (!dMode && shouldStreamReceive(mm) && !receiverStreamBrokenRef.current) {
        opfsWriteChainRef.current = opfsWriteChainRef.current.then(async () => {
          try {
            const writable = await ensureReceiverWritable(mm.transferId)
            if (!writable) {
              receiverStreamBrokenRef.current = true
              return
            }
            await writable.write({ type: 'write', position: chunkIndex * mm.chunkSize, data: bytes })
            opfsWrittenRef.current.add(chunkIndex)
            receiverBuffersRef.current.delete(chunkIndex)
          } catch (err: any) {
            // Quota/IO hiccup: stop trimming — this chunk (and the rest) stay
            // in memory and completion seals the gap from memory/IDB.
            receiverStreamBrokenRef.current = true
            console.warn('[FluxDrop] Streamed temp write failed — keeping chunks in memory:', err?.message)
          }
        }).catch(() => { /* keep the chain flowing */ })
      }
      // Periodically persist new chunks in the background (delta flush) so
      // an interrupt can resume without re-sending everything.
      if (chunkIndex > 0 && chunkIndex % 1024 === 0) {
        flushReceiverBuffers()
      }
      // v5-a3w: the live stream's length is the PATCH chunk count while a
      // delta plan is armed (the manifest's counts describe the original).
      const effTotal = dMode ? dMode.totalChunks : mm.totalChunks
      if (chunkIndex === effTotal - 1) {
        // Let queued OPFS writes land before completion inspects the temp.
        const chain = opfsWriteChainRef.current
        try { await chain } catch { /* ignore */ }
        await finishReceiverTransfer()
      }
    }

    switch (msg.type) {
      case MessageType.MANIFEST: {
        // v1.2 guards: while an E2E session is active, a plaintext manifest is
        // an injected fake — drop it. While a handshake is in flight, a
        // plaintext manifest means the sender downgraded (peer timeout) —
        // abandon our half of the handshake and proceed unencrypted.
        if (isE2EActive(peerId)) {
          console.warn('[FluxDrop] Dropped plaintext manifest while E2E is active')
          break
        }
        if (e2eHandshakesRef.current.has(peerId ?? '') || useSessionStore.getState().e2eStatus === 'handshaking') {
          console.warn('[FluxDrop] Sender downgraded to plaintext — abandoning E2E handshake')
          if (peerId) e2eHandshakesRef.current.delete(peerId)
          resetE2ESession()
          useSessionStore.getState().setE2EStatus('idle')
          e2eWireRef.current = false
        }
        void handleIncomingManifest(msg.body as TransferManifest)
        break
      }
      case MessageType.MANIFEST_ENC: {
        // v1.2: encrypted manifest (nonce||GCM-ct of the JSON). Decrypt, then
        // run the exact same accept pipeline as the plaintext path.
        // NOTE: e2eWireRef is NOT a valid "already receiving" guard here —
        // the receiver freezes it TRUE at DC-open when the PAKE session is
        // already active, which silently dropped every encrypted manifest.
        // Dedupe by manifest instead (handleIncomingManifest re-acks same id).
        if (manifestRef.current) break
        if (!(await waitForE2EActive(3000, peerId))) {
          transferRef.current.setTransferState('ERROR')
          transferRef.current.setError('Encrypted manifest arrived but the key exchange did not complete')
          playError()
          break
        }
        e2eWireRef.current = true
        try {
          const json = await decryptWirePayload(msg.payload, 'manifest', peerId)
          const parsed = JSON.parse(new TextDecoder().decode(json)) as TransferManifest
          console.log('[FluxDrop] Manifest received ENCRYPTED — decrypted OK')
          void handleIncomingManifest(parsed)
        } catch (err: any) {
          console.error('[FluxDrop] Manifest decryption failed:', err?.message)
          transferRef.current.setTransferState('ERROR')
          transferRef.current.setError('Manifest failed to decrypt — possible tampering')
          playError()
        }
        break
      }
      case MessageType.MANIFEST_ACK: {
        // v1.3 (6.1): `from` is the receiver that accepted. Per-peer accept
        // state; the FIRST acceptor kicks the fan-out scheduler.
        if (msg.body?.accepted) {
          const senderIsUs = filesRef.current.length > 0
          if (senderIsUs && peerId && senderPeersRef.current.has(peerId)) {
            const peer = senderPeersRef.current.get(peerId)!
            peer.accepted = true
            if (transferRef.current.transferState !== 'TRANSFERRING') {
              requiredPeersRef.current.add(peerId)
            }
            syncPeerProgress(peer)
            if (resumeSkipPendingRef.current && m) {
              // Resumed send: ask THIS receiver what it already has so stored
              // chunks never travel the wire twice (bitmap per peer).
              // v5-a2: a relay-mode peer has no DC — the resume query can't
              // ride the chunk-only relay; the 5 s fallback timer in the
              // MANIFEST_ACK/resume paths then streams from the rewound
              // position (the receiver dedupes by index, so it's only cost).
              peer.skipQueryPending = true
              console.log(`[FluxDrop] Sending resume-skip query to ${peerId.slice(0, 8)} for ${m.transferId.slice(0, 8)}`)
              peer.rtc?.sendResumeQuery(m.transferId)
            }
          }
          void beginSendingRef.current?.()
        }
        else {
          transferRef.current.setTransferState('FAILED')
          toast.error('Transfer rejected', { description: msg.body?.reason })
        }
        break
      }
      case MessageType.PREVIEW_REQ: {
        // v1.2 (4.4) SENDER side: the receiver's consent dialog asked for
        // head-bytes previews of the queued files. Fire-and-forget — a preview
        // failure must NEVER disturb the transfer, so the whole responder is
        // wrapped and every per-file error is swallowed.
        // v5-c6: in pull mode there is no manifest yet — the LIBRARY id is
        // the routing id (requestLibraryPreviews sends it as transferId).
        const pullLib = pullLibraryRef.current
        if ((!m && !pullLib) || filesRef.current.length === 0) break
        try {
          const req = JSON.parse(new TextDecoder().decode(msg.payload)) as {
            v?: number
            files?: { i: number; bytes: number }[]
          }
          if (req?.v !== 1 || !Array.isArray(req.files)) break
          const rtcPreview = rtcFrom
          if (!rtcPreview?.isOpen) break
          const wireId = m?.transferId ?? pullLib!.id
          const wanted: { i: number; bytes: number }[] = req.files
          void (async () => {
            for (const item of wanted) {
              try {
                const idx = Number(item?.i)
                if (!Number.isInteger(idx) || idx < 0 || idx >= filesRef.current.length) continue
                const file = filesRef.current[idx]
                if (!file) continue
                const want = Math.max(0, Math.min(Number(item?.bytes) || 0, file.size))
                const head = await file.slice(0, want).arrayBuffer()
                const body = isE2EActive(peerId) ? await encryptWirePayload(head, 'preview', peerId) : head
                rtcPreview.sendRawFrame(MessageType.PREVIEW_DATA, wireId, idx, body)
              } catch { /* skip this file's preview silently */ }
            }
          })()
        } catch { /* malformed request — ignore */ }
        break
      }
      case MessageType.PREVIEW_DATA: {
        // v1.2 (4.4) RECEIVER side: resolve one consent-dialog preview.
        // chunkIndex carries the manifest file index. Strictly fail-soft:
        // decryption/decoding problems skip the preview silently — previews
        // must never break the transfer. Frames are ignored once the transfer
        // is accepted (state left MANIFEST_EXCHANGE) or the 4s window closed.
        // v5-c6: library thumbs — when there is no manifest but a pending
        // library + open preview window, resolve into libraryPreviews instead.
        if (!m) {
          const lib = useSessionStore.getState().pendingLibrary
          if (lib && libraryPreviewsWaitingRef.current) {
            const libIdx = msg.chunkIndex
            const libEntry = lib.files[libIdx]
            if (!libEntry) break
            void (async () => {
              try {
                let plain: ArrayBuffer = msg.payload as ArrayBuffer
                if (isE2EActive(peerId)) {
                  plain = await decryptWirePayload(msg.payload, 'preview', peerId)
                }
                const mime = (libEntry.type || '').toLowerCase()
                const preview: FilePreview = {
                  mime: libEntry.type || 'application/octet-stream',
                  name: libEntry.name,
                  size: libEntry.size,
                }
                if (plain.byteLength > 0 && mime.startsWith('image/')) {
                  preview.blobUrl = URL.createObjectURL(new Blob([plain], { type: mime }))
                }
                transferRef.current.setLibraryPreview(libIdx, preview)
              } catch { /* preview problems are invisible by design */ }
            })()
          }
          break
        }
        if (!previewsWaitingRef.current) break
        {
          const stPv = transferRef.current.transferState
          if (stPv !== 'MANIFEST_EXCHANGE') break
        }
        const previewIndex = msg.chunkIndex
        if (previewResolvedRef.current.has(previewIndex)) break
        const previewEntry = m.files[previewIndex]
        if (!previewEntry) break
        void (async () => {
          try {
            let plain: ArrayBuffer = msg.payload as ArrayBuffer
            if (e2eWireRef.current) {
              plain = await decryptWirePayload(msg.payload, 'preview', peerId)
            }
            if (previewResolvedRef.current.has(previewIndex)) return // raced duplicate
            previewResolvedRef.current.add(previewIndex)
            const preview: FilePreview = {
              mime: previewEntry.type || 'application/octet-stream',
              name: previewEntry.name,
              size: previewEntry.size,
            }
            const mime = (previewEntry.type || '').toLowerCase()
            const isTextish =
              mime.startsWith('text/') || /\.(txt|md|json|csv|log|xml|ya?ml)$/i.test(previewEntry.name)
            if (plain.byteLength > 0 && mime.startsWith('image/')) {
              preview.blobUrl = URL.createObjectURL(new Blob([plain], { type: mime }))
            } else if (plain.byteLength > 0 && isTextish) {
              // Decode the first 4 KB and drop a trailing partial line so the
              // snippet never ends mid-word.
              const head = plain.byteLength > 4096 ? plain.slice(0, 4096) : plain
              let text = new TextDecoder().decode(head)
              const nl = text.lastIndexOf('\n')
              if (nl > 0) text = text.slice(0, nl)
              preview.text = text.slice(0, 400)
            }
            // No visual preview for other types — the entry still lands so the
            // dialog can show a typed chip.
            transferRef.current.setFilePreview(previewIndex, preview)
          } catch (err: any) {
            console.warn('[FluxDrop] Preview skipped:', err?.message ?? err)
          }
        })()
        break
      }
      case MessageType.CHUNK_DATA: {
        if (!m) return
        // v1.2: plaintext chunk frames are a protocol violation while the
        // encrypted framing is active — drop them (injection guard).
        if (e2eWireRef.current) {
          console.warn('[FluxDrop] Dropped plaintext chunk frame while E2E is active')
          return
        }
        // Ignore stream data for transfers that are already finished locally
        // (CANCELLED/FAILED/ERROR/COMPLETE) — otherwise a peer that hasn't
        // processed our cancel yet would resurrect the transfer.
        {
          const st = transferRef.current.transferState
          if (st === 'CANCELLED' || st === 'FAILED' || st === 'ERROR' || st === 'COMPLETE') {
            return
          }
        }
        await processReceivedChunk(m, msg.chunkIndex, msg.payload)
        break
      }
      case MessageType.CHUNK_ENC: {
        // v1.2: E2E-encrypted chunk. Decrypt → optional gunzip (per the
        // manifest's compression field) → the SAME shared pipeline as the
        // plaintext path (bitmaps, offsets, checksums all original-byte).
        if (!m) return
        {
          const stEnc = transferRef.current.transferState
          if (stEnc === 'CANCELLED' || stEnc === 'FAILED' || stEnc === 'ERROR' || stEnc === 'COMPLETE') {
            return
          }
        }
        try {
          const plain = await decryptWirePayload(msg.payload, 'chunk', peerId)
          let bytes: ArrayBuffer = plain
          if (m.compression === 'gzip') {
            bytes = (await gzipDecompress(new Uint8Array(plain))).buffer as ArrayBuffer
          }
          await processReceivedChunk(m, msg.chunkIndex, bytes)
        } catch (err: any) {
          // A failed decrypt is unrecoverable at this layer — tamper or key
          // desync. Surface it instead of failing verification later.
          console.error('[FluxDrop] Failed to decrypt chunk:', err?.message)
          transferRef.current.addErrorLog({ message: `Decryption failed for chunk ${msg.chunkIndex}: ${err?.message}` })
          transferRef.current.setTransferState('ERROR')
          transferRef.current.setError('Encrypted chunk failed to decrypt — possible tampering')
          playError()
          flushReceiverBuffers()
          await persistTransferRecord('receiver', 'ERROR')
        }
        break
      }
      case MessageType.CHUNK_DATA_GZ: {
        // v1.1: gzip-compressed chunk. Decompress to the ORIGINAL bytes
        // BEFORE storing — resume bitmaps, byte-offset slicing, and the
        // SHA-256 verification all operate on original data only, so the
        // entire downstream pipeline is unchanged by wire compression.
        if (!m) return
        // v1.2: plaintext frames are dropped while encrypted framing is active.
        if (e2eWireRef.current) {
          console.warn('[FluxDrop] Dropped plaintext gzip chunk frame while E2E is active')
          return
        }
        {
          const stGz = transferRef.current.transferState
          if (stGz === 'CANCELLED' || stGz === 'FAILED' || stGz === 'ERROR' || stGz === 'COMPLETE') {
            return
          }
        }
        try {
          const original = await gzipDecompress(msg.payloadView)
          await processReceivedChunk(m, msg.chunkIndex, original.buffer as ArrayBuffer)
        } catch (err: any) {
          // A corrupt gzip frame is unrecoverable at this layer — surface it
          // clearly instead of failing verification later with a mismatch.
          console.error('[FluxDrop] Failed to decompress chunk:', err?.message)
          transferRef.current.addErrorLog({ message: `Corrupted compressed chunk ${msg.chunkIndex}: ${err?.message}` })
          transferRef.current.setTransferState('ERROR')
          transferRef.current.setError('Corrupted compressed chunk received')
          playError()
          flushReceiverBuffers()
          await persistTransferRecord('receiver', 'ERROR')
        }
        break
      }
      case MessageType.CHUNK_ACK: {
        if (!m) return
        // v1.3 (6.1): per-peer ack bookkeeping. The AGGREGATE progress only
        // advances when every REQUIRED peer holds the chunk (with one
        // receiver that's exactly the old per-ack behavior).
        // v1.1: acks flowing again after a reconnect — reset the bounded
        // resume attempt counter so future drops get a fresh retry budget.
        if (resumeAttemptsRef.current > 0) {
          resumeAttemptsRef.current = 0
          toast.success('Connection restored — transfer resumed')
        }
        if (peerId && senderPeersRef.current.has(peerId)) {
          const peer = senderPeersRef.current.get(peerId)!
          if (!peer.acked.has(msg.chunkIndex)) {
            peer.acked.add(msg.chunkIndex)
            if (!chunkAckVotersRef.current.has(msg.chunkIndex)) {
              chunkAckVotersRef.current.set(msg.chunkIndex, new Set())
            }
            syncPeerProgress(peer)
          }
          tryAggregateChunk(msg.chunkIndex)
        }
        break
      }
      case MessageType.TRANSFER_COMPLETE: {
        await verifyReceiverTransfer()
        break
      }
      case MessageType.TRANSFER_COMPLETE_ACK: {
        if (msg.body?.verified) {
          // v1.3 (6.1): per-peer completion. The transfer globally completes
          // when every REQUIRED receiver verified (markPeerCompleted handles
          // the aggregate fanfare, idempotently with the signaling path).
          if (peerId && senderPeersRef.current.has(peerId)) {
            markPeerCompleted(peerId)
          } else {
            // Legacy 1:1 path without fan-out state — complete directly.
            transferRef.current.setTransferState('COMPLETE')
            playSuccess()
            toast.success('Transfer complete & verified!')
            for (let fi = 0; fi < (manifestRef.current?.files.length ?? 0); fi++) {
              transferRef.current.markFileComplete(fi)
            }
            void persistTransferRecord('sender', 'COMPLETE', { checksumVerified: true })
            void flushAllPendingAcks()
            if (manifestRef.current) void deleteSenderFiles(manifestRef.current.transferId)
          }
        } else {
          // Receiver's checksum didn't match. On a resumed send this usually
          // means the source files changed since the original transfer.
          transferRef.current.setTransferState('ERROR')
          transferRef.current.setError('Receiver verification failed — checksum mismatch')
          playError()
          void persistTransferRecord('sender', 'ERROR', { checksumVerified: false })
          toast.error('Verification failed on the receiver', {
            description: resumeSkipUsedRef.current
              ? 'The re-attached files may have changed since the original transfer. Start a fresh transfer with the current files.'
              : 'The transferred data did not match the original checksum. Please retry.',
          })
        }
        break
      }
      case MessageType.TRANSFER_CANCEL: {
        transferRef.current.setTransferState('CANCELLED')
        transferRef.current.setError(msg.body?.reason ?? 'Cancelled by peer')
        playError()
        // Persist received chunks so a later resume can skip them.
        flushReceiverBuffers()
        void persistTransferRecord(filesRef.current.length > 0 ? 'sender' : 'receiver', 'CANCELLED')
        toast.error('Transfer cancelled', { description: msg.body?.reason })
        break
      }
      case MessageType.PAUSE: {
        // Peer requested pause — freeze the stream on both sides.
        pausePeerRef.current = true
        transferRef.current.pauseTimer()
        const st = transferRef.current.transferState
        if (st === 'TRANSFERRING') {
          transferRef.current.setTransferState('PAUSED')
          playPause()
          toast.info('Transfer paused by peer')
        }
        break
      }
      case MessageType.RESUME_STREAM: {
        // Peer resumed — unfreeze (sender loop polls the flag).
        pausePeerRef.current = false
        transferRef.current.resumeTimer()
        const st2 = transferRef.current.transferState
        if (st2 === 'PAUSED' && !pauseLocalRef.current) {
          transferRef.current.setTransferState('TRANSFERRING')
          playResume()
          toast.info('Transfer resumed by peer')
        }
        // If the loop died while paused, restart it from the recorded position.
        kickSenderLoop()
        break
      }
      case MessageType.RESUME_REQUEST: {
        // Receiver reconnected and wants to continue. Instead of trusting a
        // single "last chunk" index (parallel channels ack out-of-order),
        // run the bitmap handshake so only genuinely-missing chunks travel.
        toast.info('Receiver reconnected — checking stored chunks…')
        resumeSkipPendingRef.current = true
        resumeQueryTimerRef.current = setTimeout(() => {
          if (!resumeSkipPendingRef.current) return
          resumeSkipPendingRef.current = false
          console.log('[FluxDrop] No resume-skip answer within 5s — sending from chunk 0')
          void beginSendingRef.current?.()
        }, 5000)
        rtcFrom?.sendResumeQuery(m?.transferId ?? '')
        // Legacy ack so the receiver's UI shows the resume was registered.
        rtcFrom?.sendResumeResponse(m?.transferId ?? '', true, (msg.body?.lastChunkIndex ?? 0) + 1)
        break
      }
      case MessageType.RESUME_QUERY: {
        // Receiver side of the resume-skip handshake: the sender is re-sending
        // a transfer we may already hold chunks for. Flush pending state, then
        // report our acked-chunk bitmap so the sender can skip stored chunks.
        // (Chunks arrive out-of-order on parallel channels, so a contiguous
        // prefix would be useless — the full bitmap is what matters.)
        if (!m) break
        console.log(`[FluxDrop] Resume-skip query received (${m.transferId.slice(0, 8)})`)
        void (async () => {
          try {
            console.log('[FluxDrop] Resume-skip: flushing acks…')
            await flushAllPendingAcks()
            flushReceiverBuffers()
            console.log('[FluxDrop] Resume-skip: reading record…')
            const rec = await getTransferRecord(m.transferId)
            const ackedSet = new Set(rec?.chunksAcked ?? [])
            // Intersect acks with ACTUALLY STORED payloads — an ack without a
            // stored payload must NOT be skipped (it would leave a hole in the
            // reassembled file and fail verification).
            const stored = await getStoredChunkIndices(m.transferId)
            // v5-a3w: a delta-armed resume answers over the PATCH stream — the
            // bitmap bounds + byte cap follow its chunk count/size, not the
            // manifest's original ones (stored chunks are patch bytes).
            const dModeR = deltaModeRef.current?.transferId === m.transferId ? deltaModeRef.current : null
            const streamChunks = dModeR ? dModeR.totalChunks : m.totalChunks
            const streamBytes = dModeR ? dModeR.patchedSize : m.totalSize
            const acked: number[] = []
            for (const i of ackedSet) {
              // v1.3 (1.6): OPFS-temp chunks count as held too (same session —
              // the still-open writable holds their bytes until it commits at
              // completion; discardReceiverTemp clears the set when they die).
              if (
                i >= 0 &&
                i < streamChunks &&
                (stored.has(i) || receiverBuffersRef.current.has(i) || opfsWrittenRef.current.has(i))
              ) {
                acked.push(i)
              }
            }
            console.log(`[FluxDrop] Resume-skip: record acks=${ackedSet.size}, stored=${stored.size}, usable=${acked.length}`)
            if (acked.length > 0) {
              const storedBytes = Math.min(acked.length * m.chunkSize, streamBytes)
              transferRef.current.seedProgress(acked.length, storedBytes)
              transferRef.current.setSkipped(acked.length, storedBytes, acked)
              // Seed per-file progress for skipped chunks too, so the FILES
              // card reflects the already-stored data (parity with the total %).
              for (const idx of acked) {
                const resolved = resolveChunk(slicePlanRef.current, idx, m.chunkSize)
                if (resolved) {
                  for (const seg of resolved.segments) {
                    transferRef.current.addFileBytes(seg.fileIndex, seg.length)
                  }
                }
              }
              const pct = Math.round((acked.length / streamChunks) * 100)
              console.log(`[FluxDrop] Resume-skip: ${acked.length}/${streamChunks} chunks already stored (${pct}%) — answering sender`)
              // Mark the receiver's record as resumed too (parity with the
              // sender) so history badges and stats reflect the continuation.
              void updateTransferRecord(m.transferId, (rec) => {
                if (!rec) return null
                return { ...rec, resumedAt: rec.resumedAt ?? Date.now() }
              })
              // Receiver-side parity with the sender's "Skipping N of M chunks"
              // toast: make the bandwidth saving visible on BOTH ends.
              toast.info(`Continuing transfer — ${pct}% already received`, {
                description: `${acked.length} of ${m.totalChunks} chunks will be skipped · only the missing data travels.`,
              })
            }
            rtcFrom?.sendResumeResponse(m.transferId, true, acked.length, acked)
            console.log('[FluxDrop] Resume-skip: bitmap answer sent')
          } catch { rtcFrom?.sendResumeResponse(m.transferId, true, 0) }
        })()
        break
      }
      case MessageType.RESUME_RESPONSE: {
        console.log(`[FluxDrop] RESUME_RESPONSE received (accepted=${!!msg.body?.accepted}, indices=${Array.isArray(msg.body?.ackedIndices) ? msg.body.ackedIndices.length : 'none'})`)
        if (msg.body?.accepted) {
          // v1.3 (6.1): the bitmap belongs to ONE peer — its skip set is
          // seeded individually. The FIRST answer also seeds the aggregate
          // skip stats (1:1 behavior preserved exactly).
          const peer = peerId ? senderPeersRef.current.get(peerId) : null
          const acked: number[] = Array.isArray(msg.body?.ackedIndices) ? msg.body.ackedIndices : []
          if (peer) {
            if (peer.skipQueryPending) peer.skipQueryPending = false
            peer.skip = new Set(acked)
            peer.skipCount = acked.length
            syncPeerProgress(peer)
            if (m) {
              for (const idx of acked) {
                tryAggregateChunk(idx)
              }
            }
          }
          if (resumeSkipPendingRef.current) {
            // Answer to our resume-skip query: the receiver's acked bitmap.
            resumeSkipPendingRef.current = false
            if (resumeQueryTimerRef.current) {
              clearTimeout(resumeQueryTimerRef.current)
              resumeQueryTimerRef.current = null
            }
            if (acked.length > 0 && m) {
              skipIndicesRef.current = new Set(acked)
              resumeSkipUsedRef.current = true
              const storedBytes = Math.min(acked.length * m.chunkSize, m.totalSize)
              transferRef.current.seedProgress(acked.length, storedBytes)
              transferRef.current.setSkipped(acked.length, storedBytes, acked)
              // Count skipped chunks as delivered in the sender's own history
              // record — without this the record under-reports progress even
              // after the transfer completes (e.g. 82/960 instead of 960/960).
              void markChunksAcked(m.transferId, acked)
              // Sender per-file progress: skipped chunks never produce
              // CHUNK_ACKs, so credit their bytes to the FILES card here —
              // otherwise it stayed stuck below the skipped amount forever.
              for (const idx of acked) {
                const resolved = resolveChunk(slicePlanRef.current, idx, m.chunkSize)
                if (resolved) {
                  for (const seg of resolved.segments) {
                    transferRef.current.addFileBytes(seg.fileIndex, seg.length)
                  }
                }
              }
              toast.info(`Skipping ${acked.length} of ${m.totalChunks} chunks`, {
                description: `${Math.round((acked.length / m.totalChunks) * 100)}% was already received by the peer.`,
              })
            } else {
              skipIndicesRef.current = new Set()
            }
          } else if (acked.length > 0) {
            toast.success(`Resume acknowledged — ${acked.length} chunks already stored`)
          } else {
            toast.success('Resume acknowledged')
          }
        }
        break
      }
      case MessageType.CHAT: {
        // v1.3 (6.3): in-room chat over the DataChannel — P2P only, the
        // signaling server never relays a message. Works in EVERY role and
        // from ANY peer (group rooms: each receiver's channel lands here with
        // its own fromPeerId). Strictly fail-soft: a bad chat frame is
        // dropped and NEVER disturbs a transfer.
        // v5-b4: scoped session grants — a peer we denied chat to is dropped
        // here, BEFORE any UI surface (the receiver-side check is the
        // authority; default-allow for peers with no record).
        if (!grantAllows(peerId, 'chat')) {
          console.log('[FluxDrop] Chat frame dropped — not granted this session')
          break
        }
        void (async () => {
          try {
            const e2eOn = isE2EActive(peerId)
            let body: unknown
            if (e2eOn) {
              // The session for THIS peer is active, so its chat frames must
              // be sealed ('chat' AAD). A plaintext frame here is an injected
              // fake or a key desync — decrypt throws and the frame is
              // dropped (mirrors the manifest/chunk injection guards).
              const json = await decryptWirePayload(msg.payload, 'chat', peerId)
              body = JSON.parse(new TextDecoder().decode(json))
            } else {
              body = msg.body
            }
            // Shape guard: { id: string, text: string ≤ CHAT_MAX_LEN, at: number }.
            if (!body || typeof body !== 'object') return
            const b = body as { id?: unknown; text?: unknown; at?: unknown }
            if (typeof b.text !== 'string') return
            const text = b.text
            if (text.length === 0 || text.length > CHAT_MAX_LEN) return
            const fromId = peerId ?? ''
            const alias =
              useSessionStore.getState().peers.find((p) => p.id === fromId)?.alias ?? 'peer'
            useChatStore.getState().addMessage({
              id: typeof b.id === 'string' && b.id ? b.id : randomUUID(),
              fromDeviceId: fromId,
              alias,
              text,
              at: typeof b.at === 'number' && b.at > 0 ? b.at : Date.now(),
              mine: false,
              viaE2E: e2eOn,
            })
          } catch (err: any) {
            console.warn('[FluxDrop] Chat frame dropped:', err?.message ?? err)
          }
        })()
        break
      }
      case MessageType.CLIPBOARD: {
        // v4 (4.6): opt-in clipboard sync over the DataChannel. Same rules as
        // chat: E2E-sealed when the PAKE session is active (plaintext frames
        // dropped while E2E is on), shape-guarded, strictly fail-soft. The
        // receiving side only opted-in surfaces this (the sync pref gates
        // delivery).
        // v5-b4: scoped session grants — clipboard pushes need an explicit
        // grant from THIS device's consent (default: denied).
        if (!grantAllows(peerId, 'clipboard')) {
          console.log('[FluxDrop] Clipboard frame dropped — not granted this session')
          break
        }
        void (async () => {
          try {
            if (!usePrefsStore.getState().clipboardSync) return // not opted in here
            const e2eOn = isE2EActive(peerId)
            let body: unknown
            if (e2eOn) {
              const json = await decryptWirePayload(msg.payload, 'clipboard', peerId)
              body = JSON.parse(new TextDecoder().decode(json))
            } else {
              body = msg.body
            }
            if (!isValidClipboardFrame(body)) return
            deliverClipboardSync({ text: body.text, at: body.at })
          } catch (err: any) {
            console.warn('[FluxDrop] Clipboard frame dropped:', err?.message ?? err)
          }
        })()
        break
      }
      case MessageType.WIPE_REQUEST: {
        // v5-b1: sender-requested remote wipe. Purge every trace of this
        // transferId from the RECEIVER side: the vault entry, the resume
        // chunk cache + history record (deleteTransferRecord clears both
        // stores), and any in-memory buffers of the active receive. Never
        // touches anything already saved through the OS picker (out of the
        // browser's reach by design). Strictly fire-and-forget.
        const m0 = manifestRef.current
        const targetId = m?.transferId ?? ''
        if (!targetId) break
        void (async () => {
          try {
            await deleteVaultEntry(targetId)
            await deleteTransferRecord(targetId)
            if (m0?.transferId === targetId) {
              receiverBuffersRef.current.clear()
            }
            console.log(`[FluxDrop] Remote wipe applied for transfer ${targetId.slice(0, 8)} (sender: ${msg.body?.reason ?? 'requested'})`)
            toast.info('Transfer wiped on this device', {
              description: 'The sender asked this copy to disappear — vault entry, resume cache and buffers were removed.',
              duration: 8000,
            })
          } catch (err: any) {
            console.warn('[FluxDrop] Remote wipe failed:', err?.message ?? err)
          }
        })()
        break
      }
    }
  }, [persistTransferRecord, flushReceiverBuffers, syncPeerProgress, tryAggregateChunk, markPeerCompleted])

  // ---- v1.2 (4.4): consent-dialog rich previews (receiver) ----
  // Ask the sender for the head bytes of the first 8 files ONCE per manifest.
  // Called by handleIncomingManifest right before the consent dialog mounts
  // (keeps components dumb). Receiver-only (filesRef empty), DC-open-only,
  // strictly fire-and-forget: any failure just means no thumbnails.
  const requestPreviews = useCallback(() => {
    const m = manifestRef.current
    if (!m || m.files.length === 0) return
    if (filesRef.current.length > 0) return // sender has queued files — receiver-only path
    if (previewRequestedForRef.current === m.transferId) return // once per manifest
    const rtc = getRtc()
    if (!rtc?.isOpen) return // DataChannel not open — skip silently
    previewRequestedForRef.current = m.transferId
    const body = JSON.stringify({
      v: 1,
      files: m.files.slice(0, PREVIEW_MAX_FILES).map((_, i) => ({ i, bytes: PREVIEW_HEAD_BYTES })),
    })
    const sent = rtc.sendRawFrame(MessageType.PREVIEW_REQ, m.transferId, 0, new TextEncoder().encode(body))
    if (!sent) return
    console.log(`[FluxDrop] Preview request sent (first ${Math.min(PREVIEW_MAX_FILES, m.files.length)} files, ${PREVIEW_HEAD_BYTES}B heads)`)
    previewsWaitingRef.current = true
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    // 4s window: entries that never arrive simply don't render a thumbnail.
    previewTimerRef.current = setTimeout(() => {
      previewsWaitingRef.current = false
      previewTimerRef.current = null
    }, PREVIEW_WAIT_MS)
  }, [])

  // ---- Receiver: handle incoming manifest (via DC or signaling) ----
  // Shared accept pipeline — used by the manual consent dialog AND the
  // trusted-device auto-accept path.
  // v5-b4: `grants` (from the consent dialog) ride the transfer-accepted
  // signaling event so the SENDER knows which session capabilities we
  // granted; the local record powers the receiver-side enforcement above.
  const doAcceptTransfer = useCallback(async (m: TransferManifest, grants?: SessionGrants) => {
    sessionRef.current.setPendingManifest(null)
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    getRtc()?.sendManifestAck(m.transferId, true)
    signalingRef.current?.sendTransferAccepted({
      roomId: sessionRef.current.roomId!,
      from: sessionRef.current.deviceId,
      to: peerDeviceIdRef.current!,
      accepted: true,
      ...(grants ? { grants } : {}),
    })
    if (grants && peerDeviceIdRef.current) {
      recordOutgoingGrants(peerDeviceIdRef.current, grants)
    }
    // New receiving attempt: start a fresh flush set (old flushed chunks stay
    // in IndexedDB and still count via the record's chunksAcked below).
    flushedChunkIdsRef.current = new Set()
    // v1.3 (1.6): a fresh accept starts a clean streamed-receive state — any
    // temp file left over from a previous cancelled/failed transfer is
    // discarded so its writable can never leak into this transfer's offsets.
    // (Chunks that only lived in that temp are re-sent: they were never in
    // the IDB-backed resume bitmap.)
    void discardReceiverTemp()
    opfsWriteChainRef.current = Promise.resolve()
    receiverStreamBrokenRef.current = false
    // MERGE with any existing record — a re-accept of a resumed transfer must
    // keep the previously-acked chunks, the original start timestamp, AND the
    // resume metadata (resumedAt/resumedSavedBytes) rather than wiping them.
    // Atomic updater: no stale read can clobber concurrently-flushed acks.
    await updateTransferRecord(m.transferId, (existing) => ({
      transferId: m.transferId,
      role: 'receiver',
      manifest: m,
      status: 'TRANSFERRING',
      chunksAcked: existing?.chunksAcked ?? [],
      bytesTransferred: existing?.bytesTransferred ?? 0,
      peerAlias: sessionRef.current.peers[0]?.alias ?? existing?.peerAlias ?? 'peer',
      peerDeviceId: peerDeviceIdRef.current ?? existing?.peerDeviceId ?? '',
      startedAt: existing?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      finishedAt: existing?.status === 'COMPLETE' ? existing.finishedAt : undefined,
      checksumVerified: existing?.status === 'COMPLETE' ? existing.checksumVerified : undefined,
      resumedAt: existing?.resumedAt,
      resumedSavedBytes: existing?.resumedSavedBytes,
    }))
  }, [])

  // Instead of auto-accepting, set pendingManifest so the UI can show
  // a consent dialog for the user to accept or reject — UNLESS the peer
  // is a trusted device and auto-accept is enabled (opt-in setting).
  const handleIncomingManifest = useCallback(async (m: TransferManifest) => {
    if (!m || !m.transferId) return
    if (manifestRef.current?.transferId === m.transferId) {
      // Already seen — re-ack.
      getRtc()?.sendManifestAck(m.transferId, true)
      return
    }
    // v1.2 (4.4): a NEW transferId — drop the previous transfer's previews
    // (revokes any blob URLs) and reset the preview window before the dialog
    // mounts. Auto-accept paths below never request previews.
    transferRef.current.clearFilePreviews()
    previewResolvedRef.current.clear()
    previewRequestedForRef.current = null
    previewsWaitingRef.current = false
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    manifestRef.current = m
    slicePlanRef.current = buildSlicePlan(m)
    transferRef.current.setManifest(m)
    transferRef.current.resetProgress(m.totalChunks, m.totalSize)
    transferRef.current.initFiles(m.files)
    transferRef.current.setTransferState('MANIFEST_EXCHANGE')
    // v1.3 (6.4): every incoming manifest starts with auto-save OFF — only the
    // scoped auto-accept path below may turn it on.
    transferRef.current.setAutoSaveToVault(false)
    // v5-a3w: delta savings never carry over from a previous transfer
    // (same stale-inheritance guard as the skip stats in startSend).
    transferRef.current.setDeltaSavedBytes(0)
    // v5-a3w: delta pre-negotiation — runs BEFORE any accept path (trusted
    // auto-accept, resume auto-accept, manual consent) so the sender can swap
    // its chunk source to the patch before a single byte streams. Bounded by
    // DELTA_PLAN_WAIT_MS; on decline/timeout the normal full-send flow simply
    // proceeds (delta mode is armed inside onDeltaPlan on success).
    await negotiateDelta(m)
    // v5-c6: a manifest arriving while a pull library is pending means the
    // browse flow resolved — the library (and its thumbs) go away.
    if (useSessionStore.getState().pendingLibrary) {
      useSessionStore.getState().setPendingLibrary(null)
      transferRef.current.clearLibraryPreviews()
    }
    // v5-c6: pull-expect auto-accept — WE requested these exact files, so
    // the request IS consent. Safety: the manifest must be a subset of the
    // requested selection (name+size); anything else falls through to the
    // normal consent dialog (a substituted manifest can never sneak in).
    if (pullExpectRef.current && pullExpectRef.current.size > 0) {
      const expected = pullExpectRef.current
      pullExpectRef.current = null
      const matchesSelection =
        m.files.length > 0 && m.files.every((f) => expected.has(`${f.name}:${f.size}`))
      if (matchesSelection) {
        await doAcceptTransfer(m, { files: true, chat: true, clipboard: false })
        toast.success('Receiving your selection', {
          description: `${m.files.length} file${m.files.length !== 1 ? 's' : ''} · ${formatBytes(m.totalSize)} — pulled from the sender's library.`,
        })
        return
      }
      console.warn('[FluxDrop] v5-c6: pull manifest does not match the request — showing the consent dialog instead')
    }
    // v5-c7: kiosk auto-accept — the station has no user to click Accept.
    // Whitelist: trusted devices (default) or everyone (open kiosk). Anything
    // else falls through to the normal consent dialog (visible if someone
    // is watching the screen).
    {
      const kiosk = useKioskStore.getState()
      const senderId = peerDeviceIdRef.current
      if (kiosk.active && senderId) {
        const allowed = kiosk.acceptMode === 'all' || isTrustedPeer(senderId, 'files')
        if (allowed) {
          // A TV has no pickers — straight into the Files vault.
          transferRef.current.setAutoSaveToVault(true)
          await doAcceptTransfer(m, { files: true, chat: false, clipboard: false })
          toast.success('Kiosk receiving', {
            description: `${m.files.length} file${m.files.length !== 1 ? 's' : ''} · ${formatBytes(m.totalSize)} — auto-accepted, saving to the vault.`,
          })
          return
        }
      }
    }
    // Trusted auto-accept (only when the user opted in AND explicitly
    // trusted this device previously).
    // v1.3 (6.4): trust is SCOPED. A drop made entirely of small
    // `snippet-*.txt` files only needs the peer's 'snippets' scope; anything
    // else requires the broader 'files' scope. When the peer ALSO granted the
    // 'autoSave' scope, the transfer is flagged for vault-first saving
    // (consumed by finishReceiverTransfer — v1.3-c wires the vault path).
    const peerId = peerDeviceIdRef.current
    if (sessionRef.current.autoAcceptTrusted && peerId) {
      const allSnippets =
        m.files.length > 0 &&
        m.files.every((f) => /^snippet-.*\.txt$/i.test(f.name) && f.size <= 100 * 1024)
      if (isTrustedPeer(peerId, allSnippets ? 'snippets' : 'files')) {
        const alias = sessionRef.current.peers[0]?.alias ?? 'trusted device'
        // v1.3 (6.4): auto-accept with auto-save scope — v1.3-c consumes this
        // to save into the Files vault without pickers.
        transferRef.current.setAutoSaveToVault(isTrustedPeer(peerId, 'autoSave'))
        await doAcceptTransfer(m)
        toast.success(`Auto-accepted from trusted device ${alias}`, {
          description: 'Manage trusted devices in Settings → Privacy.',
        })
        return
      }
    }
    // Resume auto-accept: a re-send of a transfer we ALREADY started receiving
    // from this exact device. Safety anchors — known transferId (we accepted it
    // before), partial progress recorded, AND the peer deviceId matches the
    // original receiver record. No new content can sneak in under those
    // constraints, so the consent dialog is skipped (setting defaults on).
    if (sessionRef.current.autoAcceptResume && peerId) {
      try {
        const existing = await getTransferRecord(m.transferId)
        const acked = existing?.chunksAcked?.length ?? 0
        const isResumeCandidate =
          existing?.role === 'receiver' &&
          existing.peerDeviceId === peerId &&
          existing.status !== 'COMPLETE' &&
          acked > 0 &&
          acked < m.totalChunks
        if (isResumeCandidate && existing) {
          await doAcceptTransfer(m)
          const pct = Math.min(99, Math.round((acked / m.totalChunks) * 100))
          toast.success(`Resuming automatically — you already have ${pct}%`, {
            description: `Continuing from ${existing.peerAlias || 'the same device'}. Only the missing ${m.totalChunks - acked} chunks will be sent.`,
          })
          return
        }
      } catch { /* fall through to manual consent */ }
    }
    // Set pending manifest so the ConsentDialog shows in the UI.
    // The user must explicitly accept before transfer begins.
    // v1.2 (4.4): also ask the sender for head-bytes previews while the dialog
    // is up (receiver-only, DC-open; fail-soft — no request = no thumbnails,
    // the dialog still works with names/sizes).
    requestPreviews()
    sessionRef.current.setPendingManifest(m)
  }, [doAcceptTransfer, requestPreviews])

  /** Called when the user accepts the transfer in the ConsentDialog. */
  const acceptTransfer = useCallback(async (trust = false, grants?: SessionGrants) => {
    const m = manifestRef.current
    if (!m) return
    if (trust && peerDeviceIdRef.current) {
      // v1.3 (6.4): trust-on-first-use — record the SAS of THIS PAKE session
      // (when E2E is active) so Settings → Privacy can surface the code the
      // user actually verified for this device.
      const sas = useSessionStore.getState().e2eSas ?? undefined
      addTrustedPeer({
        deviceId: peerDeviceIdRef.current,
        alias: sessionRef.current.peers[0]?.alias ?? 'peer',
        sasFingerprint: sas,
      })
      toast.success('Device trusted', {
        description: sas
          ? `Verified code ${sas} saved. Future transfers from this device can be auto-accepted (enable in Settings → Privacy).`
          : 'Future transfers from this device can be auto-accepted (enable in Settings → Privacy).',
      })
    }
    await doAcceptTransfer(m, grants)
    toast.success(`Receiving ${m.files.length} file${m.files.length > 1 ? 's' : ''} (${formatBytes(m.totalSize)})`)
  }, [doAcceptTransfer])

  /** Called when the user rejects the transfer in the ConsentDialog. */
  const rejectTransfer = useCallback(() => {
    const m = manifestRef.current
    if (!m) return
    sessionRef.current.setPendingManifest(null)
    getRtc()?.sendManifestAck(m.transferId, false, 'Rejected by user')
    signalingRef.current?.sendTransferAccepted({
      roomId: sessionRef.current.roomId!,
      from: sessionRef.current.deviceId,
      to: peerDeviceIdRef.current!,
      accepted: false,
      reason: 'Rejected by user',
    })
    transferRef.current.setTransferState('FAILED')
    toast.info('Transfer rejected')
  }, [])

  // ---- v1.3 (1.6): streamed receiver completion (transfers > 64 MB) ----
  // The wire is a continuous byte stream, so the OPFS temp file IS the
  // concatenation: every chunk landed at its byte offset (positional writes).
  // Verification hashes each manifest file's byte range in 8 MB slices with
  // hash-wasm incremental SHA-256 — matching sha256sum for ALL sizes (better
  // than the legacy Merkle-like >256 MB fallback in checksum.ts). Saving cuts
  // each file out of the temp with File.slice() — disk-backed and lazy — so
  // nothing is ever assembled fully in RAM.
  const finishReceiverStreamed = useCallback(async (m: TransferManifest) => {
    try {
      // 0. Let queued positional writes land before judging completeness.
      {
        const chain = opfsWriteChainRef.current
        try { await chain } catch { /* per-write failures already handled */ }
      }

      // 1. Completeness poll — same semantics as the in-memory path, with a
      // third "already in the OPFS temp" location (chunks trimmed from RAM).
      {
        let storedIdx = await getStoredChunkIndices(m.transferId)
        let lastMissing = -1
        let stallTicks = 0
        for (let attempt = 0; attempt < 90; attempt++) {
          const missing: number[] = []
          for (let c = 0; c < m.totalChunks; c++) {
            if (
              !receiverBuffersRef.current.has(c) &&
              !storedIdx.has(c) &&
              !opfsWrittenRef.current.has(c)
            ) {
              missing.push(c)
            }
          }
          if (missing.length === 0) break
          if (missing.length === lastMissing) {
            stallTicks++
            if (stallTicks >= 10) break // no progress for ~10s — genuinely stalled
          } else {
            stallTicks = 0
            lastMissing = missing.length
          }
          if (attempt === 0) {
            console.warn(`[FluxDrop] Streamed assembly waiting for ${missing.length} in-flight chunk(s) (e.g. ${missing.slice(0, 5).join(',')})`)
          }
          await new Promise((r) => setTimeout(r, 1000))
          storedIdx = await getStoredChunkIndices(m.transferId)
        }
      }

      // 2. Commit the writable, then grab the temp handle. getFile()/slice()
      // only reflect written data AFTER the writable is closed.
      await closeReceiverWritable()
      let tempHandle = receiverTempHandleRef.current
      if (!tempHandle) {
        const root = await navigator.storage.getDirectory()
        const tmpDir = await root.getDirectoryHandle('fluxdrop-tmp', { create: true })
        const name = `${m.transferId}.bin`
        tempHandle = await tmpDir.getFileHandle(name, { create: true })
        receiverTempDirRef.current = tmpDir
        receiverTempHandleRef.current = tempHandle
        receiverTempNameRef.current = name
      }

      // 3. Seal: chunks that never went through the streamed writer (OPFS
      // hiccup mid-transfer, resume-skipped chunks, stragglers) are copied
      // into the temp from memory / IndexedDB so the temp is complete.
      {
        const sealWritable = await tempHandle.createWritable({ keepExistingData: true })
        let sealed = 0
        for (let c = 0; c < m.totalChunks; c++) {
          if (opfsWrittenRef.current.has(c)) continue
          let buf = receiverBuffersRef.current.get(c)
          if (!buf) buf = await getChunk(m.transferId, c)
          if (!buf) continue // poll above guarantees a location; a hole fails verification below
          await sealWritable.write({ type: 'write', position: c * m.chunkSize, data: buf })
          opfsWrittenRef.current.add(c)
          sealed++
        }
        await sealWritable.close()
        if (sealed > 0) {
          console.log(`[FluxDrop] Streamed seal: copied ${sealed} chunk(s) from memory/IDB into the temp`)
        }
      }

      // Sanity: positional writes must have produced exactly totalSize bytes.
      const tempFile = await tempHandle.getFile()
      if (tempFile.size !== m.totalSize) {
        throw new Error(`assembled ${tempFile.size}B, expected ${m.totalSize}B — chunks missing`)
      }

      // 4. Verify per file WITHOUT full-file RAM: hash the file's byte range
      // in 8 MB slices (hash-wasm incremental — sha256sum-compatible).
      const verifiedFiles: { name: string; blob: Blob; relativePath: string }[] = []
      for (let i = 0; i < m.files.length; i++) {
        const entry = m.files[i]
        const seg = slicePlanRef.current.find((s) => s.fileIndex === i)
        if (!seg) continue
        const actual = await hashBlobRange(tempFile, seg.startByte, seg.endByte)
        if (actual.toLowerCase() !== entry.checksum.toLowerCase()) {
          // Mirror the in-memory mismatch handling exactly.
          playError()
          toast.error(`Checksum mismatch for ${entry.name}`)
          console.error(
            `[FluxDrop] Checksum mismatch for ${entry.name}: range ${seg.startByte}-${seg.endByte} ` +
              `(assembled ${seg.endByte - seg.startByte}B, expected ${entry.size}B)`
          )
          checksumVerifiedRef.current = false
          transferRef.current.setChecksumVerified(false)
          transferRef.current.setTransferState('ERROR')
          getRtc()?.sendTransferCompleteAck(m.transferId, false)
          // Persist whatever is still in memory (resume can reuse it later).
          flushReceiverBuffers()
          try { await flushChainRef.current } catch { /* best-effort */ }
          await persistTransferRecord('receiver', 'ERROR', { checksumVerified: false })
          void flushAllPendingAcks()
          return
        }
        // File.slice() on the OPFS-backed File is disk-backed and lazy — NOT
        // a RAM copy. These blobs feed the vault/save paths unchanged.
        verifiedFiles.push({
          name: entry.name,
          blob: tempFile.slice(seg.startByte, seg.endByte, entry.type || 'application/octet-stream'),
          relativePath: entry.relativePath,
        })
        transferRef.current.markFileComplete(i)
      }

      // v4 (1.7): independent Merkle verification — rebuild the tree from the
      // bytes we actually stored and compare the root sealed in the manifest.
      // The per-file SHA-256 checks above already passed; this is a second,
      // code-path-independent confirmation over the RAW global byte stream
      // (catches anything a per-file hash path could miss, e.g. cross-file
      // framing corruption). Mismatch = loud warning, never a silent pass.
      if (m.merkle) {
        try {
          const { root: rebuilt } = await computeTransferMerkle(
            async (ci) => tempFile.slice(ci * m.chunkSize, Math.min((ci + 1) * m.chunkSize, m.totalSize)).arrayBuffer(),
            m.totalChunks
          )
          if (rebuilt === m.merkle.root) {
            console.log(`[FluxDrop] Merkle root verified independently (${m.merkle.leaves} leaves)`)
          } else {
            console.error(`[FluxDrop] MERKLE ROOT MISMATCH: manifest ${m.merkle.root} vs rebuilt ${rebuilt}`)
            toast.warning('Merkle integrity check mismatch', {
              description: 'Per-file checksums passed, but the sealed Merkle root differs. Please re-send to be safe.',
            })
          }
        } catch (err: any) {
          console.warn('[FluxDrop] Merkle verification failed to run:', err?.message ?? err)
        }
      }

      // v4 (6.2): cache verified files for "send onward" (relay chaining).
      cacheReceivedFiles(m.transferId, verifiedFiles.map((f) => ({ name: f.name, blob: f.blob, type: f.blob.type })))

      // 5. Vault copy BEFORE the save pickers — the vault copy always exists
      // even if the user cancels the picker. Failure never blocks the transfer.
      let vaultSaved = false
      if (useSessionStore.getState().vaultEnabled && vaultSupported()) {
        try {
          const vaultEntry = await saveToVault(
            {
              transferId: m.transferId,
              totalSize: m.totalSize,
              fileCount: m.files.length,
              verified: true,
              // v5-b1: disappearing transfers — arm the TTL when the sender
              // requested one (absent = keep until budget/LRU eviction).
              ...(m.ttlMs ? { expiresAt: Date.now() + m.ttlMs } : {}),
              files: m.files.map((f) => ({
                name: f.name,
                relativePath: f.relativePath,
                size: f.size,
                type: f.type,
                checksum: f.checksum,
              })),
            },
            verifiedFiles.map((f) => ({ relativePath: f.relativePath, blob: f.blob }))
          )
          if (vaultEntry) {
            vaultSaved = true
            // Fire-and-forget: eviction must never delay completion.
            void enforceVaultBudget()
          } else {
            toast.info('Vault unavailable — file not kept')
          }
        } catch {
          toast.info('Vault unavailable — file not kept')
        }
      }

      // 6. Save — autoSaveToVault (trust scope) skips pickers entirely; the
      // sliced blobs keep the v1.2 conflict-aware save flow unchanged.
      if (transferRef.current.autoSaveToVault && vaultSaved) {
        toast.success('Saved to vault automatically — manage in Files')
      } else if (verifiedFiles.length > 1) {
        const result = await saveFilesToDirectory(verifiedFiles, {
          onConflict: (conflicts) => resolveSaveConflicts(conflicts),
        })
        if (result === 'cancelled') {
          toast.info('Save cancelled — files not saved')
        }
      } else if (verifiedFiles.length === 1) {
        await saveBlobWithPicker(verifiedFiles[0].blob, verifiedFiles[0].name)
      }

      // 7. Completion tail — identical to the in-memory path.
      flushReceiverBuffers()
      try { await flushChainRef.current } catch { /* best-effort */ }
      receiverBuffersRef.current.clear()
      checksumVerifiedRef.current = true
      transferRef.current.setChecksumVerified(true)
      transferRef.current.setTransferState('COMPLETE')
      getRtc()?.sendTransferCompleteAck(m.transferId, true)
      // REDUNDANT RELIABLE PATH: also announce completion via signaling (TCP
      // through the gateway) — see the in-memory path for the rationale.
      try {
        signalingRef.current?.sendTransferComplete({
          roomId: sessionRef.current.roomId!,
          from: sessionRef.current.deviceId,
          to: peerDeviceIdRef.current!,
        })
      } catch { /* DC ack is the primary path */ }
      playSuccess()
      await persistTransferRecord('receiver', 'COMPLETE', { checksumVerified: true })
      void flushAllPendingAcks()
      maybeAutoOpenFirstFile(m)
      toast.success('All files received and verified!', {
        description: `${m.files.length} file${m.files.length > 1 ? 's' : ''} saved · SHA-256 ✓`,
      })
      // Snippet preview parity with the in-memory path.
      {
        const snippet = verifiedFiles.find(
          (f) => /^snippet-.*\.txt$/i.test(f.name) && f.blob.size <= 100 * 1024
        )
        if (snippet) {
          try {
            const text = await snippet.blob.text()
            transferRef.current.setSnippetPreview({ name: snippet.name, text })
          } catch { /* ignore — preview is best-effort */ }
        }
      }
    } catch (err: any) {
      playError()
      console.error('[FluxDrop] Streamed receiver finish failed:', err?.message, err?.stack?.slice(0, 300))
      toast.error('Failed to save file', { description: err.message })
      transferRef.current.setTransferState('ERROR')
      transferRef.current.setError(err.message)
      await persistTransferRecord('receiver', 'ERROR')
    } finally {
      // The temp's bytes now live in the vault / saved copies / nothing —
      // delete it on success AND failure.
      await discardReceiverTemp()
    }
  }, [persistTransferRecord, closeReceiverWritable, discardReceiverTemp])

  // ---- v5-a3w: delta receiver completion (patch → reconstruct → verify) ----
  // All patch-stream chunks are in (memory + IndexedDB). Assemble the patch,
  // decode it, reconstruct the ORIGINAL file against the vault prior, then
  // verify SHA-256 vs the manifest's ORIGINAL digest and run the same
  // save/history tail as the in-memory path. A decode/apply failure cannot
  // fall back to a full send post-hoc (the wire already carried the patch) —
  // it fails loudly with the delta.error toast and writes NO partial output.
  const finishReceiverDelta = useCallback(async (m: TransferManifest, d: DeltaReceiverMode): Promise<void> => {
    try {
      // 1. Completeness poll over the PATCH stream (memory + IndexedDB) —
      //    identical semantics to the in-memory path (parallel channels can
      //    reorder; late TRANSFER_COMPLETE triggers wait here too).
      {
        let storedIdx = await getStoredChunkIndices(m.transferId)
        let lastMissing = -1
        let stallTicks = 0
        for (let attempt = 0; attempt < 90; attempt++) {
          const missing: number[] = []
          for (let c = 0; c < d.totalChunks; c++) {
            if (!receiverBuffersRef.current.has(c) && !storedIdx.has(c)) missing.push(c)
          }
          if (missing.length === 0) break
          if (missing.length === lastMissing) {
            stallTicks++
            if (stallTicks >= 10) break // no progress for ~10s — genuinely stalled
          } else {
            stallTicks = 0
            lastMissing = missing.length
          }
          if (attempt === 0) {
            console.warn(`[FluxDrop] v5-a3w: delta assembly waiting for ${missing.length} patch chunk(s)`)
          }
          await new Promise((r) => setTimeout(r, 1000))
          storedIdx = await getStoredChunkIndices(m.transferId)
        }
      }

      // 2. Assemble the patch stream in chunk-index order (≤ 256 MiB by the
      //    sender-side guard — fully in RAM by design).
      const parts: ArrayBuffer[] = []
      let assembled = 0
      for (let c = 0; c < d.totalChunks; c++) {
        let buf = receiverBuffersRef.current.get(c)
        if (!buf) buf = await getChunk(m.transferId, c)
        if (!buf) continue
        parts.push(buf)
        assembled += buf.byteLength
      }
      if (assembled !== d.patchedSize) {
        throw new Error(`patch stream incomplete — assembled ${assembled}B of ${d.patchedSize}B`)
      }
      const patchBlob = assembleBlob(parts, 'application/octet-stream')

      // 3. Decode + reconstruct against the vault prior. readBlock(i) reads
      //    block i of the file the DELTA_HASHES were computed from; ANY
      //    failure → null → applyPatch aborts (never a silently corrupt file).
      const ops = await decodePatchStream(patchBlob)
      const segments: Uint8Array[] = []
      const readBlock = async (blockIndex: number): Promise<Uint8Array | null> => {
        try {
          const start = blockIndex * DELTA_BLOCK_SIZE
          const end = Math.min(start + DELTA_BLOCK_SIZE, d.priorBlob.size)
          if (end <= start) return null
          return new Uint8Array(await d.priorBlob.slice(start, end).arrayBuffer())
        } catch {
          return null
        }
      }
      const applied = await applyPatch(ops, readBlock, (bytes) => {
        segments.push(bytes)
      })
      if (!applied.ok) throw new Error('a vault block became unreadable mid-reconstruction')
      const entry = m.files[0]
      if (applied.bytesWritten !== entry.size) {
        throw new Error(`reconstructed ${applied.bytesWritten}B, expected ${entry.size}B`)
      }
      // The RECONSTRUCTED ORIGINAL file — verification and every downstream
      // path (vault, save pickers, history, send-onward) consume this.
      const reconstructed = new Blob(segments as BlobPart[], {
        type: entry.type || 'application/octet-stream',
      })

      // 4. Verify SHA-256 vs the manifest's ORIGINAL digest.
      const verified = await verifyChecksum(reconstructed, entry.checksum)
      if (!verified) {
        // EDGE CASE: patch completed but SHA-256 mismatch → fail with an error
        // log entry (existing mechanism); never write partial output.
        playError()
        transferRef.current.addErrorLog({
          message: `Delta reconstruction checksum mismatch for ${entry.name} (patch ${d.patchDigest.slice(0, 12)}…)`,
        })
        toast.error(t(usePrefsStore.getState().locale, 'delta.failed', 'Delta reconstruction failed — please re-send the file'), {
          description: `The reconstructed ${entry.name} did not match the sender's SHA-256.`,
        })
        checksumVerifiedRef.current = false
        transferRef.current.setChecksumVerified(false)
        transferRef.current.setTransferState('ERROR')
        transferRef.current.setError('Delta reconstruction failed — checksum mismatch')
        getRtc()?.sendTransferCompleteAck(m.transferId, false)
        await persistTransferRecord('receiver', 'ERROR', { checksumVerified: false })
        return
      }
      transferRef.current.markFileComplete(0)

      // v4 (1.7) parity: independent Merkle verification rebuilt from the
      // RECONSTRUCTED blob (the in-memory path's source) — the reconstructed
      // file must reproduce the sealed root exactly.
      if (m.merkle) {
        try {
          const { root: rebuilt } = await computeTransferMerkle(
            async (ci) =>
              reconstructed.slice(ci * m.chunkSize, Math.min((ci + 1) * m.chunkSize, entry.size)).arrayBuffer(),
            m.totalChunks
          )
          if (rebuilt === m.merkle.root) {
            console.log(`[FluxDrop] Merkle root verified independently (${m.merkle.leaves} leaves)`)
          } else {
            console.error(`[FluxDrop] MERKLE ROOT MISMATCH: manifest ${m.merkle.root} vs rebuilt ${rebuilt}`)
            toast.warning('Merkle integrity check mismatch', {
              description: 'Per-file checksums passed, but the sealed Merkle root differs. Please re-send to be safe.',
            })
          }
        } catch (err: any) {
          console.warn('[FluxDrop] Merkle verification failed to run:', err?.message ?? err)
        }
      }

      // v4 (6.2): cache verified files for "send onward" (relay chaining).
      cacheReceivedFiles(m.transferId, [
        { name: entry.name, blob: reconstructed, type: reconstructed.type },
      ])

      // 5. Vault copy BEFORE the save pickers (same fail-soft contract).
      let vaultSaved = false
      if (useSessionStore.getState().vaultEnabled && vaultSupported()) {
        try {
          const vaultEntry = await saveToVault(
            {
              transferId: m.transferId,
              totalSize: m.totalSize,
              fileCount: 1,
              verified: true,
              // v5-b1: disappearing transfers — arm the TTL when requested.
              ...(m.ttlMs ? { expiresAt: Date.now() + m.ttlMs } : {}),
              files: [
                {
                  name: entry.name,
                  relativePath: entry.relativePath,
                  size: entry.size,
                  type: entry.type,
                  checksum: entry.checksum,
                },
              ],
            },
            [{ relativePath: entry.relativePath, blob: reconstructed }]
          )
          if (vaultEntry) {
            vaultSaved = true
            void enforceVaultBudget()
          } else {
            toast.info('Vault unavailable — file not kept')
          }
        } catch {
          toast.info('Vault unavailable — file not kept')
        }
      }

      // 6. Save — autoSaveToVault (trust scope) skips pickers entirely.
      if (transferRef.current.autoSaveToVault && vaultSaved) {
        toast.success('Saved to vault automatically — manage in Files')
      } else {
        await saveBlobWithPicker(reconstructed, entry.name)
      }

      // 7. Completion tail — identical to the in-memory path.
      flushReceiverBuffers()
      try { await flushChainRef.current } catch { /* best-effort */ }
      receiverBuffersRef.current.clear()
      checksumVerifiedRef.current = true
      transferRef.current.setChecksumVerified(true)
      transferRef.current.setTransferState('COMPLETE')
      // v5-a3w: the saved-bytes stat — the summary card badges this on BOTH
      // sides (the sender sets its own from the armed plan).
      const savedBytes = Math.max(0, d.originalSize - d.patchedSize)
      transferRef.current.setDeltaSavedBytes(savedBytes)
      getRtc()?.sendTransferCompleteAck(m.transferId, true)
      // REDUNDANT RELIABLE PATH: also announce completion via signaling.
      try {
        signalingRef.current?.sendTransferComplete({
          roomId: sessionRef.current.roomId!,
          from: sessionRef.current.deviceId,
          to: peerDeviceIdRef.current!,
        })
      } catch { /* DC ack is the primary path */ }
      playSuccess()
      await persistTransferRecord('receiver', 'COMPLETE', { checksumVerified: true })
      void flushAllPendingAcks()
      maybeAutoOpenFirstFile(m)
      toast.success('All files received and verified!', {
        description: `1 file saved · SHA-256 ✓ · ${formatBytes(savedBytes)} saved by delta sync`,
      })
      // Snippet preview parity with the in-memory path.
      if (/^snippet-.*\.txt$/i.test(entry.name) && reconstructed.size <= 100 * 1024) {
        try {
          const text = await reconstructed.text()
          transferRef.current.setSnippetPreview({ name: entry.name, text })
        } catch { /* ignore — preview is best-effort */ }
      }
      // The resume-determinism record has served its purpose.
      clearDeltaRecord(m.transferId)
    } catch (err: any) {
      // Decode/apply failure: a full-send fallback is NOT possible post-hoc
      // (the wire already carried the patch) → fail with the clear error
      // toast. No partial output is written (reconstruction only produced
      // in-memory segments at this point).
      playError()
      console.error('[FluxDrop] v5-a3w: delta reconstruction failed:', err?.message ?? err)
      transferRef.current.addErrorLog({ message: `Delta reconstruction failed: ${err?.message ?? err}` })
      toast.error(t(usePrefsStore.getState().locale, 'delta.failed', 'Delta reconstruction failed — please re-send the file'))
      transferRef.current.setTransferState('ERROR')
      transferRef.current.setError(err?.message ?? 'Delta reconstruction failed')
      getRtc()?.sendTransferCompleteAck(m.transferId, false)
      await persistTransferRecord('receiver', 'ERROR')
    } finally {
      deltaModeRef.current = null
      deltaModeActiveMirror = false
    }
  }, [persistTransferRecord])

  // ---- Receiver: finish transfer (assemble + verify + save) ----
  // This is called when the last chunk arrives. It assembles files, verifies
  // checksums, saves them, and sends TRANSFER_COMPLETE_ACK to the sender.
  // We wrap it in a promise ref so verifyReceiverTransfer can await it.
  const finishReceiverTransfer = useCallback(async () => {
    const m = manifestRef.current
    if (!m) return
    // Idempotency: since the verification ref now self-clears when the promise
    // settles, a LATE duplicate trigger (TRANSFER_COMPLETE arriving after the
    // poll already finished) would re-run assembly + save. Terminal states
    // never re-enter the pipeline; a later resume sets a fresh state first.
    const st = transferRef.current.transferState
    if (st === 'COMPLETE' || st === 'ERROR') return
    // Guard against double-run (last-chunk trigger racing TRANSFER_COMPLETE).
    if (verificationPromiseRef.current) {
      await verificationPromiseRef.current
      return
    }
    // If triggered by TRANSFER_COMPLETE rather than the last chunk (resumed
    // re-send where the last chunk was skipped, or cross-channel reorder),
    // the completeness poll inside the verify promise below waits for any
    // still-in-flight chunks before assembling.
    const verifyPromise = (async () => {
    transferRef.current.setTransferState('VERIFYING')
    // v5-a3w: a delta-armed transfer completes through the PATCH pipeline —
    // decode + reconstruct against the vault prior, verify the ORIGINAL
    // digest, then the normal save/history tail. (This branch runs BEFORE
    // the streamed path: delta chunks never touched the OPFS temp.)
    const dMode = deltaModeRef.current
    if (dMode && dMode.transferId === m.transferId) {
      await finishReceiverDelta(m, dMode)
      return
    }
    // v1.3 (1.6): transfers above the 64 MB cutoff complete through the
    // streamed OPFS pipeline (no full-file RAM assembly). Below the cutoff —
    // or whenever streaming never engaged (OPFS dead from the start) — the
    // proven in-memory flow runs byte-for-byte unchanged.
    if (
      shouldStreamReceive(m) &&
      (!!receiverTempHandleRef.current || !receiverStreamBrokenRef.current)
    ) {
      await finishReceiverStreamed(m)
      return
    }
    try {
      // Assemble all files, verify checksums, and save preserving folder structure.
      const assembledFiles: { name: string; blob: Blob; relativePath: string }[] = []

      // Completeness check (ALWAYS — parallel channels reorder chunks, so the
      // last INDEX can arrive while earlier chunks are still in flight; the
      // old lastChunkSeenRef gate skipped this poll and assembled with holes).
      // NEVER assemble while progress continues: a premature TRANSFER_COMPLETE
      // (sender's DC send-buffer drained before the receiver finished reading)
      // used to hit the 15s cap and produce a FALSE checksum-mismatch ERROR
      // that dropped every subsequent chunk. Now: wait while the missing set
      // keeps shrinking; only give up after ~10s of ZERO progress (hard cap 90s).
      {
        let storedIdx = await getStoredChunkIndices(m.transferId)
        let lastMissing = -1
        let stallTicks = 0
        for (let attempt = 0; attempt < 90; attempt++) {
          const missing: number[] = []
          for (let c = 0; c < m.totalChunks; c++) {
            if (!receiverBuffersRef.current.has(c) && !storedIdx.has(c)) missing.push(c)
          }
          if (missing.length === 0) break
          if (missing.length === lastMissing) {
            stallTicks++
            if (stallTicks >= 10) break // no progress for ~10s — genuinely stalled
          } else {
            stallTicks = 0
            lastMissing = missing.length
          }
          if (attempt === 0) {
            console.warn(`[FluxDrop] Assembly waiting for ${missing.length} in-flight chunk(s) (e.g. ${missing.slice(0, 5).join(',')})`)
          }
          await new Promise((r) => setTimeout(r, 1000))
          storedIdx = await getStoredChunkIndices(m.transferId)
        }
      }

      for (let i = 0; i < m.files.length; i++) {
        const entry = m.files[i]
        const fileChunks: ArrayBuffer[] = []
        const seg = slicePlanRef.current.find((s) => s.fileIndex === i)
        if (!seg) continue
        const startChunk = Math.floor(seg.startByte / m.chunkSize)
        const endChunk = Math.floor((seg.endByte - 1) / m.chunkSize)
        for (let c = startChunk; c <= endChunk; c++) {
          let buf = receiverBuffersRef.current.get(c)
          if (!buf) buf = await getChunk(m.transferId, c)
          if (!buf) continue
          const globalStart = c * m.chunkSize
          let localStart = 0
          let localEnd = buf.byteLength
          if (c === startChunk) localStart = seg.startByte - globalStart
          if (c === endChunk) localEnd = seg.endByte - globalStart
          fileChunks.push(buf.slice(localStart, localEnd))
        }
        const blob = assembleBlob(fileChunks, entry.type)
        // Main-thread verification (native crypto.subtle). The worker path
        // (hash-wasm via CDN) produced a wrong digest on a large composite
        // blob in testing — verification must be bulletproof, and the brief
        // main-thread hash at completion time is acceptable.
        const verified = await verifyChecksum(blob, entry.checksum)
        if (!verified) {
          playError()
          toast.error(`Checksum mismatch for ${entry.name}`)
          // Diagnostic: name the missing chunk indices so a short assembly is
          // instantly debuggable (size mismatch ⇒ holes; content mismatch ⇒ data bug).
          const missingChunks: number[] = []
          for (let c = startChunk; c <= endChunk; c++) {
            if (!receiverBuffersRef.current.has(c) && !(await getChunk(m.transferId, c))) missingChunks.push(c)
          }
          console.error(
            `[FluxDrop] Checksum mismatch for ${entry.name}: assembled ${blob.size}B, expected ${entry.size}B` +
              (blob.size < entry.size ? ` — missing chunks: [${missingChunks.join(',')}]` : '')
          )
          checksumVerifiedRef.current = false
          transferRef.current.setChecksumVerified(false)
          transferRef.current.setTransferState('ERROR')
          getRtc()?.sendTransferCompleteAck(m.transferId, false)
          // Persist every received chunk BEFORE returning — the pre-fix path
          // returned without flushing and silently dropped everything the
          // receiver had buffered (a later resume re-sent it all).
          flushReceiverBuffers()
          try { await flushChainRef.current } catch { /* best-effort */ }
          await persistTransferRecord('receiver', 'ERROR', { checksumVerified: false })
          void flushAllPendingAcks()
          return
        }
        assembledFiles.push({ name: entry.name, blob, relativePath: entry.relativePath })
        transferRef.current.markFileComplete(i)
      }

      // v4 (1.7): independent Merkle verification (in-memory path) — same
      // rationale as the streamed path, reading the assembled blobs through
      // the global slice plan so chunk boundaries match the sender exactly.
      if (m.merkle && assembledFiles.length === m.files.length) {
        try {
          const plan1 = slicePlanRef.current
          const blobFor = (fi: number): Blob | null => assembledFiles[fi]?.blob ?? null
          const { root: rebuilt } = await computeTransferMerkle(
            async (ci) => {
              const r = resolveChunk(plan1, ci, m.chunkSize)
              if (!r || r.segments.length === 0) return null
              if (r.segments.length === 1) {
                const seg = r.segments[0]
                const b = blobFor(seg.fileIndex)
                return b ? await b.slice(seg.localStart, seg.localEnd).arrayBuffer() : null
              }
              const combined = new Uint8Array(r.totalLength)
              let off = 0
              for (const seg of r.segments) {
                const b = blobFor(seg.fileIndex)
                if (!b) return null
                const part = new Uint8Array(await b.slice(seg.localStart, seg.localEnd).arrayBuffer())
                combined.set(part, off)
                off += part.byteLength
              }
              return combined.buffer
            },
            m.totalChunks
          )
          if (rebuilt === m.merkle.root) {
            console.log(`[FluxDrop] Merkle root verified independently (${m.merkle.leaves} leaves)`)
          } else {
            console.error(`[FluxDrop] MERKLE ROOT MISMATCH: manifest ${m.merkle.root} vs rebuilt ${rebuilt}`)
            toast.warning('Merkle integrity check mismatch', {
              description: 'Per-file checksums passed, but the sealed Merkle root differs. Please re-send to be safe.',
            })
          }
        } catch (err: any) {
          console.warn('[FluxDrop] Merkle verification failed to run:', err?.message ?? err)
        }
      }

      // v4 (6.2): cache verified files for "send onward" (relay chaining).
      cacheReceivedFiles(m.transferId, assembledFiles.map((f) => ({ name: f.name, blob: f.blob, type: f.blob.type })))

      // v1.3 (4.1): keep a verified copy in the Files vault BEFORE the save
      // pickers — the vault copy always exists even if the user cancels the
      // picker. Failure never blocks the transfer.
      let vaultSaved = false
      if (useSessionStore.getState().vaultEnabled && vaultSupported()) {
        try {
          const vaultEntry = await saveToVault(
            {
              transferId: m.transferId,
              totalSize: m.totalSize,
              fileCount: m.files.length,
              verified: true,
              // v5-b1: disappearing transfers — arm the TTL when requested.
              ...(m.ttlMs ? { expiresAt: Date.now() + m.ttlMs } : {}),
              files: m.files.map((f) => ({
                name: f.name,
                relativePath: f.relativePath,
                size: f.size,
                type: f.type,
                checksum: f.checksum,
              })),
            },
            assembledFiles.map((f) => ({ relativePath: f.relativePath, blob: f.blob }))
          )
          if (vaultEntry) {
            vaultSaved = true
            // Fire-and-forget: eviction must never delay completion.
            void enforceVaultBudget()
          } else {
            toast.info('Vault unavailable — file not kept')
          }
        } catch {
          toast.info('Vault unavailable — file not kept')
        }
      }

      // v1.3 (6.4): auto-accepted transfers carrying the autoSave trust scope
      // live in the vault only — no pickers, no download prompts.
      // Save: use directory picker for multi-file (preserves folder structure),
      // or save picker for single file. v1.2 (4.3): the directory path is
      // conflict-aware — if any target names already exist, the user chooses
      // auto-rename/overwrite/skip per file before anything is written.
      if (transferRef.current.autoSaveToVault && vaultSaved) {
        toast.success('Saved to vault automatically — manage in Files')
      } else if (assembledFiles.length > 1) {
        const result = await saveFilesToDirectory(assembledFiles, {
          onConflict: (conflicts) => resolveSaveConflicts(conflicts),
        })
        if (result === 'cancelled') {
          toast.info('Save cancelled — files not saved')
        }
      } else if (assembledFiles.length === 1) {
        await saveBlobWithPicker(assembledFiles[0].blob, assembledFiles[0].name)
      }

      // Persist every remaining in-memory chunk BEFORE freeing them — without
      // this the final stretch (everything since the last lazy flush) was lost
      // on completion, breaking Re-download from local chunks and any future
      // resume of this transfer (observed: only the pre-cancel chunks survived).
      flushReceiverBuffers()
      try { await flushChainRef.current } catch { /* best-effort */ }

      // Free memory: clear receiver buffers after saving.
      receiverBuffersRef.current.clear()

      checksumVerifiedRef.current = true
      transferRef.current.setChecksumVerified(true)
      transferRef.current.setTransferState('COMPLETE')
      getRtc()?.sendTransferCompleteAck(m.transferId, true)
      // REDUNDANT RELIABLE PATH: also announce completion via signaling (TCP
      // through the gateway). The DataChannel ack can be lost to a DC race at
      // the very end of the stream — observed once in QA (sender stuck at
      // 100% TRANSFERRING while the receiver showed COMPLETE). The sender's
      // onTransferComplete handler finishes it from this message; when the DC
      // ack DID arrive the handler is idempotent (state guard on the sender).
      try {
        signalingRef.current?.sendTransferComplete({
          roomId: sessionRef.current.roomId!,
          from: sessionRef.current.deviceId,
          to: peerDeviceIdRef.current!,
        })
      } catch { /* DC ack is the primary path */ }
      playSuccess()
      // Record the outcome in transfer history (COMPLETE + verified).
      await persistTransferRecord('receiver', 'COMPLETE', { checksumVerified: true })
      void flushAllPendingAcks()
      maybeAutoOpenFirstFile(m)
      toast.success('All files received and verified!', {
        description: `${m.files.length} file${m.files.length > 1 ? 's' : ''} saved · SHA-256 ✓`,
      })
      // Snippet preview: a small text snippet shared via "Share text snippet"
      // gets an instant read/copy dialog instead of a silent save. In multi-file
      // transfers, the first snippet found is previewed.
      {
        const snippet = assembledFiles.find(
          (f) => /^snippet-.*\.txt$/i.test(f.name) && f.blob.size <= 100 * 1024
        )
        if (snippet) {
          try {
            const text = await snippet.blob.text()
            transferRef.current.setSnippetPreview({ name: snippet.name, text })
          } catch { /* ignore — preview is best-effort */ }
        }
      }
    } catch (err: any) {
      playError()
      console.error('[FluxDrop] Receiver finish failed:', err?.message, err?.stack?.slice(0, 300))
      toast.error('Failed to save file', { description: err.message })
      transferRef.current.setTransferState('ERROR')
      transferRef.current.setError(err.message)
      await persistTransferRecord('receiver', 'ERROR')
      return false
    }
    })()
    // Clear the ref once the promise settles. The self-completion poll and the
    // TRANSFER_COMPLETE handler early-return while this ref is non-null — a
    // stale RESOLVED promise here dead-locked every transfer AFTER the first
    // one in the same page lifetime (both peers stuck at 100% TRANSFERRING).
    verificationPromiseRef.current = verifyPromise.finally(() => {
      verificationPromiseRef.current = null
    })
    await verificationPromiseRef.current
  }, [persistTransferRecord, finishReceiverStreamed, finishReceiverDelta])

  // ---- Receiver: verify final checksum ----
  // This is called when the sender sends TRANSFER_COMPLETE.
  // It must WAIT for finishReceiverTransfer to complete verification before
  // sending the ack — otherwise the sender gets "verified: true" before
  // the checksum check has finished.
  const verificationPromiseRef = useRef<Promise<boolean | undefined | void> | null>(null)

  const verifyReceiverTransfer = useCallback(async () => {
    const m = manifestRef.current
    if (!m) return
    // finishReceiverTransfer normally triggers on the LAST chunk arriving and
    // sends the ack itself. But on a resumed re-send the last chunk may be in
    // the skip set (receiver already stored it) — TRANSFER_COMPLETE then has
    // to run the assembly itself, after a short grace for in-flight chunks.
    if (!verificationPromiseRef.current) {
      await finishReceiverTransfer()
      return
    }
    await verificationPromiseRef.current
  }, [finishReceiverTransfer])

  // Expose to the signaling completion handler (late-bound).
  useEffect(() => {
    verifyReceiverTransferRef.current = verifyReceiverTransfer
  }, [verifyReceiverTransfer])

  // ---- Receiver: self-completion poll ----
  // The old completion triggers were fragile on resumed sends: the literal
  // last-chunk arrival never fires when the final chunk was SKIPPED (already
  // stored), and a TRANSFER_COMPLETE frame can be lost across a WebRTC
  // reconnect — leaving both peers stuck at 100%/TRANSFERRING forever.
  // This poll makes the receiver the authority on completion: once ITS ack
  // count reaches totalChunks and the state is still TRANSFERRING, run the
  // finish pipeline (its internal completeness poll absorbs in-flight
  // stragglers). Receiver-only: the sender has filesRef set and waits for
  // TRANSFER_COMPLETE_ACK instead.
  useEffect(() => {
    const id = setInterval(() => {
      if (verificationPromiseRef.current) return
      if (filesRef.current.length > 0) return // sender — different completion path
      const m = manifestRef.current
      if (!m) return
      const st = transferRef.current.transferState
      if (st !== 'TRANSFERRING' && st !== 'MANIFEST_EXCHANGE') {
        receiverCompleteTicksRef.current = 0
        return
      }
      // v5-a3w: delta-armed streams complete at the PATCH chunk count (the
      // manifest's counts describe the original file).
      const streamTotal = deltaStreamChunks(m)
      if (transferRef.current.chunksAcked >= streamTotal) {
        receiverCompleteTicksRef.current++
        // Two consecutive ticks (~2s) — let late in-flight chunks land first.
        if (receiverCompleteTicksRef.current >= 2) {
          receiverCompleteTicksRef.current = 0
          console.log(`[FluxDrop] Receiver completion poll: all ${streamTotal} chunks acked — finishing transfer`)
          void finishReceiverTransfer()
        }
      } else {
        receiverCompleteTicksRef.current = 0
      }
    }, 1000)
    return () => clearInterval(id)
  }, [finishReceiverTransfer])

  // ---- perf/resume-1: receiver stall watchdog (auto-resume pokes) ----
  // Mobile networks drop ICE silently, and a backgrounded sender's timers
  // freeze — the sender may NEVER notice a dead transport, and the receiver
  // (as the ICE answerer) historically had no way to trigger recovery: the
  // transfer sat in CONNECTING/RESUMING forever (the reported "no auto
  // resumes" bug). This poll watches for "transfer active + no live
  // DataChannel + progress below 100%" and pokes the sender over signaling
  // until the stream comes back.
  useEffect(() => {
    const id = setInterval(() => {
      if (verificationPromiseRef.current) return
      if (filesRef.current.length > 0) return // sender — has its own watchdogs
      const m = manifestRef.current
      if (!m) return
      const st = transferRef.current.transferState
      const live = ['CONNECTING', 'TRANSFERRING', 'PAUSED', 'RESUMING', 'MANIFEST_EXCHANGE']
      if (!live.includes(st)) {
        receiverStallTicksRef.current = 0
        return
      }
      // v5-a3w: PATCH chunk count while delta-armed (see completion poll).
      if (transferRef.current.chunksAcked >= deltaStreamChunks(m)) return
      const rtc = peerRtcsRef.current.get(peerDeviceIdRef.current ?? '')
      // v5-a2: relay traffic within the last 15 s means the fallback
      // transport is carrying the transfer — healthy, no poke. (The relay
      // receiver refreshes relayLastChunkAtRef on every routed frame.)
      if (transferRef.current.relayed && Date.now() - relayLastChunkAtRef.current < 15_000) {
        receiverStallTicksRef.current = 0
        receiverPokeCountRef.current = 0
        return
      }
      if (rtc?.isOpen && rtc.connectionState === 'connected') {
        // Healthy — a recovery succeeded; reset the budgets.
        receiverStallTicksRef.current = 0
        receiverPokeCountRef.current = 0
        return
      }
      receiverStallTicksRef.current++
      if (receiverStallTicksRef.current < 3) return // ~15s of dead air first
      receiverStallTicksRef.current = 0
      if (receiverPokeCountRef.current >= 12) {
        // ~2 min of unanswered pokes — stop hammering, surface a manual retry.
        if (st !== 'FAILED') {
          transferRef.current.setTransferState('FAILED')
          transferRef.current.setError('Connection lost — the sender is unreachable')
          playError()
          void persistTransferRecord('receiver', 'FAILED')
          toast.error('Sender unreachable', {
            description: 'Your progress is saved. The transfer resumes automatically once the sender comes back — or press Retry.',
            duration: 15000,
            action: {
              label: 'Retry',
              onClick: () => {
                receiverPokeCountRef.current = 0
                receiverLastPokeAtRef.current = 0
                transferRef.current.setTransferState('RESUMING')
                pokeSenderForResume('manual retry')
              },
            },
          })
        }
        return
      }
      if (st !== 'RESUMING') transferRef.current.setTransferState('RESUMING')
      pokeSenderForResume(`DataChannel closed while ${st}`)
    }, 5000)
    return () => clearInterval(id)
  }, [pokeSenderForResume, persistTransferRecord])

  // ---- perf/resume-1: stale peer-pause watchdog ----
  // A peer that paused us and then died (tab closed mid-pause — the mobile
  // background auto-pause sends PAUSE right before its page vanishes) never
  // sends RESUME_STREAM, and the transfer used to stay PAUSED forever with
  // the receiver showing "Transferring" at zero flow. If the pausing peer's
  // channel is gone, or the peer pause has lasted > 30s, unfreeze.
  useEffect(() => {
    let ticks = 0
    const id = setInterval(() => {
      if (transferRef.current.transferState !== 'PAUSED' || !pausePeerRef.current) {
        ticks = 0
        return
      }
      ticks++
      const rtc = getRtc(peerDeviceIdRef.current)
      const peerDead = !rtc || !rtc.isOpen
      if (peerDead || ticks >= 6) {
        console.warn(`[FluxDrop] Peer pause is stale (${peerDead ? 'channel closed' : '30s without resume'}) — unfreezing`)
        pausePeerRef.current = false
        ticks = 0
        if (transferRef.current.transferState === 'PAUSED' && !pauseLocalRef.current) {
          transferRef.current.setTransferState('TRANSFERRING')
          transferRef.current.resumeTimer()
        }
        kickSenderLoopRef.current()
        toast.info('Peer pause timed out — resuming transfer')
      }
    }, 5000)
    return () => clearInterval(id)
  }, [])

  // ---- Sender: fan-out wave scheduler (v1.3 group rooms) ----
  // One cooperative loop drives ALL connected receivers. Each peer keeps its
  // own position in the deterministic send order (a late acceptor starts at 0
  // and catches up), its own resume-skip bitmap, and its own E2E session key.
  // Per-chunk gzip is computed ONCE and shared; per-chunk encryption is per
  // peer (unique keys). With a single receiver this reduces to the proven
  // v1.2 send loop.
  const beginSending = useCallback(async () => {
    const m = manifestRef.current
    const files = filesRef.current
    if (!m || files.length === 0) return
    if (sendingRef.current) return
    // Generation ownership: bumping the counter marks THIS loop as the active
    // sender. A watchdog force-restart (or any newer beginSending) supersedes
    // the previous loop, which aborts on its next iteration check.
    const myGen = ++sendLoopGenRef.current
    sendingRef.current = true
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    // v5-a1: the send loop entering TRANSFERRING is the fast-lane trigger —
    // maybeStartFastLanes re-checks every gate (pref > 1, size threshold,
    // single receiver, capability) and no-ops otherwise.
    void maybeStartFastLanes()
    // Create the sender's record NOW so the debounced CHUNK_ACK flushes have
    // something to merge into — before this, the record only appeared at a
    // terminal state and every interim ack flush was silently dropped.
    void persistTransferRecord('sender', 'TRANSFERRING')
    const plan = slicePlanRef.current

    // v5-a3w: delta plan armed for THIS transfer → the wire stream is the
    // PATCH, not the original file: chunk count, send order, and the chunk
    // source all switch to the patch Blob (Blob.slice — same API as File, so
    // the send loop's read path is untouched below). The plan is only ever
    // armed while no send loop runs (atomic engage in onDeltaHashes), so
    // capturing it here at loop start is race-free.
    const dPlan = deltaPlanRef.current?.transferId === m.transferId ? deltaPlanRef.current : null
    const totalChunks = dPlan ? dPlan.totalChunks : m.totalChunks

    // v1.1: pipelining order + wire compression for this send session.
    const order = buildSendOrder(dPlan ? { ...m, totalChunks } : m, plan)
    sendOrderRef.current = order
    const useGzip = m.compression === 'gzip' && isCompressionSupported()

    // Any peer channel still open? (v5-a2: a relay-mode peer counts — its
    // fallback transport IS the transport while P2P is dead.)
    const anyPeerOpen = () =>
      [...senderPeersRef.current.values()].some((p) => p.active && (relayModeRef.current.has(p.id) || !!p.rtc?.isOpen))

    // Every active peer fully delivered (position at end + all chunks held)?
    const peerHoldsAll = (p: SenderPeer) =>
      p.acked.size + p.skip.size >= totalChunks

    try {
      /**
       * Read and compose a chunk from potentially multiple file segments.
       * perf/resume-1: the cache now stores PROMISES, not buffers — pipelined
       * reads overlap disk latency with wire sends instead of serializing
       * them (the old await-per-chunk read capped throughput at a few MB/s
       * on slow mobile storage). Group peers moving in lockstep still share
       * the same in-flight read. Cap bounds memory (~64 × 256 KB).
       */
      const readCache = new Map<number, Promise<ArrayBuffer | null>>()
      const composeChunk = async (chunkIndex: number): Promise<ArrayBuffer | null> => {
        // v5-a3w: delta stream — chunk bytes come from the patch Blob
        // directly (the patch is a flat byte stream; the manifest's slice
        // plan describes the ORIGINAL layout and does not apply).
        if (dPlan) {
          const start = chunkIndex * m.chunkSize
          if (start >= dPlan.patchedSize) return null
          return await dPlan.patchBlob
            .slice(start, Math.min(start + m.chunkSize, dPlan.patchedSize))
            .arrayBuffer()
        }
        const resolved = resolveChunk(plan, chunkIndex, m.chunkSize)
        if (!resolved || resolved.segments.length === 0) return null
        let out: ArrayBuffer
        if (resolved.segments.length === 1) {
          const seg = resolved.segments[0]
          const file = files[seg.fileIndex]
          if (!file) return null
          out = await file.slice(seg.localStart, seg.localEnd).arrayBuffer()
        } else {
          const parts: ArrayBuffer[] = []
          for (const seg of resolved.segments) {
            const file = files[seg.fileIndex]
            if (!file) return null
            parts.push(await file.slice(seg.localStart, seg.localEnd).arrayBuffer())
          }
          const combined = new Uint8Array(resolved.totalLength)
          let offset = 0
          for (const part of parts) {
            combined.set(new Uint8Array(part), offset)
            offset += part.byteLength
          }
          out = combined.buffer
        }
        return out
      }
      const readChunk = (chunkIndex: number): Promise<ArrayBuffer | null> => {
        const cached = readCache.get(chunkIndex)
        if (cached) return cached
        const p = composeChunk(chunkIndex)
        // A prefetched read that nobody awaits must never surface as an
        // unhandled rejection; real consumers still observe the result.
        p.catch(() => {})
        readCache.set(chunkIndex, p)
        if (readCache.size >= CONSTANTS.FANOUT_READ_CACHE) {
          const oldest = readCache.keys().next().value
          if (oldest !== undefined) readCache.delete(oldest)
        }
        return p
      }

      // Per-chunk gzip cache: same manifest → identical gzip bytes for every
      // peer. null = compression failed → raw fallback for this chunk.
      const gzCache = new Map<number, Uint8Array | null>()

      // Wave loop: each round lets every eligible peer advance by one chunk.
      let running = true
      while (running) {
        if (sendLoopGenRef.current !== myGen) return
        if (!anyPeerOpen()) {
          // No live receiver — hand over to the resume/revive machinery.
          transferRef.current.setTransferState('RESUMING')
          await persistTransferRecord('sender', 'RESUMING')
          return
        }
        // Pause gate (transfer-global): freeze all peers while paused.
        if (isPaused()) {
          transferRef.current.setTransferState('PAUSED')
          while (isPaused() && anyPeerOpen()) {
            await new Promise((r) => setTimeout(r, 150))
          }
          if (!anyPeerOpen()) {
            transferRef.current.setTransferState('RESUMING')
            await persistTransferRecord('sender', 'RESUMING')
            return
          }
          transferRef.current.setTransferState('TRANSFERRING')
        }

        let progressed = false
        let minPos = order.length
        for (const peer of senderPeersRef.current.values()) {
          if (sendLoopGenRef.current !== myGen) return
          if (!peer.active || !peer.accepted) continue
          // v5-a2: RELAY MODE — when active for a peer, the relay transport
          // is its ONLY transport (lanes/primary are dead by definition) and
          // canSend accounting uses its window. Non-relay peers require an
          // OPEN primary exactly as before.
          const relayT = relayModeRef.current.get(peer.id) ?? null
          const pRtc = peer.rtc
          if (!relayT && !(pRtc?.isOpen ?? false)) continue
          if (peer.nextPos >= order.length) {
            minPos = Math.min(minPos, peer.nextPos)
            continue
          }
          minPos = Math.min(minPos, peer.nextPos)
          // ---- perf/resume-1: burst send — keep the pipe FULL ----
          // The old loop pushed ONE 64 KB chunk per peer per round with the
          // file read awaited inside the critical path: disk latency
          // serialized the wire (~few MB/s ceiling). Each round now pushes a
          // whole window-gated burst, and reads are pipelined ahead of the
          // sends via the promise cache.
          let burst = 0
          while (burst < CONSTANTS.SENDER_BURST_CHUNKS && peer.nextPos < order.length) {
            if (sendLoopGenRef.current !== myGen) return
            const i = order[peer.nextPos]
            // Chunk already stored by THIS receiver (resume bitmap) — skip.
            if (peer.skip.has(i)) {
              peer.nextPos++
              progressed = true
              burst++
              continue
            }
            // ---- v5-a1: striping — pick the transport for this chunk slot ----
            // Primary + open fast lanes; most available window budget wins,
            // primary preferred on ties (control messages + resume bitmap
            // continuity live there). Per-lane canSend/waitForDrain use the
            // exact same AIMD constants as the primary (same wrapper class).
            // No lanes → the plain legacy `pRtc.canSend()` gate, nothing else.
            // v5-a2: relay mode takes PRECEDENCE over striping — one
            // transport, window-gated by its own availableWindow().
            let sendRtc: FluxDropWebRTC | null = relayT ? null : pRtc ?? null
            let laneRec: FastLane | null = null
            const openLanes = fastLaneRtcsRef.current.get(peer.id)
            if (relayT) {
              if (relayT.availableWindow() <= 0) break // window full → bounded wait below
            } else if (!openLanes || openLanes.length === 0) {
              if (!sendRtc || !sendRtc.canSend()) break // window full → bounded drain below
            } else {
              // v5-a1: candidates = primary + lanes with window budget left.
              const cand: Array<{ rtc: FluxDropWebRTC; rec: FastLane | null; budget: number }> = []
              if (sendRtc && sendRtc.isOpen && sendRtc.canSend()) {
                cand.push({ rtc: sendRtc, rec: null, budget: sendRtc.flowWindowBytes - sendRtc.bufferedAmount })
              }
              for (const l of openLanes) {
                if (!l.rtc.isOpen || !l.rtc.canSend()) continue
                cand.push({ rtc: l.rtc, rec: l, budget: l.rtc.flowWindowBytes - l.rtc.bufferedAmount })
              }
              if (cand.length === 0) break // every transport's window is full → drain below
              // Budget-max, ties ROTATE (fair share — see laneRotationRef):
              // max budget first; among equals, the cursor picks so lanes
              // actually carry data whenever they're healthy.
              let maxBudget = -Infinity
              for (const c of cand) if (c.budget > maxBudget) maxBudget = c.budget
              const tied = cand.filter((c) => c.budget === maxBudget)
              const rot = (laneRotationRef.current.get(peer.id) ?? 0) + 1
              laneRotationRef.current.set(peer.id, rot)
              const pick = tied[(tied.length > 1 ? rot : 0) % tied.length]
              sendRtc = pick.rtc
              laneRec = pick.rec
            }
            const bufPromise = readChunk(i)
            // Pipeline: kick off the next reads while this chunk is being
            // compressed/encrypted/sent.
            for (let k = 1; k <= 2; k++) {
              const jIdx = peer.nextPos + k
              if (jIdx >= order.length) break
              const j = order[jIdx]
              if (!peer.skip.has(j)) void readChunk(j)
            }
            const buf = await bufPromise
            if (!buf) {
              peer.nextPos++
              progressed = true
              burst++
              continue
            }
            // v1.1: compress once per chunk (shared across peers).
            let gzipped: Uint8Array | null = null
            if (useGzip) {
              if (!gzCache.has(i)) {
                try {
                  gzCache.set(i, await gzipCompress(new Uint8Array(buf)))
                } catch (gzErr: any) {
                  console.warn(`[FluxDrop] gzip failed for chunk ${i}, sending uncompressed:`, gzErr?.message)
                  gzCache.set(i, null)
                }
              }
              gzipped = gzCache.get(i) ?? null
            }
            let wireBuf: ArrayBuffer | Uint8Array = gzipped ?? buf
            // v1.2: encrypt PER PEER (every receiver has its own session key).
            // Fail CLOSED on encryption errors — never downgrade to plaintext.
            if (peer.enc) {
              try {
                wireBuf = await encryptWirePayload(wireBuf, 'chunk', peer.id)
              } catch (encErr: any) {
                console.error(`[FluxDrop] Chunk ${i} encryption failed for peer ${peer.id.slice(0, 8)}:`, encErr?.message)
                transferRef.current.setTransferState('ERROR')
                transferRef.current.setError('Encryption failed — transfer aborted')
                playError()
                await persistTransferRecord('sender', 'ERROR')
                return
              }
            }
            const wireOpts = { gzip: useGzip && gzipped != null, enc: peer.enc }
            // v5-a2: relay mode — the SAME chunk bytes (already gzipped +
            // E2E-encrypted above) ride the server relay; the `last` flag
            // marks the final position of the send order. Otherwise the DC
            // transport(s) take it exactly as before.
            let sent = false
            if (relayT) {
              sent = relayT.sendChunk(
                i,
                wireBuf instanceof Uint8Array ? wireBuf : new Uint8Array(wireBuf),
                peer.nextPos === order.length - 1
              )
            } else if (sendRtc) {
              sent = sendRtc.sendChunkData(m.transferId, i, wireBuf, wireOpts)
            } else {
              break // (unreachable — the selection above guarantees a transport)
            }
            if (sent) {
              // v5-a1: per-lane observability (aggregated throughput already
              // flows through the chunk-index-based ack accounting).
              if (laneRec) laneRec.bytesSent += wireBuf.byteLength
              peer.nextPos++
              progressed = true
              burst++
            } else {
              break // transient queue pressure — bounded drain below
            }
          }
          if (burst === 0 && peer.nextPos < order.length) {
            // Window full or a transient failure on the first chunk of the
            // burst — wait for THIS peer's buffer to drain (bounded by
            // waitForDrain's own 10s timeout), then let the next round retry
            // while other peers advance.
            // v5-a1: with lanes live, ANY transport freeing budget unblocks
            // the loop (race) instead of waiting on the primary alone. Only
            // OPEN lanes join the race — a still-negotiating lane's
            // waitForDrain resolves instantly and would degenerate this into
            // a poll loop.
            // v5-a2: relay mode — a dead primary's waitForDrain resolves
            // instantly (no channel) and would spin; wait for a relay-ack to
            // free a window slot instead (~1 RTT; the 4 s retransmit timer
            // is the safety net for lost acks).
            if (relayT) {
              await new Promise((r) => setTimeout(r, 50))
            } else {
              const drainLanes = (fastLaneRtcsRef.current.get(peer.id) ?? []).filter((l) => l.rtc.isOpen)
              if (drainLanes.length > 0) {
                await Promise.race([pRtc?.waitForDrain() ?? Promise.resolve(), ...drainLanes.map((l) => l.rtc.waitForDrain())])
              } else {
                await pRtc?.waitForDrain()
              }
            }
            if (sendLoopGenRef.current !== myGen) return
          }
        }
        senderNextIndexRef.current = minPos

        // Per-peer completion: position at the end + all chunks acked/skipped
        // → announce TRANSFER_COMPLETE to that peer (it replies with the
        // verified ack, which drives the global completion via
        // markPeerCompleted).
        for (const peer of senderPeersRef.current.values()) {
          if (!peer.active || peer.completedSent) continue
          // v5-a2: a relay-mode peer has no DC — it still announces (over
          // signaling; control never rides the chunk-only relay).
          if (!(relayModeRef.current.has(peer.id) || peer.rtc?.isOpen)) continue
          if (peer.nextPos >= order.length && peerHoldsAll(peer)) {
            peer.completedSent = true
            if (relayModeRef.current.has(peer.id)) {
              // v5-a2: signaling completion — the receiver's verify pipeline
              // + its own signaling announcement close the loop idempotently.
              signalingRef.current?.sendTransferComplete({
                roomId: sessionRef.current.roomId!,
                from: sessionRef.current.deviceId,
                to: peer.id,
              })
            } else if (peer.rtc?.isOpen) {
              const combined = m.files.map((f) => f.checksum).join('')
              peer.rtc.sendTransferComplete(m.transferId, combined)
            }
            console.log(`[FluxDrop] All chunks sent to peer ${peer.id.slice(0, 8)} — completion announced`)
          }
        }

        // Loop exits when every active, accepted peer reached the end of the
        // order (the completion-ack wait happens below / via signaling).
        const allAtEnd = [...senderPeersRef.current.values()]
          .filter((p) => p.active && p.accepted)
          .every((p) => p.nextPos >= order.length)
        if (allAtEnd && [...senderPeersRef.current.values()].some((p) => p.active && p.accepted)) {
          running = false
          break
        }
        // Yield to the UI once per round — bursts deliver up to
        // SENDER_BURST_CHUNKS × peers chunks per round now.
        await new Promise((r) => setTimeout(r, 0))
        if (!progressed) {
          await new Promise((r) => setTimeout(r, 25))
        }
      }

      // Wait (bounded) until every required peer VERIFIED. The receiver's own
      // completion poll + signaling announcement are the authority; lost DC
      // acks must not hang the sender forever.
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (sendLoopGenRef.current !== myGen) return
        const required = [...requiredPeersRef.current]
        if (required.length === 0) break
        if (required.every((id) => senderPeersRef.current.get(id)?.completed)) break
        const st = transferRef.current.transferState
        if (st === 'ERROR' || st === 'CANCELLED' || st === 'FAILED') return
        await new Promise((r) => setTimeout(r, 500))
      }
    } catch (err: any) {
      playError()
      toast.error('Send error', { description: err.message, duration: 10000 })
      transferRef.current.addErrorLog({ message: `Send error: ${err.message}` })
      transferRef.current.setTransferState('FAILED')
      transferRef.current.setError(err.message)
      await persistTransferRecord('sender', 'FAILED')
    } finally {
      // Release the sending lock ONLY if this loop still owns it — a
      // watchdog force-restart may have started a newer loop already.
      if (sendLoopGenRef.current === myGen) {
        sendingRef.current = false
      }
    }
  }, [persistTransferRecord, syncPeerProgress])

  // Register beginSending for the watchdog effect)

  // Register beginSending for the watchdog effect (declared below) — refs
  // avoid the temporal-dead-zone of referencing it from an earlier callback.
  useEffect(() => {
    beginSendingRef.current = beginSending
  }, [beginSending])

  // ---- Page unload: persist receiver state best-effort ----
  // Chunks received but not yet flushed go to IndexedDB so a resumed re-send
  // can skip them after the page comes back.
  useEffect(() => {
    const onUnload = () => {
      try { flushReceiverBuffers() } catch { /* ignore */ }
      void flushAllPendingAcks()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [flushReceiverBuffers])

  // ---- 30s no-progress stall watchdog ----
  // The send loop can hang (hung await, tab throttling, dev Fast Refresh)
  // while the UI still shows TRANSFERRING. resumeTransfer/kickSenderLoop can't
  // help when sendingRef is stuck true. This interval detects zero chunk
  // progress over 30s and force-restarts the loop from the last recorded
  // position (generation counter supersedes the hung loop safely).
  useEffect(() => {
    const id = setInterval(() => {
      const st = transferRef.current.transferState
      if (st !== 'TRANSFERRING') {
        stallTicksRef.current = 0
        return
      }
      // SENDER-ONLY: this hook mounts on every page (receiver included), where
      // senderNextIndexRef stays 0 and the manifest still exists — the old
      // idx >= totalChunks guard never fired, so receivers logged "Send loop
      // stalled" every 30s and even beganSending(0)'d themselves.
      if (filesRef.current.length === 0) {
        stallTicksRef.current = 0
        return
      }
      const idx = senderNextIndexRef.current
      // Loop already streamed every chunk — it is waiting for the receiver's
      // TRANSFER_COMPLETE_ACK, not stalled. Force-restarting from here would
      // re-run the finished loop and spam TRANSFER_COMPLETE forever.
      // v5-a3w: compare against the STORE's totals — they track the LIVE
      // stream (the PATCH chunk count while a delta plan is armed), unlike
      // the manifest's original-file counts.
      const effStreamTotal =
        transferRef.current.totalChunks || transferRef.current.manifest?.totalChunks || Infinity
      if (idx >= effStreamTotal) {
        stallTicksRef.current = 0
        return
      }
      if (idx === stallLastIdxRef.current) {
        stallTicksRef.current++
        if (stallTicksRef.current >= 6) {
          stallTicksRef.current = 0
          console.log(`[FluxDrop] Send loop stalled 30s at chunk ${idx} — force-restarting`)
          transferRef.current.addErrorLog({ message: `Send loop stalled — auto-restarted from chunk ${idx}` })
          sendLoopGenRef.current++ // supersede the hung loop
          sendingRef.current = false
          void beginSendingRef.current?.(idx)
        }
      } else {
        stallLastIdxRef.current = idx
        stallTicksRef.current = 0
      }
    }, 5000)
    return () => clearInterval(id)
  }, [])

  // ---- Dead-loop watchdog ----
  // The send loop can die silently (e.g. tab throttling, dev Fast Refresh)
  // while the UI still shows TRANSFERRING/PAUSED. resumeTransfer and the
  // peer's RESUME_STREAM then appear to do nothing. This helper detects the
  // dead loop and restarts it from the last recorded position.
  const kickSenderLoop = useCallback(() => {
    if (sendingRef.current) return // loop alive — pause gate will handle waiting
    const st = transferRef.current.transferState
    if (st === 'TRANSFERRING' || st === 'PAUSED') {
      console.log(`[FluxDrop] Send loop dead while ${st} — restarting from chunk ${senderNextIndexRef.current}`)
      // v1.3: per-peer positions live in the fan-out state — the scheduler
      // simply resumes where every peer left off.
      void beginSending()
    }
  }, [beginSending])
  useEffect(() => {
    kickSenderLoopRef.current = kickSenderLoop
  }, [kickSenderLoop])

  // ---- Public API: start a send session ----
  // `resumeManifest` (optional) re-uses an earlier transfer's manifest so
  // history-resume keeps the same transferId, checksums, and record. When
  // provided, files must exactly match the manifest (name + size) and hashing
  // is skipped — checksums are already baked into the manifest.
  // v5-c6: `opts.pullMode` shares the queue as a BROWSABLE library instead
  // of pushing a manifest — no hashing up front; the receiver picks a subset
  // and the real manifest is built (and only the picked files hashed) when
  // the request arrives.
  const startSend = useCallback(async (files: File[], resumeManifest?: TransferManifest, claim?: { roomCode: string; pin: string }, opts?: { pullMode?: boolean }) => {
    try {
      // v5-b2: panic mode — the duress PIN typed into a share-link claim is
      // the other place a user enters a PIN. Same silent-refusal contract as
      // the receiver join path.
      if (claim?.pin && isDuressPin(claim.pin)) {
        void executePanicWipe()
        toast.error('Signaling error: INVALID_PIN', { description: 'incorrect PIN' })
        transferRef.current.setTransferState('FAILED')
        return
      }
      const validation = validateFiles(files)
      if (!validation.ok) {
        toast.error('Cannot send files', { description: validation.errors.join(', ') })
        return
      }
      filesRef.current = files
      transferRef.current.setTransferState('VALIDATING')
      const totalBytes = files.reduce((s, f) => s + f.size, 0)
      const totalMB = (totalBytes / (1024 * 1024)).toFixed(1)
      // v1.1: decide wire compression for the WHOLE transfer up front — the
      // manifest carries the decision so the receiver knows to gunzip, and
      // resumed sends inherit it from the stored manifest.
      const compress = shouldCompressTransfer(files, sessionRef.current.compressionEnabled)
      wireCompressionRef.current = compress ? 'gzip' : undefined
      // Ensure device identity is ready BEFORE anything else.
      await ensureDeviceReady()
      // v5-c6: pull mode — share a browsable library instead of pushing a
      // manifest. No hashing up front (only the picked files get hashed on
      // request); the offer goes out per-peer after the E2E handshake.
      if (opts?.pullMode && !resumeManifest && !claim) {
        pullLibraryRef.current = { id: randomUUID(), files }
        transferRef.current.setTransferState('PAIRING')
        connect()
        await signalingRef.current?.waitUntilConnected(8000)
        {
          const alias = sessionRef.current.alias
          const deviceId = sessionRef.current.deviceId
          if (!alias || !deviceId) {
            toast.error('Device not initialized', { description: 'Please refresh the page and try again.' })
            transferRef.current.setTransferState('FAILED')
            return
          }
          signalingRef.current?.createRoom({
            alias,
            deviceId,
            role: 'sender',
            withPin: true,
          })
        }
        toast.success('Library room created', {
          description: 'The receiver will browse your files and pick what they want — nothing is hashed or sent until they choose.',
        })
        return
      }
      // A normal (non-pull) send supersedes any stale pull library.
      pullLibraryRef.current = null
      let m: TransferManifest
      if (resumeManifest) {
        // Validate the re-attached files still match the stored manifest.
        const mismatch =
          files.length !== resumeManifest.files.length ||
          files.some((f, i) => f.name !== resumeManifest.files[i].name || f.size !== resumeManifest.files[i].size)
        if (mismatch) {
          transferRef.current.setTransferState('IDLE')
          toast.error('Files no longer match this transfer', {
            description: 'The original files were changed or replaced. Start a new transfer instead.',
          })
          return
        }
        m = { ...resumeManifest, expiresAt: Date.now() + CONSTANTS.RESUME_RECORD_TTL_MS }
        wireCompressionRef.current = resumeManifest.compression
        toast.info('Resuming previous transfer', {
          description: `${files.length} file${files.length > 1 ? 's' : ''} · ${totalMB} MB · checksums reused`,
        })
      } else {
        toast.info('Hashing files...', {
          description: `${files.length} file${files.length > 1 ? 's' : ''} · ${totalMB} MB${compress ? ' · gzip' : ''}`,
        })
        // Build manifest with progress updates.
        m = await buildManifest(files, (progress) => {
          transferRef.current.setHashingProgress({
            current: progress.current,
            total: progress.total,
            fileName: progress.fileName,
          })
        }, compress ? 'gzip' : undefined)
        transferRef.current.setHashingProgress(null)
        // v4 (1.7): streaming Merkle tree over per-chunk SHA-256 leaves — the
        // root is sealed into the manifest BEFORE the room exists, so the E2E
        // manifest seal covers it and the receiver rebuilds the same tree at
        // completion for an independent integrity check. Skipped above 2 GB
        // (the extra full read would double pre-send latency on huge queues).
        if (usePrefsStore.getState().merkleEnabled && m.totalSize <= 2 * 1024 * 1024 * 1024) {
          try {
            const plan0 = buildSlicePlan(m)
            transferRef.current.setHashingProgress({ current: 1, total: 1, fileName: 'Sealing Merkle integrity tree…' })
            const readChunk = async (ci: number): Promise<ArrayBuffer | null> => {
              const r = resolveChunk(plan0, ci, m.chunkSize)
              if (!r || r.segments.length === 0) return null
              if (r.segments.length === 1) {
                const seg = r.segments[0]
                const f = files[seg.fileIndex]
                if (!f) return null
                return await f.slice(seg.localStart, seg.localEnd).arrayBuffer()
              }
              const combined = new Uint8Array(r.totalLength)
              let off = 0
              for (const seg of r.segments) {
                const f = files[seg.fileIndex]
                if (!f) return null
                const part = new Uint8Array(await f.slice(seg.localStart, seg.localEnd).arrayBuffer())
                combined.set(part, off)
                off += part.byteLength
              }
              return combined.buffer
            }
            const { root, leaves } = await computeTransferMerkle(readChunk, m.totalChunks)
            m.merkle = { root, leaves: leaves.length }
            merkleLeavesCache = leaves
          } catch (err: any) {
            merkleLeavesCache = null
            console.warn('[FluxDrop] Merkle tree skipped (hashing failed):', err?.message ?? err)
          } finally {
            transferRef.current.setHashingProgress(null)
          }
        } else {
          merkleLeavesCache = null
        }
      }
      // Persist the files so history-resume can re-attach them later
      // (removed automatically once the transfer completes).
      void saveSenderFiles(m.transferId, files)
      // Fresh sends carry no skip state; resumed sends start empty too (the
      // bitmap arrives via the RESUME_QUERY handshake after MANIFEST_ACK).
      skipIndicesRef.current = new Set()
      resumeSkipUsedRef.current = false
      resumeAttemptsRef.current = 0
      transferRef.current.setSkipped(0, 0)
      // v5-a3w: fresh sends start with clean delta state — no inherited plan
      // (a new transferId makes any stale one inert anyway) and no inherited
      // savings stat. Resumed sends keep a live same-transferId plan: the
      // patch is deterministic, so a re-negotiation rebuilds the same blob.
      if (!resumeManifest) deltaPlanRef.current = null
      transferRef.current.setDeltaSavedBytes(0)
      // Resumed sends query the receiver before streaming so already-stored
      // chunks are skipped (RESUME_QUERY handshake after MANIFEST_ACK).
      resumeSkipPendingRef.current = !!resumeManifest
      if (resumeManifest) {
        // Mark the history record so the UI can show a "Resumed" badge.
        void updateTransferRecord(m.transferId, (rec) => {
          if (!rec) return null
          return {
            ...rec,
            resumedAt: Date.now(),
            status: 'PAIRING',
            finishedAt: undefined,
          }
        })
      }
      manifestRef.current = m
      slicePlanRef.current = buildSlicePlan(m)
      transferRef.current.setManifest(m)
      transferRef.current.resetProgress(m.totalChunks, m.totalSize)
      transferRef.current.setTransferState('PAIRING')
      // Prompt for notifications on first transfer (once per browser, respects pref)
      if (
        sessionRef.current.notificationsEnabled &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'default'
      ) {
        try {
          if (!localStorage.getItem('fluxdrop:notif-prompted')) {
            setTimeout(() => {
              Notification.requestPermission().then((result) => {
                localStorage.setItem('fluxdrop:notif-prompted', '1')
                if (result === 'granted') {
                  toast.success('Notifications enabled', {
                    description: 'You\'ll be alerted when transfers complete in the background.',
                  })
                }
              })
            }, 2000)
          }
        } catch { /* ignore */ }
      }
      connect()
      // Wait until the socket is ACTUALLY connected (up to 8s) before
      // emitting — a blind 300ms delay raced cold connects and deep links.
      await signalingRef.current?.waitUntilConnected(8000)
      {
        const alias = sessionRef.current.alias
        const deviceId = sessionRef.current.deviceId
        if (!alias || !deviceId) {
          toast.error('Device not initialized', { description: 'Please refresh the page and try again.' })
          transferRef.current.setTransferState('FAILED')
          return
        }
        signalingRef.current?.createRoom({
          alias,
          deviceId,
          role: 'sender',
          withPin: true,
          // v4 (3.4): claim a pre-created share-link room (code+pin from POST /link).
          ...(claim ? { claim } : {}),
        })
      }
    } catch (err: any) {
      toast.error('Failed to start transfer', { description: err?.message ?? 'Unknown error' })
      transferRef.current.setTransferState('FAILED')
      transferRef.current.setError(err?.message ?? 'Unknown error')
    }
  }, [connect])

  // ---- Public API: join a room as receiver ----
  const startReceive = useCallback(async (roomId: string, pin: string) => {
    try {
      // v5-b2: panic mode — the duress PIN entered where a room PIN is asked
      // silently wipes everything and refuses the pairing with the SAME error
      // a wrong PIN produces (nothing about the wipe is surfaced). The wipe
      // is fire-and-forget; the user can re-type the real PIN right after.
      if (isDuressPin(pin)) {
        void executePanicWipe()
        toast.error('Signaling error: INVALID_PIN', { description: 'incorrect PIN' })
        transferRef.current.setTransferState('FAILED')
        return
      }
      transferRef.current.setTransferState('PAIRING')
      // Ensure device identity is ready before connecting.
      await ensureDeviceReady()
      connect()
      // Wait until the socket is ACTUALLY connected (up to 8s) before
      // emitting — a blind 300ms delay raced cold connects and deep links.
      await signalingRef.current?.waitUntilConnected(8000)
      {
        const alias = sessionRef.current.alias
        const deviceId = sessionRef.current.deviceId
        if (!alias || !deviceId) {
          toast.error('Device not initialized', { description: 'Please refresh the page and try again.' })
          transferRef.current.setTransferState('FAILED')
          return
        }
        signalingRef.current?.joinRoom({
          roomId: roomId.toUpperCase(),
          pin: pin || undefined,
          alias,
          deviceId,
          role: 'receiver',
        })
        // v1.1: remember the PIN for the signaling rejoin path.
        receiverPinRef.current = pin || null
      }
    } catch (err: any) {
      toast.error('Failed to join room', { description: err?.message ?? 'Unknown error' })
      transferRef.current.setTransferState('FAILED')
      transferRef.current.setError(err?.message ?? 'Unknown error')
    }
  }, [connect])

  // ---- Public API: v1.3 (6.3) in-room chat (P2P over the DataChannel) ----
  // SENDER side: fans the message out over EVERY open receiver channel
  // (per-peer E2E seal when that peer's PAKE session is active).
  // RECEIVER side: sends over the single channel to the sender.
  // Returns false when no channel is open (the UI keeps the draft).
  const sendChat = useCallback((text: string): boolean => {
    const trimmed = text.trim()
    if (!trimmed) return false
    const wireBody = new TextEncoder().encode(
      JSON.stringify({ id: randomUUID(), text: trimmed.slice(0, CHAT_MAX_LEN), at: Date.now() })
    )
    // Targets: every OPEN peer channel. Sender side iterates the fan-out map
    // (same pattern as pauseTransfer); with no fan-out state (receiver, or a
    // sender before its first pairing) fall back to the primary channel.
    // v5-b4: peers that granted us chat=false are filtered out here (the
    // receiver drops such frames anyway — this stops phantom "sent" legs).
    const targets: { peerId: string | null; rtc: FluxDropWebRTC }[] = []
    for (const peer of senderPeersRef.current.values()) {
      // v5-a2: relay-mode peers have no DC — chat/clipboard are P2P-only.
      if (peer.rtc?.isOpen && grantedToUse(peer.id, 'chat')) targets.push({ peerId: peer.id, rtc: peer.rtc })
    }
    if (targets.length === 0) {
      const rtc = getRtc()
      if (rtc?.isOpen && grantedToUse(peerDeviceIdRef.current, 'chat')) targets.push({ peerId: peerDeviceIdRef.current, rtc })
    }
    if (targets.length === 0) return false
    // The message travelled PIN-sealed only if EVERY leg is E2E-encrypted.
    const viaE2E = targets.every((t) => isE2EActive(t.peerId))
    // Local echo first (chat UX), then fire-and-forget the wire sends — a
    // failed chat send must never throw into the transfer paths.
    useChatStore.getState().addMessage({
      id: randomUUID(),
      fromDeviceId: useSessionStore.getState().deviceId,
      alias: useSessionStore.getState().alias,
      text: trimmed.slice(0, CHAT_MAX_LEN),
      at: Date.now(),
      mine: true,
      viaE2E,
    })
    void (async () => {
      for (const t of targets) {
        try {
          let payload: ArrayBuffer | Uint8Array = wireBody
          if (isE2EActive(t.peerId)) {
            // Per-peer seal: group rooms hold one independent key per receiver.
            payload = await encryptWirePayload(wireBody, 'chat', t.peerId)
          }
          if (!t.rtc.isOpen) continue // channel died mid-encrypt
          t.rtc.sendRawFrame(MessageType.CHAT, CHAT_WIRE_TRANSFER_ID, 0, payload)
        } catch (err: any) {
          console.warn('[FluxDrop] Chat send failed for a peer:', err?.message ?? err)
        }
      }
    })()
    return true
  }, [])

  // ---- Public API: pause / resume mid-transfer ----
  // Either side can pause. The sender freezes its chunk loop; both UIs show
  // PAUSED. Control messages (PAUSE / RESUME_STREAM) sync both sides.
  const pauseTransfer = useCallback(() => {
    const m = manifestRef.current
    const st = transferRef.current.transferState
    if (!m || (st !== 'TRANSFERRING')) return
    pauseLocalRef.current = true
    transferRef.current.pauseTimer()
    // v1.3: pause EVERY connected peer (group fan-out).
    for (const peer of senderPeersRef.current.values()) {
      if (peer.rtc?.isOpen) peer.rtc.sendPause(m.transferId)
    }
    if (senderPeersRef.current.size === 0) getRtc()?.sendPause(m.transferId)
    transferRef.current.setTransferState('PAUSED')
    playPause()
    toast.info('Transfer paused')
  }, [])

  const resumeTransfer = useCallback(() => {
    const m = manifestRef.current
    if (!m) return
    pauseLocalRef.current = false
    transferRef.current.resumeTimer()
    for (const peer of senderPeersRef.current.values()) {
      if (peer.rtc?.isOpen) peer.rtc.sendResumeStream(m.transferId)
    }
    if (senderPeersRef.current.size === 0) getRtc()?.sendResumeStream(m.transferId)
    // Only flip the UI state if the peer hasn't also paused.
    if (!pausePeerRef.current && transferRef.current.transferState === 'PAUSED') {
      transferRef.current.setTransferState('TRANSFERRING')
    }
    // If the send loop died while paused, restart it from the last chunk.
    kickSenderLoop()
    playResume()
    toast.info('Transfer resumed')
  }, [kickSenderLoop])

  // ---- Public API: cancel ----
  const cancelTransfer = useCallback((reason: string = 'Cancelled by user') => {
    clearPaused()
    const m = manifestRef.current
    if (m) {
      // v1.3: cancel on EVERY connected peer (group fan-out).
      for (const peer of senderPeersRef.current.values()) {
        // v5-a2: relay-mode peers have no DC — cancel rides signaling below.
        if (peer.rtc?.isOpen) peer.rtc.sendCancel(m.transferId, reason)
      }
      getRtc()?.sendCancel(m.transferId, reason)
    }
    signalingRef.current?.sendTransferCancel({
      roomId: sessionRef.current.roomId ?? '',
      from: sessionRef.current.deviceId,
      to: peerDeviceIdRef.current ?? '',
      reason,
    })
    transferRef.current.setTransferState('CANCELLED')
    transferRef.current.setError(reason)
    // Stop the send loop: supersede the current generation so the loop aborts
    // at its next iteration check. Without this, a cancelled transfer kept
    // streaming in the background until the DataChannel closed.
    sendLoopGenRef.current++
    sendingRef.current = false
    skipIndicesRef.current = new Set()
    // v5-a2: a cancelled transfer tears every relay leg down too.
    teardownRelay()
    // v1.1: reset retry/grace state on explicit cancel.
    resumeAttemptsRef.current = 0
    wireCompressionRef.current = undefined
    if (disconnectGraceRef.current) {
      clearTimeout(disconnectGraceRef.current)
      disconnectGraceRef.current = null
    }
    // Cancel any pending resume-skip handshake.
    resumeSkipPendingRef.current = false
    if (resumeQueryTimerRef.current) {
      clearTimeout(resumeQueryTimerRef.current)
      resumeQueryTimerRef.current = null
    }
    // Persist received chunks so a later resume can skip them. Flush twice:
    // once now, and once after acks flush — chunks that arrived between the
    // two points would otherwise end up acked-but-unstored (a hole in any
    // later resume-skip bitmap).
    flushReceiverBuffers()
    if (m) {
      // Serialize: save the CANCELLED status FIRST, then flush pending acks —
      // the ack merge reads the fresh record and preserves the final status.
      void persistTransferRecord(filesRef.current.length > 0 ? 'sender' : 'receiver', 'CANCELLED')
        .then(() => flushAllPendingAcks())
        .then(() => flushReceiverBuffers())
    }
  }, [flushReceiverBuffers])
  // ---- Public API: leave room / reset ----
  const cleanup = useCallback(() => {
    clearPaused()
    stopDiagnosticsPolling()
    // v5-b4: session grants die with the session — a new pairing re-consents.
    clearGrants()
    // v5-c6: pull state dies with the session too (a stale library must
    // never shadow the next room, and a stale pull-expect must never
    // auto-accept a future manifest).
    pullLibraryRef.current = null
    pullExpectRef.current = null
    libraryPreviewsWaitingRef.current = false
    if (libraryPreviewTimerRef.current) {
      clearTimeout(libraryPreviewTimerRef.current)
      libraryPreviewTimerRef.current = null
    }
    useSessionStore.getState().setPendingLibrary(null)
    transferRef.current.clearLibraryPreviews()
    // v1.3: close EVERY peer connection (group fan-out).
    for (const rtc of peerRtcsRef.current.values()) {
      try { rtc.close() } catch { /* ignore */ }
    }
    peerRtcsRef.current.clear()
    // v5-a1: leave-room tears every fast lane + capability entry down with
    // the session (no leaked PCs, no stale caps for a future room).
    teardownFastLanes()
    peerCapsRef.current.clear()
    // v5-a2: leave-room tears every relay leg down with the session too, and
    // the dev forceNext flag is void from this point on.
    teardownRelay()
    forceRelayNextRef.current = false
    senderPeersRef.current.clear()
    requiredPeersRef.current.clear()
    chunkAckVotersRef.current.clear()
    signalingRef.current?.leaveRoom()
    signalingRef.current?.disconnect()
    signalingRef.current = null
    // v5-f19: the leaderboard bridge dies with the signaling session.
    leaderboardTeardownRef.current?.()
    leaderboardTeardownRef.current = null
    // v5-f18: no flake timer outlives the session it was started for.
    chaosStopFlake()
    // v1.1: forget the receiver PIN too.
    receiverPinRef.current = null
    // Kill any running send loop generation.
    sendLoopGenRef.current++
    skipIndicesRef.current = new Set()
    resumeSkipPendingRef.current = false
    // v1.1: reset retry/grace/compression state.
    resumeAttemptsRef.current = 0
    wireCompressionRef.current = undefined
    sendOrderRef.current = []
    if (disconnectGraceRef.current) {
      clearTimeout(disconnectGraceRef.current)
      disconnectGraceRef.current = null
    }
    if (resumeQueryTimerRef.current) {
      clearTimeout(resumeQueryTimerRef.current)
      resumeQueryTimerRef.current = null
    }
    stallTicksRef.current = 0
    // v1.2 (4.4): stop the preview window and revoke any preview blob URLs.
    previewsWaitingRef.current = false
    previewRequestedForRef.current = null
    previewResolvedRef.current.clear()
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
    transferRef.current.clearFilePreviews()
    // v1.3 (6.3): the room is gone — drop the chat transcript with it.
    useChatStore.getState().clearMessages()
    // Flush any pending IndexedDB ack writes before resetting state.
    void flushAllPendingAcks()
    sessionRef.current.resetSession()
    transferRef.current.resetTransfer()
    manifestRef.current = null
    filesRef.current = []
    slicePlanRef.current = []
    receiverBuffersRef.current.clear()
    flushedChunkIdsRef.current = new Set()
    // v1.3 (1.6): best-effort — drop any streamed-receive temp file. Chunks
    // the resume path needs are already in IndexedDB; temp-only chunks are
    // simply re-sent on the next attempt.
    void discardReceiverTemp()
    opfsWriteChainRef.current = Promise.resolve()
    receiverStreamBrokenRef.current = false
    // v5-a3w: delta state dies with the room/session (a pending plan wait is
    // resolved by its own timeout; the mirror powers the debug bundle).
    deltaPlanRef.current = null
    deltaModeRef.current = null
    deltaPriorBlobRef.current = null
    deltaPlanWaitRef.current = null
    deltaModeActiveMirror = false
    sendingRef.current = false
    checksumVerifiedRef.current = null
    // v1.2: tear down the E2E session with the room. (Cancel/pause keeps the
    // session alive so resume legs of the SAME room stay encrypted.)
    e2eHandshakesRef.current.clear()
    e2eWireRef.current = false
    resetE2ESession()
    useSessionStore.getState().setE2EStatus('idle')
    useSessionStore.getState().setE2ESas(null)
    // Silently re-arm the signaling socket so the landing page shows the real
    // (connected) state instead of "Offline" after leaving a room.
    connect(true)
  }, [connect])

  // ---- v4 (4.6): opt-in clipboard sync — public API ----
  // Mirrors sendChat's fan-out exactly: every open receiver channel (sender)
  // or the primary channel (receiver), per-peer E2E seal when active.
  const sendClipboardSync = useCallback((text: string): boolean => {
    if (!usePrefsStore.getState().clipboardSync) return false
    const trimmed = text.trim().slice(0, CLIPBOARD_MAX_LEN)
    if (!trimmed) return false
    const wireBody = new TextEncoder().encode(JSON.stringify({ text: trimmed, at: Date.now() }))
    const targets: { peerId: string | null; rtc: FluxDropWebRTC }[] = []
    for (const peer of senderPeersRef.current.values()) {
      // v5-a2: relay-mode peers have no DC — chat/clipboard are P2P-only.
      // v5-b4: only peers that explicitly granted clipboard pushes.
      if (peer.rtc?.isOpen && grantedToUse(peer.id, 'clipboard')) targets.push({ peerId: peer.id, rtc: peer.rtc })
    }
    if (targets.length === 0) {
      const rtc = getRtc()
      if (rtc?.isOpen && grantedToUse(peerDeviceIdRef.current, 'clipboard')) targets.push({ peerId: peerDeviceIdRef.current, rtc })
    }
    if (targets.length === 0) return false
    void (async () => {
      for (const t of targets) {
        try {
          let payload: ArrayBuffer | Uint8Array = wireBody
          if (isE2EActive(t.peerId)) {
            payload = await encryptWirePayload(wireBody, 'clipboard', t.peerId)
          }
          if (!t.rtc.isOpen) continue
          t.rtc.sendRawFrame(MessageType.CLIPBOARD, CHAT_WIRE_TRANSFER_ID, 0, payload)
        } catch (err: any) {
          console.warn('[FluxDrop] Clipboard sync failed for a peer:', err?.message ?? err)
        }
      }
    })()
    return true
  }, [])

  // Clipboard sender: while the sync pref is ON and a channel is live, native
  // copies are forwarded (document 'copy' capture — gesture-free by design).
  useEffect(() => {
    if (typeof document === 'undefined') return
    let detach: (() => void) | null = null
    let attached = false
    const unsub = usePrefsStore.subscribe((s) => {
      const want = s.clipboardSync
      if (want && !attached) {
        attached = true
        detach = attachClipboardSender((text) => {
          // Only sync while some channel is actually open.
          const hasOpen = getRtc()?.isOpen || [...senderPeersRef.current.values()].some((p) => !!p.rtc?.isOpen)
          if (hasOpen) sendClipboardSync(text)
        })
      } else if (!want && attached) {
        attached = false
        detach?.()
        detach = null
      }
    })
    // Initial state application (mount with the pref already on).
    if (usePrefsStore.getState().clipboardSync) {
      attached = true
      detach = attachClipboardSender((text) => {
        const hasOpen = getRtc()?.isOpen || [...senderPeersRef.current.values()].some((p) => !!p.rtc?.isOpen)
        if (hasOpen) sendClipboardSync(text)
      })
    }
    return () => {
      unsub()
      detach?.()
    }
  }, [sendClipboardSync])

  // ---- v4 (1.3): QoS cap — apply the prefs slider to every live transport ----
  // Fires on change AND keeps future pairings honest (beginSending seeds the
  // window per transport, so re-asserting the cap there would race the seed;
  // instead the wave loop's pacing gates enforce it continuously).
  // v5-a1: delegated to applyQosCapSplit — the user's cap is the AGGREGATE
  // budget across primary + fast lanes, so each transport gets cap/N.
  useEffect(() => {
    const unsub = usePrefsStore.subscribe((s) => applyQosCapSplit(s.qosCapMbps))
    applyQosCapSplit(usePrefsStore.getState().qosCapMbps)
    return unsub
  }, [])

  // ---- v5-b1: sender-requested remote wipe — public API ----
  // Sends WIPE_REQUEST for `transferId` over every live peer channel (the
  // receiver purges its vault entry + resume cache + buffers). P2P-only by
  // design: the peer that must wipe is by definition the one we just talked
  // to; a relay-mode leg has no DataChannel to carry the request.
  const requestRemoteWipe = useCallback((transferId: string, reason?: string): boolean => {
    if (!transferId) return false
    let sent = false
    for (const [peerId, peer] of senderPeersRef.current) {
      if (peer.rtc?.isOpen) {
        try { peer.rtc.sendWipeRequest(transferId, reason); sent = true } catch { /* per-leg best-effort */ }
        void peerId
      }
    }
    const rtc = getRtc()
    if (!sent && rtc?.isOpen) {
      try { rtc.sendWipeRequest(transferId, reason); sent = true } catch { /* best-effort */ }
    }
    if (sent) {
      console.log(`[FluxDrop] Remote wipe requested for transfer ${transferId.slice(0, 8)}`)
      toast.success('Remote wipe requested', {
        description: 'The receiver will purge its vault copy, resume cache and buffers of this transfer.',
      })
    } else {
      toast.error('No live channel to the receiver', {
        description: 'The peer must still be connected for a remote wipe — DataChannel only.',
      })
    }
    return sent
  }, [])

  // v5-b1: bridge from the summary card (dispatches 'fluxdrop:request-remote-wipe'
  // with { transferId } — same pattern as the v4 'fluxdrop:send-onward' event).
  useEffect(() => {
    const onWipe = (e: Event) => {
      const detail = (e as CustomEvent<{ transferId?: string }>).detail
      if (detail?.transferId) requestRemoteWipe(detail.transferId)
    }
    window.addEventListener('fluxdrop:request-remote-wipe', onWipe)
    return () => window.removeEventListener('fluxdrop:request-remote-wipe', onWipe)
  }, [requestRemoteWipe])

  // ---- v5-f19: speedrun race mode — the dialog hands the orchestrator a
  // fixed 2 MiB file and the NORMAL send pipeline runs it (the dialog times
  // accept → verified-complete and races the ghost locally). The view must
  // flip to 'sender' so the room code renders in SenderPanel (same pattern
  // as the deep-link/join flows in page.tsx). ----
  useEffect(() => {
    const onStart = (e: Event) => {
      const file = (e as CustomEvent<{ file?: File }>).detail?.file
      if (!file) return
      useSessionStore.getState().setView('sender')
      void startSend([file])
    }
    window.addEventListener('fluxdrop:start-speedrun-run', onStart)
    return () => window.removeEventListener('fluxdrop:start-speedrun-run', onStart)
  }, [startSend])

  // ---- v5-a1: terminal states tear every fast lane down (complete, cancel,
  // fail, error). PAUSED/RESUMING keep lanes — resume continuity. ----
  // v5-a2: the same rule closes every relay leg — terminal means terminal.
  useEffect(() => {
    const st = transfer.transferState
    if (st === 'COMPLETE' || st === 'CANCELLED' || st === 'FAILED' || st === 'ERROR') {
      teardownFastLanes()
      teardownRelay()
    }
  }, [transfer.transferState])

  return {
    session,
    transfer,
    connect,
    startSend,
    startReceive,
    cancelTransfer,
    acceptTransfer,
    rejectTransfer,
    pauseTransfer,
    resumeTransfer,
    requestPreviews,
    sendChat,
    sendClipboardSync,
    requestRemoteWipe,
    /** v5-c6: pull mode — send the picked library indices to the sender. */
    requestLibraryFiles,
    /** v5-c6: pull mode — request image thumbs for the pending library. */
    requestLibraryPreviews,
    /** v4 (6.2): verified received files of a completed transfer (for onward sending). */
    getReceivedFiles: (transferId: string): File[] | null => {
      const cached = receivedFilesCache.get(transferId)
      if (!cached || cached.length === 0) return null
      return cached.map((f) => new File([f.blob], f.name, { type: f.type || 'application/octet-stream' }))
    },
    cleanup,
  }
}
