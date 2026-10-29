// FluxDrop transfer store: live transfer state, progress, speed, errors.

'use client'

import { create } from 'zustand'
import type { TransferManifest, TransferState, FileManifestEntry } from '@/lib/fluxdrop/protocol'

export interface LiveFileProgress {
  index: number
  entry: FileManifestEntry
  receivedBytes: number
  complete: boolean
}

/**
 * v1.3 (6.1): a consent-dialog rich preview for one manifest file.
 * - blobUrl: object URL of an image thumbnail (image/* files).
 * - text: first lines of a text-ish file (decoded from the head bytes).
 * - mime/name/size are always set so the dialog can show a typed chip even
 *   when there is no visual preview.
 */
export interface FilePreview {
  blobUrl?: string
  text?: string
  mime: string
  name: string
  size: number
}

/**
 * v1.3 (6.1): live per-receiver progress for GROUP fan-out. Maintained by the
 * sender; rendered in the room roster so "who has what" is visible at a
 * glance while a transfer streams to several devices.
 */
export interface PeerTransferProgress {
  deviceId: string
  alias: string
  /** Chunks this peer holds (acked + skipped). */
  acked: number
  total: number
  state: 'pairing' | 'transferring' | 'complete' | 'left'
}

interface TransferStoreState {
  // Manifest (known after handshake)
  manifest: TransferManifest | null
  setManifest: (m: TransferManifest | null) => void

  // State machine
  transferState: TransferState
  setTransferState: (s: TransferState) => void

  // Chunk progress
  chunksAcked: number
  totalChunks: number
  bytesTransferred: number
  totalBytes: number
  /**
   * Count a chunk acknowledgement. Deduplicates by chunk index — duplicate
   * CHUNK_ACKs / CHUNK_DATA (send-retry double-sends) previously double-counted
   * bytes and made the live counter overshoot 100%. Returns true when the
   * index was new (first time seen), false for duplicates.
   */
  ackChunk: (chunkIndex: number, bytes: number) => boolean
  resetProgress: (totalChunks: number, totalBytes: number) => void
  /** Seed progress after skipping already-received chunks (resume flows). */
  seedProgress: (chunks: number, bytes: number) => void
  // Internal: batched ack state (not for UI use)
  _pendingChunks: number
  _pendingBytes: number
  _flushTimer: ReturnType<typeof setTimeout> | null
  /** Internal: every chunk index ever acked this transfer (dedupe source). */
  _ackedSet: Set<number>
  /** Snapshot of acked indices, refreshed on each flush — drives the chunk map. */
  ackedSet: Set<number>
  /** Indices that never travelled the wire on a resumed transfer (skip bitmap). */
  skippedIndices: Set<number>

  // Speed tracking
  startedAt: number | null
  startTimer: () => void
  elapsedMs: number
  speedBps: number
  tickSpeed: (now: number) => void
  _lastSpeedSampleAt: number | null
  _lastSpeedSampleBytes: number | null
  speedHistory: number[]   // last N speed samples for sparkline
  // Pause-aware elapsed tracking (excludes paused time from elapsedMs)
  _pausedAt: number | null
  _pausedTotalMs: number
  pauseTimer: () => void
  resumeTimer: () => void

  // Receiver snippet preview (small text file received — shown in a dialog)
  snippetPreview: { name: string; text: string } | null
  setSnippetPreview: (p: { name: string; text: string } | null) => void

  // v1.2 (4.4): consent-dialog rich previews, keyed by manifest file index.
  // Populated by PREVIEW_DATA frames while the consent dialog is up.
  filePreviews: Record<number, FilePreview>
  /** Set one file's preview. Revokes the previous blobUrl when overwritten. */
  setFilePreview: (index: number, preview: FilePreview) => void
  /** Drop every preview (revokes all blob URLs). Called on new manifest/cleanup. */
  clearFilePreviews: () => void

  // v1.3 (6.1): per-receiver live progress (sender-side group fan-out).
  peerProgress: Record<string, PeerTransferProgress>
  setPeerProgress: (p: PeerTransferProgress) => void
  removePeerProgress: (deviceId: string) => void
  clearPeerProgress: () => void

  /**
   * v1.3 (6.4): auto-accept with auto-save scope — v1.3-c consumes this to
   * save into the Files vault without pickers. Set by handleIncomingManifest
   * when the manifest was auto-accepted from a peer holding the 'autoSave'
   * trust scope; reset on every new manifest and in resetTransfer.
   */
  autoSaveToVault: boolean
  setAutoSaveToVault: (v: boolean) => void

  // File-level progress (receiver)
  files: LiveFileProgress[]
  initFiles: (entries: FileManifestEntry[]) => void
  addFileBytes: (index: number, bytes: number) => void
  markFileComplete: (index: number) => void

  // Errors
  error: string | null
  setError: (e: string | null) => void
  // Error log (persistent, doesn't disappear like toasts)
  errorLog: { timestamp: number; message: string; chunkIndex?: number }[]
  addErrorLog: (entry: { message: string; chunkIndex?: number }) => void
  clearErrorLog: () => void

  // Checksum verification
  checksumVerified: boolean | null
  setChecksumVerified: (v: boolean | null) => void

  // Resume
  resumeAvailable: boolean
  setResumeAvailable: (v: boolean) => void

  // Resume-skip stats: chunks/bytes that never travelled the wire because the
  // receiver already stored them from a previous attempt. Shown in the
  // progress card, the summary card, and the stats dashboard.
  skippedChunks: number
  skippedBytes: number
  setSkipped: (chunks: number, bytes: number, indices?: number[]) => void

  // Hashing progress (pre-transfer, during buildManifest)
  hashingProgress: { current: number; total: number; fileName: string } | null
  setHashingProgress: (p: { current: number; total: number; fileName: string } | null) => void

  // Reset
  resetTransfer: () => void
}

export const useTransferStore = create<TransferStoreState>((set, get) => ({
  manifest: null,
  setManifest: (m) =>
    set({
      manifest: m,
      totalChunks: m?.totalChunks ?? 0,
      totalBytes: m?.totalSize ?? 0,
      files: m ? m.files.map((entry, index) => ({ index, entry, receivedBytes: 0, complete: false })) : [],
    }),

  transferState: 'IDLE',
  setTransferState: (s) => set({ transferState: s }),

  chunksAcked: 0,
  totalChunks: 0,
  bytesTransferred: 0,
  totalBytes: 0,
  // Batched chunk ack: accumulate in memory, flush to Zustand every 100ms.
  // This prevents per-chunk re-renders (24K+ for a 1.5 GB file).
  // Dedupe: `_ackedSet` remembers every index seen, so duplicate acks from
  // send-retries never inflate the byte counter (the old overshoot bug).
  _pendingChunks: 0,
  _pendingBytes: 0,
  _flushTimer: null as ReturnType<typeof setTimeout> | null,
  _ackedSet: new Set<number>(),
  ackedSet: new Set<number>(),
  skippedIndices: new Set<number>(),
  ackChunk: (chunkIndex, bytes) => {
    const s = get()
    if (s._ackedSet.has(chunkIndex)) return false
    s._ackedSet.add(chunkIndex)
    s._pendingChunks++
    s._pendingBytes += bytes
    // Flush at most every 100ms (10 Hz).
    if (!s._flushTimer) {
      s._flushTimer = setTimeout(() => {
        set((st) => ({
          // Defensive caps: even if seeded skip stats slightly overestimate
          // (e.g. last-chunk rounding), the UI must never exceed 100%.
          chunksAcked: Math.min(st.totalChunks || Infinity, st.chunksAcked + st._pendingChunks),
          bytesTransferred: Math.min(st.totalBytes || Infinity, st.bytesTransferred + st._pendingBytes),
          ackedSet: new Set(st._ackedSet),
          _pendingChunks: 0,
          _pendingBytes: 0,
          _flushTimer: null,
        }))
      }, 100)
    }
    return true
  },
  resetProgress: (totalChunks, totalBytes) =>
    set((st) => ({
      chunksAcked: 0,
      totalChunks,
      totalBytes,
      bytesTransferred: 0,
      elapsedMs: 0,
      speedBps: 0,
      // perf/resume-1: keep the speed sampler ARMED when a timer is already
      // running (resume legs / re-delivered manifests). The old code nulled
      // the baselines, which disarmed tickSpeed forever — receiver speed
      // froze at 0 after ANY reconnect until the next explicit startTimer.
      _lastSpeedSampleAt: st.startedAt ? Date.now() : null,
      _lastSpeedSampleBytes: 0,
      speedHistory: [],
      _pausedAt: null,
      _pausedTotalMs: 0,
      checksumVerified: null,
      _pendingChunks: 0,
      _pendingBytes: 0,
      _flushTimer: null,
      _ackedSet: new Set<number>(),
      ackedSet: new Set<number>(),
      skippedIndices: new Set<number>(),
    })),

  // NOTE: resetProgress deliberately leaves skippedChunks/skippedBytes alone —
  // it runs when a manifest arrives, BEFORE the RESUME_QUERY handshake reports
  // skips. startSend zeroes them explicitly so a fresh send never inherits a
  // previous transfer's stats; resetTransfer also clears them.
  seedProgress: (chunks, bytes) =>
    set((st) => ({
      chunksAcked: chunks,
      bytesTransferred: bytes,
      // Sync speed-sampling baselines so the seeded progress doesn't show up
      // as a giant instantaneous speed spike. perf/resume-1: also (re-)arm
      // the sampler clock — a null sample time left tickSpeed dead.
      _lastSpeedSampleBytes: bytes,
      _lastSpeedSampleAt: st._lastSpeedSampleAt ?? Date.now(),
      _pendingChunks: 0,
      _pendingBytes: 0,
    })),

  startedAt: null,
  startTimer: () => set({ startedAt: Date.now(), _lastSpeedSampleAt: Date.now(), _lastSpeedSampleBytes: 0, _pausedAt: null, _pausedTotalMs: 0 }),
  elapsedMs: 0,
  speedBps: 0,
  _pausedAt: null,
  _pausedTotalMs: 0,
  pauseTimer: () => {
    const s = get()
    if (s._pausedAt != null) return
    set({ _pausedAt: Date.now() })
  },
  resumeTimer: () => {
    const s = get()
    if (s._pausedAt == null) return
    set({
      _pausedTotalMs: s._pausedTotalMs + (Date.now() - s._pausedAt),
      _pausedAt: null,
    })
  },
  tickSpeed: (now) => {
    const s = get()
    if (!s.startedAt || s._lastSpeedSampleAt == null) return
    const dt = now - s._lastSpeedSampleAt
    if (dt < 500) return // sample at most every 500ms
    const dBytes = s.bytesTransferred - (s._lastSpeedSampleBytes ?? 0)
    const speed = (dBytes / dt) * 1000
    // Elapsed excludes time spent paused (live pause window included).
    const pausedMs = s._pausedTotalMs + (s._pausedAt != null ? now - s._pausedAt : 0)
    // perf/resume-1: only feed the sparkline/history while the stream is live
    // (or data actually moved). Paused / resuming / dead-air periods used to
    // bury the history in zero samples — the "all-zero speed graph" bug from
    // the field report.
    const streaming = s.transferState === 'TRANSFERRING'
    const counts = streaming || dBytes > 0
    set({
      speedBps: counts ? speed : 0,
      elapsedMs: Math.max(0, now - s.startedAt - pausedMs),
      _lastSpeedSampleAt: now,
      _lastSpeedSampleBytes: s.bytesTransferred,
      speedHistory: counts ? [...s.speedHistory, speed].slice(-40) : s.speedHistory,
    })
  },
  _lastSpeedSampleAt: null,
  _lastSpeedSampleBytes: null,
  speedHistory: [],

  snippetPreview: null,
  setSnippetPreview: (p) => set({ snippetPreview: p }),

  filePreviews: {},
  setFilePreview: (index, preview) => {
    // Revoke the old object URL (if any) so image previews never leak.
    const prev = get().filePreviews[index]
    if (prev?.blobUrl) {
      try { URL.revokeObjectURL(prev.blobUrl) } catch { /* noop */ }
    }
    set((s) => ({ filePreviews: { ...s.filePreviews, [index]: preview } }))
  },
  clearFilePreviews: () => {
    for (const p of Object.values(get().filePreviews)) {
      if (p.blobUrl) {
        try { URL.revokeObjectURL(p.blobUrl) } catch { /* noop */ }
      }
    }
    set({ filePreviews: {} })
  },

  peerProgress: {},
  setPeerProgress: (p) => set((s) => ({ peerProgress: { ...s.peerProgress, [p.deviceId]: p } })),
  removePeerProgress: (deviceId) =>
    set((s) => {
      if (!(deviceId in s.peerProgress)) return s
      const next = { ...s.peerProgress }
      delete next[deviceId]
      return { peerProgress: next }
    }),
  clearPeerProgress: () => set({ peerProgress: {} }),

  // v1.3 (6.4): auto-accept with auto-save scope — v1.3-c consumes this to
  // save into the Files vault without pickers.
  autoSaveToVault: false,
  setAutoSaveToVault: (v) => set({ autoSaveToVault: v }),

  files: [],
  initFiles: (entries) =>
    set({ files: entries.map((entry, index) => ({ index, entry, receivedBytes: 0, complete: false })) }),
  addFileBytes: (index, bytes) =>
    set((s) => ({
      files: s.files.map((f) =>
        f.index === index ? { ...f, receivedBytes: Math.min(f.entry.size, f.receivedBytes + bytes) } : f
      ),
    })),
  markFileComplete: (index) =>
    set((s) => ({
      files: s.files.map((f) =>
        f.index === index ? { ...f, receivedBytes: f.entry.size, complete: true } : f
      ),
    })),

  error: null,
  setError: (e) => set({ error: e }),
  errorLog: [],
  addErrorLog: (entry) => set((s) => ({
    errorLog: [...s.errorLog, { timestamp: Date.now(), ...entry }].slice(-20) // keep last 20
  })),
  clearErrorLog: () => set({ errorLog: [] }),

  checksumVerified: null,
  setChecksumVerified: (v) => set({ checksumVerified: v }),

  resumeAvailable: false,
  setResumeAvailable: (v) => set({ resumeAvailable: v }),

  skippedChunks: 0,
  skippedBytes: 0,
  setSkipped: (chunks, bytes, indices) =>
    set({
      skippedChunks: chunks,
      skippedBytes: bytes,
      skippedIndices: indices ? new Set(indices) : new Set<number>(),
    }),

  hashingProgress: null,
  setHashingProgress: (p) => set({ hashingProgress: p }),

  resetTransfer: () => {
    // Revoke any live preview object URLs before wiping the map.
    for (const p of Object.values(get().filePreviews)) {
      if (p.blobUrl) {
        try { URL.revokeObjectURL(p.blobUrl) } catch { /* noop */ }
      }
    }
    set({
      manifest: null,
      transferState: 'IDLE',
      chunksAcked: 0,
      totalChunks: 0,
      bytesTransferred: 0,
      totalBytes: 0,
      startedAt: null,
      elapsedMs: 0,
      speedBps: 0,
      _lastSpeedSampleAt: null,
      _lastSpeedSampleBytes: null,
      speedHistory: [],
      files: [],
      error: null,
      checksumVerified: null,
      resumeAvailable: false,
      hashingProgress: null,
      snippetPreview: null,
      _pausedAt: null,
      _pausedTotalMs: 0,
      _pendingChunks: 0,
      _pendingBytes: 0,
      _flushTimer: null,
      _ackedSet: new Set<number>(),
      ackedSet: new Set<number>(),
      skippedIndices: new Set<number>(),
      skippedChunks: 0,
      skippedBytes: 0,
      filePreviews: {},
      peerProgress: {},
      // v1.3 (6.4): auto-accept with auto-save scope — v1.3-c consumes this
      // to save into the Files vault without pickers.
      autoSaveToVault: false,
    })
  },
}))
