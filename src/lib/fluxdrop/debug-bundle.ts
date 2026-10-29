// v4 (9.4): structured diagnostics export — one-click debug bundle.
// Collects a SANITIZED snapshot (no file names unless the user allowed them
// in diagnostics, no IPs beyond the ICE pair the user already sees) covering
// the ICE pair, transport class, flow window, throughput samples, chunk
// timeline, transparency telemetry and session facts. Copy-to-clipboard or
// download as .json.

'use client'

import { getTransparencyReport } from './telemetry'
import { useSessionStore } from '@/stores/session-store'
import { useTransferStore } from '@/stores/transfer-store'

export interface DebugBundleOptions {
  /** Include file names (default false — privacy first). */
  includeFileNames?: boolean
}

export async function collectDebugBundle(opts: DebugBundleOptions = {}): Promise<string> {
  const session = useSessionStore.getState()
  const transfer = useTransferStore.getState()
  const telemetry = getTransparencyReport()

  const bundle = {
    app: 'FluxDrop',
    schema: 'fluxdrop-debug-bundle/1',
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    // Session facts (identity-safe: alias is rotated per session by design)
    session: {
      view: session.view,
      role: transfer.manifest ? (session.peers.some((p) => p.role === 'receiver') ? 'sender' : 'receiver') : 'unknown',
      signalingConnected: session.signalingConnected,
      roomId: session.roomId,
      e2eStatus: session.e2eStatus,
      hasE2eSas: !!session.e2eSas,
      rtcState: session.rtcState,
      dataChannelOpen: session.dataChannelOpen,
      iceGatheringState: session.iceGatheringState,
      iceConnectionState: session.iceConnectionState,
    },
    transfer: transfer.manifest
      ? {
          transferId: transfer.manifest.transferId,
          state: transfer.transferState,
          totalSize: transfer.manifest.totalSize,
          totalChunks: transfer.manifest.totalChunks,
          chunkSize: transfer.manifest.chunkSize,
          compression: transfer.manifest.compression ?? 'none',
          merkleRoot: transfer.manifest.merkle?.root ?? null,
          bytesTransferred: transfer.bytesTransferred,
          chunksAcked: transfer.chunksAcked,
          skippedChunks: transfer.skippedChunks,
          elapsedMs: transfer.elapsedMs,
          // perf/resume-1: a REAL average (total bytes over pause-aware
          // elapsed time) — the old field just duplicated currentSpeed, which
          // made every stalled transfer read as "0 B/s average".
          averageSpeed:
            transfer.elapsedMs > 0
              ? Math.round((transfer.bytesTransferred / transfer.elapsedMs) * 1000)
              : 0,
          currentSpeed: Math.round(transfer.speedBps),
          speedHistory: transfer.speedHistory?.slice(-24) ?? [],
          ...(opts.includeFileNames
            ? { files: transfer.manifest.files.map((f) => `${f.name} (${f.size}B)`) }
            : { fileCount: transfer.manifest.files.length }),
        }
      : null,
    diagnostics: session.diagnostics
      ? {
          selectedPair: session.diagnostics.selectedPair ?? null,
          bytesSent: session.diagnostics.bytesSent,
          bytesReceived: session.diagnostics.bytesReceived,
        }
      : null,
    transparency: {
      signalingEventsOut: telemetry.totalOut,
      signalingEventsIn: telemetry.totalIn,
      signalingBytesOut: telemetry.signalingBytesOut,
      signalingBytesIn: telemetry.signalingBytesIn,
      datachannelBytesSent: telemetry.datachannelBytesSent,
      datachannelBytesReceived: telemetry.datachannelBytesReceived,
      iceCandidateTypes: {
        local: telemetry.iceCandidates.localTypes,
        remote: telemetry.iceCandidates.remoteTypes,
        sawIpv4: telemetry.iceCandidates.sawIpv4,
        sawIpv6: telemetry.iceCandidates.sawIpv6,
      },
      recentEvents: telemetry.events.slice(-40).map((e) => ({
        ts: new Date(e.ts).toISOString(),
        dir: e.dir,
        event: e.event,
        bytes: e.bytes,
      })),
    },
  }
  return JSON.stringify(bundle, null, 2)
}

export async function copyDebugBundle(opts: DebugBundleOptions = {}): Promise<boolean> {
  try {
    const text = await collectDebugBundle(opts)
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function downloadDebugBundle(opts: DebugBundleOptions = {}): Promise<boolean> {
  try {
    const text = await collectDebugBundle(opts)
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fluxdrop-debug-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    return true
  } catch {
    return false
  }
}
