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
import { verifyChecksum } from '@/lib/fluxdrop/checksum'
import { destroyHashWorker } from '@/lib/fluxdrop/hash-worker-client'
import { validateFiles, formatBytes } from '@/lib/fluxdrop/format'
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
import { addRecentRoom } from '@/lib/fluxdrop/recent-rooms'
import { isTrustedPeer, addTrustedPeer } from '@/lib/fluxdrop/trusted-peers'
import { playSuccess, playError, playConnect, playPause, playResume } from '@/lib/fluxdrop/sound'
import { MessageType, CONSTANTS, type TransferManifest, type TransferSummary, type TransferState } from '@/lib/fluxdrop/protocol'
import { toast } from 'sonner'

export function useFluxDrop() {
  const session = useSessionStore()
  const transfer = useTransferStore()

  // Refs that always hold the latest values for use inside long-lived callbacks.
  const sessionRef = useRef(session)
  const transferRef = useRef(transfer)
  useEffect(() => { sessionRef.current = session }, [session])
  useEffect(() => { transferRef.current = transfer }, [transfer])

  const signalingRef = useRef<FluxDropSignaling | null>(null)
  const webrtcRef = useRef<FluxDropWebRTC | null>(null)
  const filesRef = useRef<File[]>([])
  const manifestRef = useRef<TransferManifest | null>(null)
  const slicePlanRef = useRef<ReturnType<typeof buildSlicePlan>>([])
  const sendingRef = useRef<boolean>(false)
  const receiverBuffersRef = useRef<Map<number, ArrayBuffer>>(new Map())
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const speedTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const peerDeviceIdRef = useRef<string | null>(null)
  const checksumVerifiedRef = useRef<boolean | null>(null)
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
      const id = crypto.randomUUID()
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
      webrtcRef.current?.close()
      signalingRef.current?.disconnect()
      destroyHashWorker()
    }
  }, [])

  // ---- Connect to signaling server ----
  const connect = useCallback(() => {
    if (signalingRef.current) return
    const sig = new FluxDropSignaling({
      onConnect: () => {
        sessionRef.current.setSignalingConnected(true)
        toast.success('Connected to FluxDrop network')
      },
      onDisconnect: () => {
        sessionRef.current.setSignalingConnected(false)
        toast.warning('Disconnected from signaling server')
      },
      onConnectError: (err) => {
        sessionRef.current.setSignalingConnected(false)
        toast.error('Signaling connection failed', { description: err.message })
      },
      onRoomCreated: (payload) => {
        sessionRef.current.setRoom({
          id: payload.roomId,
          joinCode: payload.joinCode,
          pin: payload.pin ?? null,
          qrData: payload.qrData ?? null,
        })
        sig.setRoomId(payload.roomId)
        toast.success(`Room ${payload.roomId} created`)
      },
      onRoomJoined: (payload) => {
        sessionRef.current.setRoom({
          id: payload.roomId,
          joinCode: payload.joinCode,
          pin: null,
          qrData: null,
        })
        sig.setRoomId(payload.roomId)
        // Save to recent rooms for quick-join next time.
        const peerAlias = payload.peers?.[0]?.alias ?? 'Unknown'
        addRecentRoom({ roomId: payload.roomId, peerAlias, joinedAt: Date.now() })
        if (payload.peers?.length) {
          for (const p of payload.peers) {
            sessionRef.current.addPeer({ id: p.id, alias: p.alias, role: p.role })
            peerDeviceIdRef.current = p.id
          }
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
        peerDeviceIdRef.current = payload.device.id
        toast.info(`${payload.device.alias} joined the room`)
      },
      onDeviceLeft: (payload) => {
        sessionRef.current.removePeer(payload.deviceId)
        if (peerDeviceIdRef.current === payload.deviceId) peerDeviceIdRef.current = null
        toast.warning('Peer disconnected')
      },
      onPairingRequest: (payload: { from: string; transferSummary?: TransferSummary }) => {
        // Sender receives pairing request from receiver -> auto-accept & initiate WebRTC as offerer.
        peerDeviceIdRef.current = payload.from
        sessionRef.current.setPairingInProgress(true)
        sessionRef.current.setPairingAccepted(true)
        sessionRef.current.setPairingInProgress(false)
        initiateWebRTCAsSender()
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
        handleOfferAsReceiver(payload.sdp)
      },
      onWebRtcAnswer: (payload) => {
        webrtcRef.current?.acceptAnswer(payload.sdp)
      },
      onWebRtcIce: (payload) => {
        webrtcRef.current?.addIceCandidate(payload.candidate)
      },
      onTransferManifest: (payload) => {
        peerDeviceIdRef.current = payload.from
        handleIncomingManifest(payload.manifest)
      },
      onTransferAccepted: (payload) => {
        if (payload.accepted) {
          toast.success('Transfer accepted by receiver')
          beginSending()
        } else {
          toast.error('Transfer rejected', { description: payload.reason ?? 'Receiver declined' })
          transferRef.current.setTransferState('FAILED')
        }
      },
      onTransferComplete: () => {
        // Signaling-relayed completion (fires on the peer of whoever sent it —
        // normally the receiver, after the sender relays the verified ack).
        transferRef.current.setTransferState('COMPLETE')
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
        toast.info(`Resume requested from chunk ${payload.lastChunkIndex + 1}`)
        webrtcRef.current?.sendResumeResponse(payload.transferId, true, payload.lastChunkIndex + 1)
        beginSending(payload.lastChunkIndex + 1)
      },
      onResumeResponse: (payload) => {
        if (payload.accepted) toast.success('Resume acknowledged')
        else {
          toast.error('Resume denied')
          transferRef.current.setTransferState('FAILED')
        }
      },
      onSignalingError: (payload) => {
        toast.error(`Signaling error: ${payload.code}`, { description: payload.message })
      },
    })
    sig.connect()
    signalingRef.current = sig
  }, [persistTransferRecord, flushReceiverBuffers])

  // ---- Diagnostics polling (ICE candidate pair + bytes) ----
  const diagnosticsRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startDiagnosticsPolling = useCallback(() => {
    if (diagnosticsRef.current) clearInterval(diagnosticsRef.current)
    diagnosticsRef.current = setInterval(async () => {
      const rtc = webrtcRef.current
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
            if (role === 'sender') initiateWebRTCAsSender()
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
        initiateWebRTCAsSender()
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

    console.log('[FluxDrop] Attempting resume after DataChannel loss...')
    toast.info('Connection lost — attempting to resume...', { duration: 5000 })

    // Persist current state for resume (preserve existing acked chunks!).
    const isSender = filesRef.current.length > 0
    // Persist any in-memory received chunks so the resumed re-send can skip them.
    flushReceiverBuffers()
    await persistTransferRecord(isSender ? 'sender' : 'receiver', 'RESUMING')

    // Wait 2 seconds before attempting reconnection (backoff).
    await new Promise((r) => setTimeout(r, 2000))

    // Check if we still have a signaling connection.
    if (!signalingRef.current?.isConnected) {
      // Reconnect to signaling first.
      connect()
      await new Promise((r) => setTimeout(r, 3000))
    }

    // If we have a room ID and peer, try to re-establish WebRTC.
    if (sessionRef.current.roomId && peerDeviceIdRef.current) {
      if (isSender) {
        // Sender: re-initiate WebRTC (new offer with ICE restart).
        try {
          // Close the old connection first.
          webrtcRef.current?.close()
          // Create a new connection and offer.
          // The signaling relay will forward the new offer to the receiver.
          initiateWebRTCAsSender()
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
  const getEffectiveIceServers = useCallback((): RTCIceServer[] | undefined => {
    const s = sessionRef.current
    if (s.useCustomIce && s.customIceServers.length > 0) {
      return s.customIceServers.map((srv) => ({
        urls: srv.urls,
        username: srv.username || undefined,
        credential: srv.credential || undefined,
      }))
    }
    return undefined // use defaults
  }, [])

  // ---- Sender: initiate WebRTC as the offerer ----
  const initiateWebRTCAsSender = useCallback(async () => {
    if (webrtcRef.current) webrtcRef.current.close()
    const rtc = new FluxDropWebRTC(
      {
        iceServers: getEffectiveIceServers(),
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
          } else if (state === 'failed') {
            handleConnectionFailure('sender')
          }
        },
        onDataChannelOpen: () => {
          sessionRef.current.setDataChannelOpen(true)
          sessionRef.current.setRetryCount(0)
          const m = manifestRef.current
          const stNow = transferRef.current.transferState
          // Capture BEFORE any state overwrite (the old code set
          // MANIFEST_EXCHANGE first, making wasResuming permanently false and
          // the whole resume-on-reconnect path dead).
          const wasResuming = stNow === 'RESUMING'
          // A DC reopen with a finished local transfer (CANCELLED/FAILED/etc.)
          // must NOT reset the state machine — the transfer is over locally.
          const isFinishedState = stNow === 'CANCELLED' || stNow === 'FAILED' || stNow === 'ERROR' || stNow === 'COMPLETE'
          if (!m || isFinishedState) return
          transferRef.current.setTransferState('MANIFEST_EXCHANGE')
          if (m) {
            // Check if this is a resume (state was RESUMING before reconnection).
            if (wasResuming && filesRef.current.length === 0) {
              // Receiver resume: send RESUME_REQUEST with last acked chunk.
              const lastAcked = transferRef.current.chunksAcked - 1 // chunksAcked is a count, not index
              const lastChunkIndex = Math.max(0, lastAcked)
              console.log(`[FluxDrop] Resume: requesting from chunk ${lastChunkIndex}`)
              webrtcRef.current?.sendResumeRequest(m.transferId, lastChunkIndex)
              // Also send via signaling as backup.
              signalingRef.current?.sendResumeRequest({
                roomId: sessionRef.current.roomId!,
                from: sessionRef.current.deviceId,
                to: peerDeviceIdRef.current!,
                transferId: m.transferId,
                lastChunkIndex: lastChunkIndex,
              })
              transferRef.current.setTransferState('TRANSFERRING')
            } else if (wasResuming) {
              // Sender resume: wait for receiver's RESUME_REQUEST.
              // The resume request handler will call beginSending(fromChunkIndex).
              console.log('[FluxDrop] Sender resume: waiting for receiver request')
              transferRef.current.setTransferState('TRANSFERRING')
            } else {
              // Normal (non-resume) flow: send manifest via DataChannel.
              webrtcRef.current?.sendManifest(m.transferId, m)
            }
          }
        },
        onDataChannelClose: () => {
          sessionRef.current.setDataChannelOpen(false)
          stopDiagnosticsPolling()
          if (transferRef.current.transferState === 'TRANSFERRING' || transferRef.current.transferState === 'PAUSED') {
            transferRef.current.setTransferState('RESUMING')
            // Real resume: persist state and attempt ICE restart.
            void attemptResume()
          }
        },
        onDataChannelMessage: (msg) => handleDataChannelMessage(msg),
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
    webrtcRef.current = rtc
    transferRef.current.setTransferState('CONNECTING')
    try {
      const offer = await rtc.createOffer()
      signalingRef.current?.sendOffer({
        roomId: sessionRef.current.roomId!,
        from: sessionRef.current.deviceId,
        to: peerDeviceIdRef.current!,
        sdp: offer,
      })
    } catch (err: any) {
      toast.error('Failed to create offer', { description: err.message })
      transferRef.current.setTransferState('FAILED')
    }
  }, [])

  // ---- Receiver: handle incoming offer ----
  const handleOfferAsReceiver = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    if (webrtcRef.current) webrtcRef.current.close()
    const rtc = new FluxDropWebRTC(
      {
        iceServers: getEffectiveIceServers(),
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
        },
        onDataChannelClose: () => {
          sessionRef.current.setDataChannelOpen(false)
          stopDiagnosticsPolling()
        },
        onDataChannelMessage: (msg) => handleDataChannelMessage(msg),
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
    webrtcRef.current = rtc
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
  const handleDataChannelMessage = useCallback(async (msg: any) => {
    const m = manifestRef.current
    switch (msg.type) {
      case MessageType.MANIFEST: {
        handleIncomingManifest(msg.body as TransferManifest)
        break
      }
      case MessageType.MANIFEST_ACK: {
        if (msg.body?.accepted) {
          if (resumeSkipPendingRef.current && m) {
            // Resumed send: ask the receiver what it already has so stored
            // chunks never travel the wire twice. Falls back to a full send
            // if the answer doesn't arrive within 15s.
            resumeQueryTimerRef.current = setTimeout(() => {
              if (!resumeSkipPendingRef.current) return
              resumeSkipPendingRef.current = false
              console.log('[FluxDrop] No resume-skip answer within 15s — sending from chunk 0')
              beginSending()
            }, 15000)
            console.log(`[FluxDrop] Sending resume-skip query for ${m.transferId.slice(0, 8)}`)
            webrtcRef.current?.sendResumeQuery(m.transferId)
          } else {
            beginSending()
          }
        }
        else {
          transferRef.current.setTransferState('FAILED')
          toast.error('Transfer rejected', { description: msg.body?.reason })
        }
        break
      }
      case MessageType.CHUNK_DATA: {
        if (!m) return
        // Ignore stream data for transfers that are already finished locally
        // (CANCELLED/FAILED/ERROR/COMPLETE) — otherwise a peer that hasn't
        // processed our cancel yet would resurrect the transfer.
        {
          const st = transferRef.current.transferState
          if (st === 'CANCELLED' || st === 'FAILED' || st === 'ERROR' || st === 'COMPLETE') {
            return
          }
        }
        // Keep chunk in memory (fast). Only save to IndexedDB if the transfer
        // is interrupted — we do this lazily to avoid IDB write overhead on
        // every single chunk, which is the #1 throughput killer.
        receiverBuffersRef.current.set(msg.chunkIndex, msg.payload)
        // Send ACK immediately (non-blocking) so the sender can keep streaming.
        webrtcRef.current?.sendChunkAck(m.transferId, msg.chunkIndex, true)
        const bytes = msg.payload.byteLength
        // ackChunk dedupes by index: a re-delivered chunk (lost-ack retry) must
        // not double-count bytes or per-file progress.
        const isNewChunk = transferRef.current.ackChunk(msg.chunkIndex, bytes)
        // Update per-file progress for ALL files this chunk spans (new chunks only).
        if (isNewChunk) {
          const resolved = resolveChunk(slicePlanRef.current, msg.chunkIndex, m.chunkSize)
          if (resolved) {
            for (const seg of resolved.segments) {
              transferRef.current.addFileBytes(seg.fileIndex, seg.length)
            }
          }
        }
        // Track ack in memory (fast). IndexedDB flush is debounced.
        void markChunkAcked(m.transferId, msg.chunkIndex)
        // Periodically persist new chunks in the background (delta flush) so
        // an interrupt can resume without re-sending everything.
        if (msg.chunkIndex > 0 && msg.chunkIndex % 1024 === 0) {
          flushReceiverBuffers()
        }
        if (msg.chunkIndex === m.totalChunks - 1) {
          await finishReceiverTransfer()
        }
        break
      }
      case MessageType.CHUNK_ACK: {
        if (!m) return
        const resolved = resolveChunk(slicePlanRef.current, msg.chunkIndex, m.chunkSize)
        const bytes = resolved?.totalLength ?? m.chunkSize
        // Dedupes internally — duplicate acks from send-retries no longer
        // double-count bytes (the old live-overshoot bug).
        const isNew = transferRef.current.ackChunk(msg.chunkIndex, bytes)
        // Sender-side per-file progress: map the acked chunk back to its file
        // segments so the FILES card fills up live (was receiver-only before).
        if (isNew && resolved) {
          for (const seg of resolved.segments) {
            transferRef.current.addFileBytes(seg.fileIndex, seg.length)
          }
        }
        // Persist the ack so the sender's history record shows real progress
        // after a cancel/reload (previously only the receiver persisted acks,
        // leaving the sender's record stuck at 0%).
        void markChunkAcked(m.transferId, msg.chunkIndex)
        break
      }
      case MessageType.TRANSFER_COMPLETE: {
        await verifyReceiverTransfer()
        break
      }
      case MessageType.TRANSFER_COMPLETE_ACK: {
        if (msg.body?.verified) {
          transferRef.current.setTransferState('COMPLETE')
          playSuccess()
          // Sender FILES card: every file is now delivered on the peer.
          for (let fi = 0; fi < (manifestRef.current?.files.length ?? 0); fi++) {
            transferRef.current.markFileComplete(fi)
          }
          void persistTransferRecord('sender', 'COMPLETE', { checksumVerified: true })
          // Persist any acks still in the debounce window so the final record
          // reflects the true chunk count immediately (not just after cleanup).
          void flushAllPendingAcks()
          if (manifestRef.current) void deleteSenderFiles(manifestRef.current.transferId)
          toast.success('Transfer complete & verified!')
          signalingRef.current?.sendTransferComplete({
            roomId: sessionRef.current.roomId!,
            from: sessionRef.current.deviceId,
            to: peerDeviceIdRef.current!,
          })
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
          beginSending()
        }, 5000)
        webrtcRef.current?.sendResumeQuery(m?.transferId ?? '')
        // Legacy ack so the receiver's UI shows the resume was registered.
        webrtcRef.current?.sendResumeResponse(m?.transferId ?? '', true, (msg.body?.lastChunkIndex ?? 0) + 1)
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
              if (i >= 0 && i < m.totalChunks && (stored.has(i) || receiverBuffersRef.current.has(i))) acked.push(i)
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
            webrtcRef.current?.sendResumeResponse(m.transferId, true, acked.length, acked)
            console.log('[FluxDrop] Resume-skip: bitmap answer sent')
          } catch { webrtcRef.current?.sendResumeResponse(m.transferId, true, 0) }
        })()
        break
      }
      case MessageType.RESUME_RESPONSE: {
        console.log(`[FluxDrop] RESUME_RESPONSE received (accepted=${!!msg.body?.accepted}, indices=${Array.isArray(msg.body?.ackedIndices) ? msg.body.ackedIndices.length : 'none'})`)
        if (msg.body?.accepted) {
          if (resumeSkipPendingRef.current) {
            // Answer to our resume-skip query: the receiver's acked bitmap.
            resumeSkipPendingRef.current = false
            if (resumeQueryTimerRef.current) {
              clearTimeout(resumeQueryTimerRef.current)
              resumeQueryTimerRef.current = null
            }
            const acked: number[] = Array.isArray(msg.body?.ackedIndices) ? msg.body.ackedIndices : []
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
              toast.info(`Skipping ${acked.length} of ${m.totalChunks} chunks`, {
                description: `${Math.round((acked.length / m.totalChunks) * 100)}% was already received by the peer.`,
              })
            } else {
              skipIndicesRef.current = new Set()
            }
            beginSending(0)
          } else {
            toast.success('Resume acknowledged')
          }
        }
        break
      }
    }
  }, [persistTransferRecord, flushReceiverBuffers])

  // ---- Receiver: handle incoming manifest (via DC or signaling) ----
  // Shared accept pipeline — used by the manual consent dialog AND the
  // trusted-device auto-accept path.
  const doAcceptTransfer = useCallback(async (m: TransferManifest) => {
    sessionRef.current.setPendingManifest(null)
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    webrtcRef.current?.sendManifestAck(m.transferId, true)
    signalingRef.current?.sendTransferAccepted({
      roomId: sessionRef.current.roomId!,
      from: sessionRef.current.deviceId,
      to: peerDeviceIdRef.current!,
      accepted: true,
    })
    // New receiving attempt: start a fresh flush set (old flushed chunks stay
    // in IndexedDB and still count via the record's chunksAcked below).
    flushedChunkIdsRef.current = new Set()
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
      webrtcRef.current?.sendManifestAck(m.transferId, true)
      return
    }
    manifestRef.current = m
    slicePlanRef.current = buildSlicePlan(m)
    transferRef.current.setManifest(m)
    transferRef.current.resetProgress(m.totalChunks, m.totalSize)
    transferRef.current.initFiles(m.files)
    transferRef.current.setTransferState('MANIFEST_EXCHANGE')
    // Trusted auto-accept (only when the user opted in AND explicitly
    // trusted this device previously).
    const peerId = peerDeviceIdRef.current
    if (sessionRef.current.autoAcceptTrusted && isTrustedPeer(peerId)) {
      const alias = sessionRef.current.peers[0]?.alias ?? 'trusted device'
      await doAcceptTransfer(m)
      toast.success(`Auto-accepted from trusted device ${alias}`, {
        description: 'Manage trusted devices in Settings → Privacy.',
      })
      return
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
    sessionRef.current.setPendingManifest(m)
  }, [doAcceptTransfer])

  /** Called when the user accepts the transfer in the ConsentDialog. */
  const acceptTransfer = useCallback(async (trust = false) => {
    const m = manifestRef.current
    if (!m) return
    if (trust && peerDeviceIdRef.current) {
      addTrustedPeer({
        deviceId: peerDeviceIdRef.current,
        alias: sessionRef.current.peers[0]?.alias ?? 'peer',
      })
      toast.success('Device trusted', {
        description: 'Future transfers from this device can be auto-accepted (enable in Settings → Privacy).',
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
    webrtcRef.current?.sendManifestAck(m.transferId, false, 'Rejected by user')
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

  // ---- Receiver: finish transfer (assemble + verify + save) ----
  // This is called when the last chunk arrives. It assembles files, verifies
  // checksums, saves them, and sends TRANSFER_COMPLETE_ACK to the sender.
  // We wrap it in a promise ref so verifyReceiverTransfer can await it.
  const finishReceiverTransfer = useCallback(async () => {
    const m = manifestRef.current
    if (!m) return
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
    try {
      // Assemble all files, verify checksums, and save preserving folder structure.
      const assembledFiles: { name: string; blob: Blob; relativePath: string }[] = []

      // Completeness check (ALWAYS — parallel channels reorder chunks, so the
      // last INDEX can arrive while earlier chunks are still in flight; the
      // old lastChunkSeenRef gate skipped this poll and assembled with holes).
      {
        let storedIdx = await getStoredChunkIndices(m.transferId)
        for (let attempt = 0; attempt < 15; attempt++) {
          const missing: number[] = []
          for (let c = 0; c < m.totalChunks; c++) {
            if (!receiverBuffersRef.current.has(c) && !storedIdx.has(c)) missing.push(c)
          }
          if (missing.length === 0) break
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
          webrtcRef.current?.sendTransferCompleteAck(m.transferId, false)
          await persistTransferRecord('receiver', 'ERROR', { checksumVerified: false })
          void flushAllPendingAcks()
          return
        }
        assembledFiles.push({ name: entry.name, blob, relativePath: entry.relativePath })
        transferRef.current.markFileComplete(i)
      }

      // Save: use directory picker for multi-file (preserves folder structure),
      // or save picker for single file.
      if (assembledFiles.length > 1) {
        const result = await saveFilesToDirectory(assembledFiles)
        if (result === 'cancelled') {
          toast.info('Save cancelled — files not saved')
        }
      } else if (assembledFiles.length === 1) {
        await saveBlobWithPicker(assembledFiles[0].blob, assembledFiles[0].name)
      }

      // Free memory: clear receiver buffers after saving.
      receiverBuffersRef.current.clear()

      checksumVerifiedRef.current = true
      transferRef.current.setChecksumVerified(true)
      transferRef.current.setTransferState('COMPLETE')
      webrtcRef.current?.sendTransferCompleteAck(m.transferId, true)
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
    verificationPromiseRef.current = verifyPromise
    await verifyPromise
  }, [persistTransferRecord])

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

  // ---- Sender: begin streaming chunks ----
  const beginSending = useCallback(async (resumeFrom: number = 0) => {
    const m = manifestRef.current
    const files = filesRef.current
    if (!m || files.length === 0) return
    if (sendingRef.current) return
    // Generation ownership: bumping the counter marks THIS loop as the active
    // sender. A watchdog force-restart (or any newer beginSending) supersedes
    // the previous loop, which aborts on its next iteration check.
    const myGen = ++sendLoopGenRef.current
    sendingRef.current = true
    senderNextIndexRef.current = resumeFrom
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    // Create the sender's record NOW so the debounced CHUNK_ACK flushes have
    // something to merge into — before this, the record only appeared at a
    // terminal state and every interim ack flush was silently dropped.
    void persistTransferRecord('sender', 'TRANSFERRING')
    const plan = slicePlanRef.current
    const rtc = webrtcRef.current
    if (!rtc) { sendingRef.current = false; return }

    try {
      // Pipelined send loop: read the next chunk while sending the current one.
      // Each chunk may span multiple files (e.g., chunk N contains the end of
      // file 1 and the start of file 2), so we compose the chunk from segments.

      /**
       * Read and compose a chunk from potentially multiple file segments.
       */
      const readChunk = async (chunkIndex: number): Promise<ArrayBuffer | null> => {
        const resolved = resolveChunk(plan, chunkIndex, m.chunkSize)
        if (!resolved || resolved.segments.length === 0) return null

        // Single-segment chunk (common case — chunk fits in one file).
        if (resolved.segments.length === 1) {
          const seg = resolved.segments[0]
          const file = files[seg.fileIndex]
          if (!file) return null
          return await file.slice(seg.localStart, seg.localEnd).arrayBuffer()
        }

        // Multi-segment chunk (chunk spans a file boundary).
        // Concatenate bytes from each segment to compose the full chunk.
        const parts: ArrayBuffer[] = []
        for (const seg of resolved.segments) {
          const file = files[seg.fileIndex]
          if (!file) return null
          parts.push(await file.slice(seg.localStart, seg.localEnd).arrayBuffer())
        }
        // Concatenate the parts into one buffer.
        const combined = new Uint8Array(resolved.totalLength)
        let offset = 0
        for (const part of parts) {
          combined.set(new Uint8Array(part), offset)
          offset += part.byteLength
        }
        return combined.buffer
      }

      // Pre-read the first chunk.
      let nextBuf: ArrayBuffer | null = await readChunk(resumeFrom)

      for (let i = resumeFrom; i < m.totalChunks; i++) {
        // A newer send loop took over (watchdog restart / resume race) —
        // abort WITHOUT touching sendingRef (the new loop owns it now).
        if (sendLoopGenRef.current !== myGen) return
        // Chunk already stored by the receiver (resume-skip bitmap) — skip it.
        // CRITICAL: the pipelined pre-read invariant is "nextBuf holds THIS
        // chunk's data". Skipping with a bare continue would send the skipped
        // chunk's pre-read bytes under the NEXT index (off-by-one corruption).
        // Drop the skipped pre-read and pre-read the next index instead.
        if (skipIndicesRef.current.has(i)) {
          nextBuf = await readChunk(i + 1)
          senderNextIndexRef.current = i + 1
          continue
        }
        // Pause gate: freeze the loop while paused (locally or by peer request).
        // Polls the flag instead of busy-blocking the event loop.
        if (isPaused()) {
          transferRef.current.setTransferState('PAUSED')
          while (isPaused() && rtc.isOpen) {
            await new Promise((r) => setTimeout(r, 150))
          }
          if (!rtc.isOpen) {
            // Channel died while paused — fall through to the resume path below.
            transferRef.current.setTransferState('RESUMING')
            await persistTransferRecord('sender', 'RESUMING')
            return
          }
          transferRef.current.setTransferState('TRANSFERRING')
        }

        if (!rtc.isOpen) {
          // Only transition to RESUMING if this loop still owns the transfer.
          if (sendLoopGenRef.current === myGen) {
            transferRef.current.setTransferState('RESUMING')
            await persistTransferRecord('sender', 'RESUMING')
          }
          return
        }

        // Use the pre-read buffer.
        const buf = nextBuf
        if (!buf) { continue }

        // Pre-read the NEXT chunk while we send the current one.
        const readNext = readChunk(i + 1)

        // Parallel DataChannels (speed #8): round-robin chunks across open channels.
        // Channel index = chunkIndex % openChannelCount. This spreads the load
        // and reduces per-channel queuing.
        const numChannels = rtc.openChannelCount
        const channelIndex = numChannels > 1 ? i % numChannels : 0

        // Backpressure: wait if the target channel's buffer is full.
        if (numChannels > 1 && channelIndex > 0) {
          if (!rtc.canSendOnChannel(channelIndex)) await rtc.waitForDrainOnChannel(channelIndex)
        } else {
          if (!rtc.canSend()) await rtc.waitForDrain()
        }

        // Send the chunk on the selected channel.
        let sent: boolean
        if (numChannels > 1 && channelIndex > 0) {
          sent = rtc.sendChunkDataOnChannel(m.transferId, i, buf, channelIndex)
          if (!sent && rtc.isOpen) {
            await rtc.waitForDrainOnChannel(channelIndex)
            sent = rtc.sendChunkDataOnChannel(m.transferId, i, buf, channelIndex)
          }
        } else {
          sent = rtc.sendChunkData(m.transferId, i, buf)
          if (!sent) {
            if (rtc.isOpen) {
              await rtc.waitForDrain()
              sent = rtc.sendChunkData(m.transferId, i, buf)
              if (!sent) {
                if (sendLoopGenRef.current === myGen) transferRef.current.setTransferState('RESUMING')
                return
              }
            } else {
              if (sendLoopGenRef.current === myGen) transferRef.current.setTransferState('RESUMING')
              return
            }
          }
        }
        if (!sent) {
          if (sendLoopGenRef.current === myGen) transferRef.current.setTransferState('RESUMING')
          return
        }

        // Wait for the pre-read to complete.
        nextBuf = await readNext

        // Record progress for dead-loop restarts.
        senderNextIndexRef.current = i + 1

        // Yield to event loop periodically so UI can update.
        if (i % 128 === 0) {
          await new Promise((r) => setTimeout(r, 0))
        }
      }
      const combined = m.files.map((f) => f.checksum).join('')
      rtc.sendTransferComplete(m.transferId, combined)
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
  }, [persistTransferRecord, flushReceiverBuffers])

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
      void beginSending(senderNextIndexRef.current)
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
        toast.info('Resuming previous transfer', {
          description: `${files.length} file${files.length > 1 ? 's' : ''} · ${totalMB} MB · checksums reused`,
        })
      } else {
        toast.info('Hashing files...', {
          description: `${files.length} file${files.length > 1 ? 's' : ''} · ${totalMB} MB`,
        })
        // Build manifest with progress updates.
        m = await buildManifest(files, (progress) => {
          transferRef.current.setHashingProgress({
            current: progress.current,
            total: progress.total,
            fileName: progress.fileName,
          })
        })
        transferRef.current.setHashingProgress(null)
      }
      // Persist the files so history-resume can re-attach them later
      // (removed automatically once the transfer completes).
      void saveSenderFiles(m.transferId, files)
      // Fresh sends carry no skip state; resumed sends start empty too (the
      // bitmap arrives via the RESUME_QUERY handshake after MANIFEST_ACK).
      skipIndicesRef.current = new Set()
      resumeSkipUsedRef.current = false
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
      // Small delay to let the socket connect before emitting.
      setTimeout(() => {
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
      }, 300)
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
      setTimeout(() => {
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
      }, 300)
    } catch (err: any) {
      toast.error('Failed to join room', { description: err?.message ?? 'Unknown error' })
      transferRef.current.setTransferState('FAILED')
      transferRef.current.setError(err?.message ?? 'Unknown error')
    }
  }, [connect])

  // ---- Public API: pause / resume mid-transfer ----
  // Either side can pause. The sender freezes its chunk loop; both UIs show
  // PAUSED. Control messages (PAUSE / RESUME_STREAM) sync both sides.
  const pauseTransfer = useCallback(() => {
    const m = manifestRef.current
    const st = transferRef.current.transferState
    if (!m || (st !== 'TRANSFERRING')) return
    pauseLocalRef.current = true
    transferRef.current.pauseTimer()
    webrtcRef.current?.sendPause(m.transferId)
    transferRef.current.setTransferState('PAUSED')
    playPause()
    toast.info('Transfer paused')
  }, [])

  const resumeTransfer = useCallback(() => {
    const m = manifestRef.current
    if (!m) return
    pauseLocalRef.current = false
    transferRef.current.resumeTimer()
    webrtcRef.current?.sendResumeStream(m.transferId)
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
    if (m) webrtcRef.current?.sendCancel(m.transferId, reason)
    signalingRef.current?.sendTransferCancel({
      roomId: sessionRef.current.roomId ?? '',
      from: sessionRef.current.deviceId,
      to: peerDeviceIdRef.current ?? '',
      reason,
    })
    transferRef.current.setTransferState('CANCELLED')
    transferRef.current.setError(reason)
    // STOP the send loop: supersede the current generation so the loop aborts
    // at its next iteration check. Without this, a cancelled transfer kept
    // streaming in the background until the DataChannel closed.
    sendLoopGenRef.current++
    sendingRef.current = false
    skipIndicesRef.current = new Set()
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
    webrtcRef.current?.close()
    webrtcRef.current = null
    signalingRef.current?.leaveRoom()
    signalingRef.current?.disconnect()
    signalingRef.current = null
    // Kill any running send loop generation.
    sendLoopGenRef.current++
    skipIndicesRef.current = new Set()
    resumeSkipPendingRef.current = false
    if (resumeQueryTimerRef.current) {
      clearTimeout(resumeQueryTimerRef.current)
      resumeQueryTimerRef.current = null
    }
    stallTicksRef.current = 0
    // Flush any pending IndexedDB ack writes before resetting state.
    void flushAllPendingAcks()
    sessionRef.current.resetSession()
    transferRef.current.resetTransfer()
    manifestRef.current = null
    filesRef.current = []
    slicePlanRef.current = []
    receiverBuffersRef.current.clear()
    flushedChunkIdsRef.current = new Set()
    sendingRef.current = false
    checksumVerifiedRef.current = null
  }, [])

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
    cleanup,
  }
}
