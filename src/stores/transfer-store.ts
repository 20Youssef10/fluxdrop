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

  // Speed tracking
  startedAt: number | null
  startTimer: () => void
  elapsedMs: number
  speedBps: number
  tickSpeed: (now: number) => void
  _lastSpeedSampleAt: number | null
  _lastSpeedSampleBytes: number | null
  speedHistory: number[]   // last N speed samples for sparkline

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
  ackChunk: (bytes) =>
    set((s) => ({
      chunksAcked: s.chunksAcked + 1,
      bytesTransferred: s.bytesTransferred + bytes,
    })),
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
      checksumVerified: null,
    }),

  startedAt: null,
  startTimer: () => set({ startedAt: Date.now(), _lastSpeedSampleAt: Date.now(), _lastSpeedSampleBytes: 0 }),
  elapsedMs: 0,
  speedBps: 0,
  tickSpeed: (now) => {
    const s = get()
    if (!s.startedAt || s._lastSpeedSampleAt == null) return
    const dt = now - s._lastSpeedSampleAt
    if (dt < 500) return // sample at most every 500ms
    const dBytes = s.bytesTransferred - (s._lastSpeedSampleBytes ?? 0)
    const speed = (dBytes / dt) * 1000
    const history = [...s.speedHistory, speed].slice(-40) // keep last 40 samples
    set({
      speedBps: speed,
      elapsedMs: now - s.startedAt,
      _lastSpeedSampleAt: now,
      _lastSpeedSampleBytes: s.bytesTransferred,
      speedHistory: history,
    })
  },
  speedHistory: [],

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
    }),
}))
