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
  ackChunk: (bytes: number) => void
  resetProgress: (totalChunks: number, totalBytes: number) => void
  /** Seed progress after skipping already-received chunks (resume flows). */
  seedProgress: (chunks: number, bytes: number) => void
  // Internal: batched ack state (not for UI use)
  _pendingChunks: number
  _pendingBytes: number
  _flushTimer: ReturnType<typeof setTimeout> | null

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
  _pendingChunks: 0,
  _pendingBytes: 0,
  _flushTimer: null as ReturnType<typeof setTimeout> | null,
  ackChunk: (bytes) => {
    const s = get()
    s._pendingChunks++
    s._pendingBytes += bytes
    // Flush at most every 100ms (10 Hz).
    if (!s._flushTimer) {
      s._flushTimer = setTimeout(() => {
        set((st) => ({
          chunksAcked: st.chunksAcked + st._pendingChunks,
          bytesTransferred: st.bytesTransferred + st._pendingBytes,
          _pendingChunks: 0,
          _pendingBytes: 0,
          _flushTimer: null,
        }))
      }, 100)
    }
  },
  resetProgress: (totalChunks, totalBytes) =>
    set({
      chunksAcked: 0,
      totalChunks,
      totalBytes,
      bytesTransferred: 0,
      elapsedMs: 0,
      speedBps: 0,
      _lastSpeedSampleAt: null,
      _lastSpeedSampleBytes: null,
      speedHistory: [],
      _pausedAt: null,
      _pausedTotalMs: 0,
      checksumVerified: null,
      _pendingChunks: 0,
      _pendingBytes: 0,
      _flushTimer: null,
    }),

  seedProgress: (chunks, bytes) =>
    set((st) => ({
      chunksAcked: chunks,
      bytesTransferred: bytes,
      // Sync speed-sampling baselines so the seeded progress doesn't show up
      // as a giant instantaneous speed spike.
      _lastSpeedSampleBytes: bytes,
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
    const history = [...s.speedHistory, speed].slice(-40) // keep last 40 samples
    // Elapsed excludes time spent paused (live pause window included).
    const pausedMs = s._pausedTotalMs + (s._pausedAt != null ? now - s._pausedAt : 0)
    set({
      speedBps: speed,
      elapsedMs: Math.max(0, now - s.startedAt - pausedMs),
      _lastSpeedSampleAt: now,
      _lastSpeedSampleBytes: s.bytesTransferred,
      speedHistory: history,
    })
  },
  _lastSpeedSampleAt: null,
  _lastSpeedSampleBytes: null,
  speedHistory: [],

  snippetPreview: null,
  setSnippetPreview: (p) => set({ snippetPreview: p }),

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

  hashingProgress: null,
  setHashingProgress: (p) => set({ hashingProgress: p }),

  resetTransfer: () =>
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
    }),
}))
