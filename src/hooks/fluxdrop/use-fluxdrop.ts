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
import { validateFiles, formatBytes } from '@/lib/fluxdrop/format'
import {
  saveTransferRecord,
  markChunkAcked,
  saveChunk,
  getChunk,
  type StoredTransfer,
} from '@/lib/fluxdrop/resume'
import { assembleBlob, saveBlobWithPicker } from '@/lib/fluxdrop/file-io'
import { MessageType, CONSTANTS, type TransferManifest, type TransferSummary } from '@/lib/fluxdrop/protocol'
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
  useEffect(() => {
    void session.initDevice()
  }, [])

  // ---- Cleanup on unmount ----
  useEffect(() => {
    return () => {
      webrtcRef.current?.close()
      signalingRef.current?.disconnect()
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
        transferRef.current.setTransferState('COMPLETE')
        const m = manifestRef.current
        toast.success('Transfer complete!', {
          description: m
            ? `${m.files.length} file${m.files.length > 1 ? 's' : ''} · ${formatBytes(m.totalSize)} verified`
            : 'All files verified',
        })
      },
      onTransferCancel: (payload) => {
        transferRef.current.setTransferState('CANCELLED')
        transferRef.current.setError(payload.reason ?? 'Transfer cancelled')
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
  }, [])

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
            startDiagnosticsPolling()
          } else if (state === 'failed') {
            handleConnectionFailure('sender')
          }
        },
        onDataChannelOpen: () => {
          sessionRef.current.setDataChannelOpen(true)
          sessionRef.current.setRetryCount(0)
          transferRef.current.setTransferState('MANIFEST_EXCHANGE')
          const m = manifestRef.current
          if (m) {
            webrtcRef.current?.sendManifest(m.transferId, m)
            signalingRef.current?.sendTransferManifest({
              roomId: sessionRef.current.roomId!,
              from: sessionRef.current.deviceId,
              to: peerDeviceIdRef.current!,
              manifest: m,
            })
          }
        },
        onDataChannelClose: () => {
          sessionRef.current.setDataChannelOpen(false)
          stopDiagnosticsPolling()
          if (transferRef.current.transferState === 'TRANSFERRING') {
            transferRef.current.setTransferState('RESUMING')
          }
        },
        onDataChannelMessage: (msg) => handleDataChannelMessage(msg),
        onError: (err) => toast.error('WebRTC error', { description: err.message }),
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
        onError: (err) => toast.error('WebRTC error', { description: err.message }),
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
        if (msg.body?.accepted) beginSending()
        else {
          transferRef.current.setTransferState('FAILED')
          toast.error('Transfer rejected', { description: msg.body?.reason })
        }
        break
      }
      case MessageType.CHUNK_DATA: {
        if (!m) return
        await saveChunk(m.transferId, msg.chunkIndex, msg.payload)
        receiverBuffersRef.current.set(msg.chunkIndex, msg.payload)
        webrtcRef.current?.sendChunkAck(m.transferId, msg.chunkIndex, true)
        const bytes = msg.payload.byteLength
        transferRef.current.ackChunk(bytes)
        const resolved = resolveChunk(slicePlanRef.current, msg.chunkIndex, m.chunkSize)
        if (resolved) transferRef.current.addFileBytes(resolved.fileIndex, bytes)
        await markChunkAcked(m.transferId, msg.chunkIndex)
        if (msg.chunkIndex === m.totalChunks - 1) {
          await finishReceiverTransfer()
        }
        break
      }
      case MessageType.CHUNK_ACK: {
        if (!m) return
        const resolved = resolveChunk(slicePlanRef.current, msg.chunkIndex, m.chunkSize)
        const bytes = resolved?.length ?? m.chunkSize
        transferRef.current.ackChunk(bytes)
        break
      }
      case MessageType.TRANSFER_COMPLETE: {
        await verifyReceiverTransfer()
        break
      }
      case MessageType.TRANSFER_COMPLETE_ACK: {
        if (msg.body?.verified) {
          transferRef.current.setTransferState('COMPLETE')
          toast.success('Transfer complete & verified!')
          signalingRef.current?.sendTransferComplete({
            roomId: sessionRef.current.roomId!,
            from: sessionRef.current.deviceId,
            to: peerDeviceIdRef.current!,
          })
        }
        break
      }
      case MessageType.TRANSFER_CANCEL: {
        transferRef.current.setTransferState('CANCELLED')
        transferRef.current.setError(msg.body?.reason ?? 'Cancelled by peer')
        toast.error('Transfer cancelled', { description: msg.body?.reason })
        break
      }
      case MessageType.RESUME_REQUEST: {
        toast.info(`Resume requested from chunk ${(msg.body?.lastChunkIndex ?? 0) + 1}`)
        webrtcRef.current?.sendResumeResponse(m?.transferId ?? '', true, (msg.body?.lastChunkIndex ?? 0) + 1)
        beginSending((msg.body?.lastChunkIndex ?? 0) + 1)
        break
      }
      case MessageType.RESUME_RESPONSE: {
        if (msg.body?.accepted) toast.success('Resume acknowledged')
        break
      }
    }
  }, [])

  // ---- Receiver: handle incoming manifest (via DC or signaling) ----
  const handleIncomingManifest = useCallback(async (m: TransferManifest) => {
    if (!m || !m.transferId) return
    if (manifestRef.current?.transferId === m.transferId) {
      webrtcRef.current?.sendManifestAck(m.transferId, true)
      return
    }
    manifestRef.current = m
    slicePlanRef.current = buildSlicePlan(m)
    transferRef.current.setManifest(m)
    transferRef.current.resetProgress(m.totalChunks, m.totalSize)
    transferRef.current.initFiles(m.files)
    transferRef.current.setTransferState('MANIFEST_EXCHANGE')
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    webrtcRef.current?.sendManifestAck(m.transferId, true)
    signalingRef.current?.sendTransferAccepted({
      roomId: sessionRef.current.roomId!,
      from: sessionRef.current.deviceId,
      to: peerDeviceIdRef.current!,
      accepted: true,
    })
    const rec: StoredTransfer = {
      transferId: m.transferId,
      role: 'receiver',
      manifest: m,
      status: 'TRANSFERRING',
      chunksAcked: [],
      bytesTransferred: 0,
      peerAlias: sessionRef.current.peers[0]?.alias ?? 'peer',
      peerDeviceId: peerDeviceIdRef.current ?? '',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    await saveTransferRecord(rec)
    toast.success(`Receiving ${m.files.length} file${m.files.length > 1 ? 's' : ''} (${formatBytes(m.totalSize)})`)
  }, [])

  // ---- Receiver: finish transfer (assemble + verify + save) ----
  const finishReceiverTransfer = useCallback(async () => {
    const m = manifestRef.current
    if (!m) return
    transferRef.current.setTransferState('VERIFYING')
    try {
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
        const verified = await verifyChecksum(blob, entry.checksum)
        if (!verified) {
          toast.error(`Checksum mismatch for ${entry.name}`)
          checksumVerifiedRef.current = false
          transferRef.current.setChecksumVerified(false)
          transferRef.current.setTransferState('ERROR')
          webrtcRef.current?.sendTransferCompleteAck(m.transferId, false)
          return
        }
        await saveBlobWithPicker(blob, entry.name)
        transferRef.current.markFileComplete(i)
      }
      checksumVerifiedRef.current = true
      transferRef.current.setChecksumVerified(true)
      transferRef.current.setTransferState('COMPLETE')
      webrtcRef.current?.sendTransferCompleteAck(m.transferId, true)
      toast.success('All files received and verified!', {
        description: `${m.files.length} file${m.files.length > 1 ? 's' : ''} saved · SHA-256 ✓`,
      })
    } catch (err: any) {
      toast.error('Failed to save file', { description: err.message })
      transferRef.current.setTransferState('ERROR')
      transferRef.current.setError(err.message)
    }
  }, [])

  // ---- Receiver: verify final checksum ----
  const verifyReceiverTransfer = useCallback(async () => {
    const m = manifestRef.current
    if (!m) return
    const ok = checksumVerifiedRef.current ?? true
    webrtcRef.current?.sendTransferCompleteAck(m.transferId, ok)
    if (ok) transferRef.current.setTransferState('COMPLETE')
  }, [])

  // ---- Sender: begin streaming chunks ----
  const beginSending = useCallback(async (resumeFrom: number = 0) => {
    const m = manifestRef.current
    const files = filesRef.current
    if (!m || files.length === 0) return
    if (sendingRef.current) return
    sendingRef.current = true
    transferRef.current.setTransferState('TRANSFERRING')
    transferRef.current.startTimer()
    const plan = slicePlanRef.current
    const rtc = webrtcRef.current
    if (!rtc) { sendingRef.current = false; return }

    try {
      for (let i = resumeFrom; i < m.totalChunks; i++) {
        if (!rtc.isOpen) {
          transferRef.current.setTransferState('RESUMING')
          sendingRef.current = false
          await saveTransferRecord({
            transferId: m.transferId,
            role: 'sender',
            manifest: m,
            status: 'RESUMING',
            chunksAcked: [],
            bytesTransferred: transferRef.current.bytesTransferred,
            peerAlias: sessionRef.current.peers[0]?.alias ?? 'peer',
            peerDeviceId: peerDeviceIdRef.current ?? '',
            startedAt: transferRef.current.startedAt ?? Date.now(),
            updatedAt: Date.now(),
          })
          return
        }
        if (!rtc.canSend()) await rtc.waitForDrain()
        const resolved = resolveChunk(plan, i, m.chunkSize)
        if (!resolved) continue
        const file = files[resolved.fileIndex]
        if (!file) continue
        const slice = file.slice(resolved.localStart, resolved.localEnd)
        const buf = await slice.arrayBuffer()
        rtc.sendChunkData(m.transferId, i, buf)
      }
      const combined = m.files.map((f) => f.checksum).join('')
      rtc.sendTransferComplete(m.transferId, combined)
      sendingRef.current = false
    } catch (err: any) {
      sendingRef.current = false
      toast.error('Send error', { description: err.message })
      transferRef.current.setTransferState('FAILED')
      transferRef.current.setError(err.message)
    }
  }, [])

  // ---- Public API: start a send session ----
  const startSend = useCallback(async (files: File[]) => {
    const validation = validateFiles(files)
    if (!validation.ok) {
      toast.error('Cannot send files', { description: validation.errors.join(', ') })
      return
    }
    filesRef.current = files
    transferRef.current.setTransferState('VALIDATING')
    toast.info('Hashing files...')
    const m = await buildManifest(files)
    manifestRef.current = m
    slicePlanRef.current = buildSlicePlan(m)
    transferRef.current.setManifest(m)
    transferRef.current.resetProgress(m.totalChunks, m.totalSize)
    transferRef.current.setTransferState('PAIRING')
    connect()
    setTimeout(() => {
      signalingRef.current?.createRoom({
        alias: sessionRef.current.alias,
        deviceId: sessionRef.current.deviceId,
        role: 'sender',
        withPin: true,
      })
    }, 300)
  }, [connect])

  // ---- Public API: join a room as receiver ----
  const startReceive = useCallback((roomId: string, pin: string) => {
    transferRef.current.setTransferState('PAIRING')
    connect()
    setTimeout(() => {
      signalingRef.current?.joinRoom({
        roomId: roomId.toUpperCase(),
        pin: pin || undefined,
        alias: sessionRef.current.alias,
        deviceId: sessionRef.current.deviceId,
        role: 'receiver',
      })
    }, 300)
  }, [connect])

  // ---- Public API: cancel ----
  const cancelTransfer = useCallback((reason: string = 'Cancelled by user') => {
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
  }, [])

  // ---- Public API: leave room / reset ----
  const cleanup = useCallback(() => {
    stopDiagnosticsPolling()
    webrtcRef.current?.close()
    webrtcRef.current = null
    signalingRef.current?.leaveRoom()
    signalingRef.current?.disconnect()
    signalingRef.current = null
    sessionRef.current.resetSession()
    transferRef.current.resetTransfer()
    manifestRef.current = null
    filesRef.current = []
    slicePlanRef.current = []
    receiverBuffersRef.current.clear()
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
    cleanup,
  }
}
