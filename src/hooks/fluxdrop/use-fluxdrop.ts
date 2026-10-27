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
import { FluxDropWebRTC } from '@/lib/fluxdrop/webrtc'
import { buildManifest, buildSlicePlan, resolveChunk } from '@/lib/fluxdrop/manifest'
import { verifyChecksum, hashBlobRange } from '@/lib/fluxdrop/checksum'
import { destroyHashWorker } from '@/lib/fluxdrop/hash-worker-client'
import { validateFiles, formatBytes } from '@/lib/fluxdrop/format'
import { randomUUID } from '@/lib/fluxdrop/random'
import {
  saveTransferRecord,
  updateTransferRecord,
  getTransferRecord,
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
import { saveToVault, vaultSupported, enforceVaultBudget } from '@/lib/fluxdrop/vault'
import { resolveSaveConflicts } from '@/components/fluxdrop/save-conflict-dialog'
import type { FilePreview } from '@/stores/transfer-store'
import { useChatStore } from '@/stores/chat-store'
import { addRecentRoom } from '@/lib/fluxdrop/recent-rooms'
import { isTrustedPeer, addTrustedPeer } from '@/lib/fluxdrop/trusted-peers'
import { playSuccess, playError, playConnect, playPause, playResume } from '@/lib/fluxdrop/sound'
import { MessageType, CONSTANTS, type TransferManifest, type TransferSummary, type TransferState } from '@/lib/fluxdrop/protocol'
import { gzipCompress, gzipDecompress, shouldCompressTransfer, isCompressionSupported } from '@/lib/fluxdrop/compress'
import { fetchTurnCredentials, mergeTurnIntoIceServers } from '@/lib/fluxdrop/turn'
import {
  E2EHandshake,
  activateE2ESession,
  decryptWirePayload,
  encryptWirePayload,
  isE2EActive,
  isE2EActiveForPeer,
  isE2EActiveForRoom,
  resetE2ESession,
  setE2EStatus,
  type E2ERelayMessage,
} from '@/lib/fluxdrop/e2e'
import { toast } from 'sonner'

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
  rtc: FluxDropWebRTC
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

const PREVIEW_HEAD_BYTES = 24 * 1024
const PREVIEW_MAX_FILES = 8
const PREVIEW_WAIT_MS = 4000

// v1.3 (6.3): in-room chat constraints (mirrored by the chat panel UI).
const CHAT_MAX_LEN = 2000
// Chat frames are transfer-agnostic: the header's transferId field stays zero.
const CHAT_WIRE_TRANSFER_ID = '0'

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

export function useFluxDrop() {
  const session = useSessionStore()
  const transfer = useTransferStore()

  // Refs that always hold the latest values for use inside long-lived callbacks.
  const sessionRef = useRef(session)
  const transferRef = useRef(transfer)
  useEffect(() => { sessionRef.current = session }, [session])
  useEffect(() => { transferRef.current = transfer }, [transfer])

  const signalingRef = useRef<FluxDropSignaling | null>(null)
  // v1.3 (6.1): ALL peer connections live here (sender → one per receiver;
  // receiver → one entry keyed by the sender's deviceId). Lookup helper below.
  const peerRtcsRef = useRef<Map<string, FluxDropWebRTC>>(new Map())
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
          const { reply } = hs.processHello({ salt: data.salt, xPub: data.xPub })
          e2eHandshakesRef.current.set(payload.from, hs)
          e2eGenRef.current++
          s.setE2EStatus('handshaking')
          signalingRef.current?.sendE2ERelay({
            roomId,
            from: s.deviceId,
            to: payload.from,
            data: { type: 'reply', v: 1, yPub: reply.yPub } satisfies E2ERelayMessage,
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
          const { confirmMac } = hs.processReply({ yPub: data.yPub })
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
          await activateE2ESession(hs.aesKeyRaw, sas, roomId, payload.from)
          e2eGenRef.current++
          useSessionStore.getState().setE2EStatus('active')
          useSessionStore.getState().setE2ESas(sas)
          console.log(`[FluxDrop] E2E: session ACTIVE (SAS ${sas})`)
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
    try { peer.rtc.close() } catch { /* ignore */ }
    peerRtcsRef.current.delete(deviceId)
    senderPeersRef.current.delete(deviceId)
    requiredPeersRef.current.delete(deviceId)
    transferRef.current.removePeerProgress(deviceId)
    recomputeAggregateAfterDrop()
    const st = transferRef.current.transferState
    const anyActive = [...senderPeersRef.current.values()].some((p) => p.active && p.rtc.isOpen)
    if (!anyActive && (st === 'TRANSFERRING' || st === 'PAUSED')) {
      transferRef.current.setTransferState('RESUMING')
      toast.warning('All receivers left the room', {
        description: 'Waiting for a device to re-join — progress is kept and the transfer resumes automatically.',
      })
    } else if (st === 'TRANSFERRING' || st === 'PAUSED') {
      toast.info('A receiver left — continuing to the remaining devices')
    }
  }, [recomputeAggregateAfterDrop])

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
          sig.sendPairingRequest({
            roomId: payload.roomId,
            from: sessionRef.current.deviceId,
            to: peerDeviceIdRef.current!,
          })
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
      onPairingRequest: (payload: { from: string; transferSummary?: TransferSummary }) => {
        // Sender receives pairing request from a receiver -> auto-accept &
        // initiate a DEDICATED WebRTC connection for this peer (v1.3 groups:
        // one offer per receiver; several can pair into the same room).
        if (!peerDeviceIdRef.current) peerDeviceIdRef.current = payload.from
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
        void handleOfferAsReceiver(payload.sdp)
      },
      onWebRtcAnswer: (payload) => {
        getRtc(payload.from)?.acceptAnswer(payload.sdp)
      },
      onWebRtcIce: (payload) => {
        getRtc(payload.from)?.addIceCandidate(payload.candidate)
      },
      onTransferManifest: (payload) => {
        peerDeviceIdRef.current = payload.from
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
        if (payload.accepted) {
          const peerId = payload.from
          if (peerId && senderPeersRef.current.has(peerId)) {
            senderPeersRef.current.get(peerId)!.accepted = true
            if (!requiredPeersRef.current.has(peerId) && senderPeersRef.current.size > 0 && transferRef.current.transferState !== 'TRANSFERRING') {
              requiredPeersRef.current.add(peerId)
            }
          }
          const acceptors = [...senderPeersRef.current.values()].filter((p) => p.accepted).length
          toast.success(`Transfer accepted${acceptors > 1 ? ` by ${acceptors} devices` : ''}`)
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
        void handleE2ERelayPayload(payload)
      },
      onSignalingError: (payload) => {
        toast.error(`Signaling error: ${payload.code}`, { description: payload.message })
      },
    })
    sig.connect()
    signalingRef.current = sig
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
        // v1.3: retry re-offers to every known receiver.
        const targets = new Set<string>(requiredPeersRef.current)
        if (peerDeviceIdRef.current) targets.add(peerDeviceIdRef.current)
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

  // ---- Real resume: attempt to reconnect after DataChannel loss ----
  // On DC close during TRANSFERRING, persist state and try to restart ICE.
  // The sender re-creates the offer; the receiver re-answers.
  // After reconnection, the receiver sends RESUME_REQUEST with the last
  // acked chunk index, and the sender resumes from there.
  const attemptResume = useCallback(async () => {
    const m = manifestRef.current
    if (!m) return

    // v1.1: bounded automatic retries with exponential backoff. The DC-close
    // → re-offer path already existed; what was missing was a cap — an
    // unreachable peer used to loop resume attempts forever.
    if (resumeAttemptsRef.current >= RESUME_ATTEMPT_MAX) {
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

  // ---- Sender: initiate WebRTC as the offerer (per receiver, v1.3 groups) ----
  // Every receiver gets its OWN RTCPeerConnection + DataChannel. The manifest
  // is (re-)sent on THIS peer's channel when it opens — each peer consents,
  // and its E2E handshake is negotiated independently.
  const initiateWebRTCAsSender = useCallback(async (peerId: string | null) => {
    if (!peerId) return
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
              if (
                rtcNow &&
                rtcNow.connectionState !== 'connected' &&
                transferRef.current.transferState === 'TRANSFERRING'
              ) {
                console.warn('[FluxDrop] Still disconnected after grace period — resuming')
                transferRef.current.setTransferState('RESUMING')
                void attemptResume()
              }
            }, 8000)
          } else if (state === 'failed') {
            // v1.3: a single peer failing doesn't kill a group send — drop
            // that peer and continue with the rest. Solo senders keep the
            // full retry flow.
            const othersLive = [...senderPeersRef.current.values()].some(
              (p) => p.id !== peerId && p.active && p.rtc.isOpen
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
          if (!m) return
          // A late connection with a live transfer keeps the global state.
          if (isNewLeg) {
            // Fresh aggregate for the redelivery leg (files card, progress).
            transferRef.current.resetProgress(m.totalChunks, m.totalSize)
            transferRef.current.initFiles(m.files)
            transferRef.current.setTransferState('MANIFEST_EXCHANGE')
          } else if (stOpen !== 'TRANSFERRING' && stOpen !== 'PAUSED') {
            transferRef.current.setTransferState('MANIFEST_EXCHANGE')
          }
          // Resume leg for this peer: query its stored-chunk bitmap instead
          // of re-sending everything (v1.1 bitmap handshake, per peer now).
          if (wasResuming && filesRef.current.length > 0) {
            console.log(`[FluxDrop] Sender resume: querying receiver ${peerId.slice(0, 8)} stored-chunk bitmap`)
            peer.skipQueryPending = true
            transferRef.current.setTransferState('TRANSFERRING')
            rtcOpen?.sendResumeQuery(m.transferId)
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
            if (!peerNow || !mEnc || !rtcNow?.isOpen) return
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
              (p) => p.id !== peerId && p.active && p.rtc.isOpen
            )
            if (!othersLive) {
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
    if (transferLive && sessionRef.current.dataChannelOpen) {
      console.warn('[FluxDrop] Ignoring redundant offer — transfer already streaming on an open DataChannel')
      return
    }
    const senderId = peerDeviceIdRef.current
    const oldRtc = senderId ? peerRtcsRef.current.get(senderId) : null
    if (oldRtc) {
      try { oldRtc.close() } catch { /* ignore */ }
      if (senderId) peerRtcsRef.current.delete(senderId)
    }
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
          }
          if (state === 'failed') {
            handleConnectionFailure('receiver')
          }
        },
        onDataChannelOpen: () => {
          sessionRef.current.setDataChannelOpen(true)
          sessionRef.current.setRetryCount(0)
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
  }, [])

  // ---- DataChannel message router ----
  // v1.3 (6.1): `fromPeerId` identifies which peer connection the frame came
  // from. SENDER-side cases (MANIFEST_ACK / CHUNK_ACK / completion acks /
  // preview requests) route per peer; RECEIVER-side cases use it to address
  // replies back to the sender.
  const handleDataChannelMessage = useCallback(async (msg: any, fromPeerId?: string | null) => {
    const m = manifestRef.current
    const peerId = fromPeerId ?? peerDeviceIdRef.current
    const rtcFrom = getRtc(peerId)

    // Shared chunk-accept pipeline (v1.1): used by BOTH CHUNK_DATA and the
    // gzip variant. Bytes arriving here are always ORIGINAL (decompressed)
    // data — bitmaps, byte offsets, and checksums never see the wire format.
    const processReceivedChunk = async (mm: TransferManifest, chunkIndex: number, bytes: ArrayBuffer) => {
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
      if (shouldStreamReceive(mm) && !receiverStreamBrokenRef.current) {
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
      if (chunkIndex === mm.totalChunks - 1) {
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
              peer.skipQueryPending = true
              console.log(`[FluxDrop] Sending resume-skip query to ${peerId.slice(0, 8)} for ${m.transferId.slice(0, 8)}`)
              peer.rtc.sendResumeQuery(m.transferId)
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
        if (!m || filesRef.current.length === 0) break
        try {
          const req = JSON.parse(new TextDecoder().decode(msg.payload)) as {
            v?: number
            files?: { i: number; bytes: number }[]
          }
          if (req?.v !== 1 || !Array.isArray(req.files)) break
          const rtcPreview = rtcFrom
          if (!rtcPreview?.isOpen) break
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
                rtcPreview.sendRawFrame(MessageType.PREVIEW_DATA, m.transferId, idx, body)
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
        if (!m) break
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
            const acked: number[] = []
            for (const i of ackedSet) {
              // v1.3 (1.6): OPFS-temp chunks count as held too (same session —
              // the still-open writable holds their bytes until it commits at
              // completion; discardReceiverTemp clears the set when they die).
              if (
                i >= 0 &&
                i < m.totalChunks &&
                (stored.has(i) || receiverBuffersRef.current.has(i) || opfsWrittenRef.current.has(i))
              ) {
                acked.push(i)
              }
            }
            console.log(`[FluxDrop] Resume-skip: record acks=${ackedSet.size}, stored=${stored.size}, usable=${acked.length}`)
            if (acked.length > 0) {
              const storedBytes = Math.min(acked.length * m.chunkSize, m.totalSize)
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
              const pct = Math.round((acked.length / m.totalChunks) * 100)
              console.log(`[FluxDrop] Resume-skip: ${acked.length}/${m.totalChunks} chunks already stored (${pct}%) — answering sender`)
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
  const doAcceptTransfer = useCallback(async (m: TransferManifest) => {
    sessionRef.current.setPendingManifest(null)
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    getRtc()?.sendManifestAck(m.transferId, true)
    signalingRef.current?.sendTransferAccepted({
      roomId: sessionRef.current.roomId!,
      from: sessionRef.current.deviceId,
      to: peerDeviceIdRef.current!,
      accepted: true,
    })
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
  const acceptTransfer = useCallback(async (trust = false) => {
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
    await doAcceptTransfer(m)
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
  }, [persistTransferRecord, finishReceiverStreamed])

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
      if (transferRef.current.chunksAcked >= m.totalChunks) {
        receiverCompleteTicksRef.current++
        // Two consecutive ticks (~2s) — let late in-flight chunks land first.
        if (receiverCompleteTicksRef.current >= 2) {
          receiverCompleteTicksRef.current = 0
          console.log(`[FluxDrop] Receiver completion poll: all ${m.totalChunks} chunks acked — finishing transfer`)
          void finishReceiverTransfer()
        }
      } else {
        receiverCompleteTicksRef.current = 0
      }
    }, 1000)
    return () => clearInterval(id)
  }, [finishReceiverTransfer])

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
    // Create the sender's record NOW so the debounced CHUNK_ACK flushes have
    // something to merge into — before this, the record only appeared at a
    // terminal state and every interim ack flush was silently dropped.
    void persistTransferRecord('sender', 'TRANSFERRING')
    const plan = slicePlanRef.current

    // v1.1: pipelining order + wire compression for this send session.
    const order = buildSendOrder(m, plan)
    sendOrderRef.current = order
    const useGzip = m.compression === 'gzip' && isCompressionSupported()
    const totalChunks = m.totalChunks

    // Any peer channel still open?
    const anyPeerOpen = () =>
      [...senderPeersRef.current.values()].some((p) => p.active && p.rtc.isOpen)

    // Every active peer fully delivered (position at end + all chunks held)?
    const peerHoldsAll = (p: SenderPeer) =>
      p.acked.size + p.skip.size >= totalChunks

    try {
      /**
       * Read and compose a chunk from potentially multiple file segments,
       * with a small shared cache — group peers often move in lockstep, so
       * one read serves several sends. Cap bounds memory (~64 × 256 KB).
       */
      const readCache = new Map<number, ArrayBuffer>()
      const readChunk = async (chunkIndex: number): Promise<ArrayBuffer | null> => {
        const cached = readCache.get(chunkIndex)
        if (cached) return cached
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
        if (readCache.size >= CONSTANTS.FANOUT_READ_CACHE) {
          const oldest = readCache.keys().next().value
          if (oldest !== undefined) readCache.delete(oldest)
        }
        readCache.set(chunkIndex, out)
        return out
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
          const pRtc = peer.rtc
          if (!pRtc.isOpen) continue
          if (peer.nextPos >= order.length) {
            minPos = Math.min(minPos, peer.nextPos)
            continue
          }
          const i = order[peer.nextPos]
          minPos = Math.min(minPos, peer.nextPos)
          // Chunk already stored by THIS receiver (resume bitmap) — skip.
          if (peer.skip.has(i)) {
            peer.nextPos++
            progressed = true
            continue
          }
          // Backpressure: wait for THIS peer's buffer to drain (bounded by
          // waitForDrain's own 10s timeout), then move on to other peers.
          if (!pRtc.canSend()) {
            await pRtc.waitForDrain()
            if (sendLoopGenRef.current !== myGen) return
            if (!pRtc.isOpen) continue
            continue
          }
          const buf = await readChunk(i)
          if (!buf) {
            peer.nextPos++
            progressed = true
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
          const sent = pRtc.sendChunkData(m.transferId, i, wireBuf, wireOpts)
          if (sent) {
            peer.nextPos++
            progressed = true
          } else {
            // Transient failure (queue pressure) — drain and retry next round.
            await pRtc.waitForDrain()
            if (sendLoopGenRef.current !== myGen) return
          }
          // Yield periodically so the UI can update.
          if (i % 128 === 0) {
            await new Promise((r) => setTimeout(r, 0))
          }
        }
        senderNextIndexRef.current = minPos

        // Per-peer completion: position at the end + all chunks acked/skipped
        // → announce TRANSFER_COMPLETE to that peer (it replies with the
        // verified ack, which drives the global completion via
        // markPeerCompleted).
        for (const peer of senderPeersRef.current.values()) {
          if (!peer.active || peer.completedSent || !peer.rtc.isOpen) continue
          if (peer.nextPos >= order.length && peerHoldsAll(peer)) {
            peer.completedSent = true
            const combined = m.files.map((f) => f.checksum).join('')
            peer.rtc.sendTransferComplete(m.transferId, combined)
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
      if (idx >= (transferRef.current.manifest?.totalChunks ?? Infinity)) {
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

  // ---- Public API: start a send session ----
  // `resumeManifest` (optional) re-uses an earlier transfer's manifest so
  // history-resume keeps the same transferId, checksums, and record. When
  // provided, files must exactly match the manifest (name + size) and hashing
  // is skipped — checksums are already baked into the manifest.
  const startSend = useCallback(async (files: File[], resumeManifest?: TransferManifest) => {
    try {
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
    const targets: { peerId: string | null; rtc: FluxDropWebRTC }[] = []
    for (const peer of senderPeersRef.current.values()) {
      if (peer.rtc.isOpen) targets.push({ peerId: peer.id, rtc: peer.rtc })
    }
    if (targets.length === 0) {
      const rtc = getRtc()
      if (rtc?.isOpen) targets.push({ peerId: peerDeviceIdRef.current, rtc })
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
      if (peer.rtc.isOpen) peer.rtc.sendPause(m.transferId)
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
      if (peer.rtc.isOpen) peer.rtc.sendResumeStream(m.transferId)
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
        if (peer.rtc.isOpen) peer.rtc.sendCancel(m.transferId, reason)
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
    // v1.3: close EVERY peer connection (group fan-out).
    for (const rtc of peerRtcsRef.current.values()) {
      try { rtc.close() } catch { /* ignore */ }
    }
    peerRtcsRef.current.clear()
    senderPeersRef.current.clear()
    requiredPeersRef.current.clear()
    chunkAckVotersRef.current.clear()
    signalingRef.current?.leaveRoom()
    signalingRef.current?.disconnect()
    signalingRef.current = null
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
    cleanup,
  }
}
