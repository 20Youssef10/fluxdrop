// FluxDrop CLI — `fluxdrop send` command.
//
// Creates a room on the signaling server, prints room code + PIN + join URL,
// waits for a receiver, negotiates WebRTC over socket.io relays and streams
// the files with the real v1 binary protocol (manifest first, 64 KiB chunks,
// per-chunk ACK pacing, SHA-256 verification handshake).

import { CONSTANTS, decodeFrame, type TransferManifest, type FileManifestEntry } from './proto'
import { Signaling } from './signaling'
import { createPeerFactory, type RtcPeer, type DcWire } from './peer'
import { SenderSession, type SenderProgress } from './session'
import { collectFiles, entryName, fmtBytes, fmtDuration, guessMime, sha256File, ProgressLine } from './util'
import { randomUUID } from 'node:crypto'

export interface SendOptions {
  files: string[]
  signalUrl: string
  alias: string
  iceServers: string[]
  webBase: string
  /** Accepted for API symmetry — the CLI is plaintext-only by design. */
  noE2e: boolean
}

export async function cmdSend(opts: SendOptions): Promise<number> {
  const say = (s: string) => process.stdout.write(s + '\n')

  // ---- 1. validate + hash sources -----------------------------------------
  if (opts.files.length === 0) throw new Error('no files given')
  if (opts.files.length > CONSTANTS.MAX_FILES_PER_TRANSFER) {
    throw new Error(`too many files (max ${CONSTANTS.MAX_FILES_PER_TRANSFER})`)
  }
  const sources = await collectFiles(opts.files)
  const totalSize = sources.reduce((s, f) => s + f.size, 0)
  if (totalSize > CONSTANTS.MAX_FILE_SIZE) {
    throw new Error(`transfer too large (max ${fmtBytes(CONSTANTS.MAX_FILE_SIZE)})`)
  }
  if (totalSize === 0) throw new Error('cannot send an empty transfer (all files are 0 bytes)')

  say(`FluxDrop CLI sender — ${sources.length} file(s), ${fmtBytes(totalSize)}`)
  if (!opts.noE2e) {
    say('  (E2E encryption is not implemented in the CLI — sending plaintext; the web client will show a visible downgrade.)')
  }
  const entries: FileManifestEntry[] = []
  for (const f of sources) {
    const checksum = await sha256File(f.path)
    entries.push({
      name: entryName(f.path),
      size: f.size,
      type: guessMime(f.path),
      lastModified: f.mtimeMs,
      checksum,
      relativePath: entryName(f.path),
    })
    say(`  • ${entries[entries.length - 1].name.padEnd(24)} ${fmtBytes(f.size).padStart(9)}  sha256 ${checksum.slice(0, 16)}…`)
  }

  // ---- 2. manifest ----------------------------------------------------------
  const now = Date.now()
  const manifest: TransferManifest = {
    transferId: randomUUID(),
    version: 1,
    files: entries,
    totalSize,
    totalChunks: Math.ceil(totalSize / CONSTANTS.CHUNK_SIZE),
    chunkSize: CONSTANTS.CHUNK_SIZE,
    createdAt: now,
    expiresAt: now + CONSTANTS.RESUME_RECORD_TTL_MS,
  }

  // ---- 3. signaling: create the room ---------------------------------------
  const deviceId = randomUUID()
  const sig = new Signaling(opts.signalUrl, opts.alias, deviceId)
  await sig.connect()
  say(`\n✓ connected to ${opts.signalUrl}`)
  const room = await sig.createRoom('sender', true)
  const joinUrl = `${opts.webBase.replace(/\/+$/, '')}/#join=${room.roomId}&pin=${room.pin ?? ''}`
  say(`\n┌─ Room ${room.roomId} ─────────────────────────────────────`)
  say(`│  room code : ${room.roomId}`)
  say(`│  PIN       : ${room.pin}`)
  say(`│  join URL  : ${joinUrl}`)
  say(`│  deep link : ${room.qrData}`)
  say('└' + '─'.repeat(46))

  // ---- 4. wait for a receiver, negotiate WebRTC ----------------------------
  const peerFactory = await createPeerFactory(opts.iceServers)
  let peer: RtcPeer | null = null
  let session: SenderSession | null = null
  let peerId: string | null = null
  let transferDone: { verified: boolean } | null = null
  let transferStartedAt = Date.now()
  const progress = new ProgressLine(process.stdout.isTTY === true)

  const startPeer = (to: string): void => {
    if (peer) return
    peerId = to
    peer = peerFactory(`fluxdrop-cli-sender`, {
      onDescription: (sdp, type) => {
        say(`✓ ${type} ready — relaying via signaling`)
        sig.sendOffer(to, { type, sdp })
      },
      onCandidate: (candidate, mid) => sig.sendIce(to, candidate, mid),
      onDataChannel: () => {
        /* sender uses its own outbound channel */
      },
      onDataChannelClosed: () => {
        if (!transferDone) {
          fail(`DataChannel closed before the transfer completed`)
        }
      },
      onStateChange: (state) => {
        if (state === 'connected' || state === 'failed' || state === 'disconnected') {
          say(`WebRTC: ${state}`)
        }
      },
    })
    const dc: DcWire = peer.createSendChannel()
    dc.onOpen(() => {
      say('DataChannel "fluxdrop-0" open')
      transferStartedAt = Date.now()
      session = new SenderSession(dc, manifest, sources, {
        log: (m) => say(`  ${m}`),
        progress: (p: SenderProgress) => {
          const pct = p.totalChunks ? Math.floor((p.ackedChunks / p.totalChunks) * 100) : 100
          const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5))
          progress.update(`  ${String(pct).padStart(3)}% [${bar}] ${fmtBytes(p.ackedBytes)} / ${fmtBytes(p.totalBytes)} at ${p.rateMbps.toFixed(1)} Mbit/s`)
        },
      })
      session.start()
    })
    dc.onMessage((msg) => {
      try {
        session?.handleMessage(decodeFrame(msg))
      } catch (err) {
        fail(`malformed frame from receiver: ${String(err)}`)
      }
    })
  }

  let settled = false
  let exitCode = 0
  const fail = (reason: string): void => {
    if (settled) return
    settled = true
    exitCode = 1
    progress.done()
    process.stderr.write(`\n✗ ${reason}\n`)
    void wrapUp().finally(() => process.exit(1))
  }

  sig.setHandlers({
    onPairingRequest: (p) => {
      sig.sendPairingConfirm(p.from, true)
      say(`\n✓ receiver ${p.from.slice(0, 8)} is pairing`)
      startPeer(p.from)
    },
    onDeviceDiscovered: (p) => {
      if (p.device.role === 'receiver') {
        // Fallback trigger (web receivers send pairing-request themselves).
        setTimeout(() => startPeer(p.device.id), 500)
      }
    },
    onAnswer: (p) => {
      peer?.applyRemoteDescription(p.sdp.sdp, p.sdp.type)
    },
    onIce: (p) => {
      peer?.addRemoteCandidate(p.candidate.candidate, p.candidate.sdpMid ?? '0')
    },
    onDeviceLeft: (p) => {
      if (p.deviceId === peerId) fail('receiver left the room')
    },
    onDisconnect: (reason) => {
      if (!transferDone) fail(`signaling connection lost (${reason})`)
    },
  })

  const pairTimer = setTimeout(() => {
    if (!peer) fail(`no receiver joined within ${fmtDuration(CONSTANTS.PAIRING_TIMEOUT_MS)} — room expired`)
  }, CONSTANTS.PAIRING_TIMEOUT_MS)

  const wrapUp = async (): Promise<void> => {
    clearTimeout(pairTimer)
    try {
      await session?.close()
    } catch {
      /* ignore */
    }
    peer?.close()
    sig.leaveRoom()
  }

  // ---- 5. run the transfer ---------------------------------------------------
  const done = await new Promise<{ verified: boolean }>((resolve) => {
    let inner: Promise<{ verified: boolean }> | null = null
    const poll = setInterval(() => {
      if (!inner && session) inner = session.waitDone()
      if (inner) {
        clearInterval(poll)
        void inner.then(resolve)
      }
    }, 100)
  })
  transferDone = done
  const elapsed = Date.now() - transferStartedAt

  if (done.verified) {
    progress.done()
    say('\n✓ Transfer complete — receiver verified all SHA-256 checksums')
    say(`  aggregate SHA-256 : ${session?.finalChecksum}`)
    say(`  duration         : ${fmtDuration(elapsed)}`)
  } else {
    progress.done()
    process.stderr.write('\n✗ transfer did not verify on the receiver\n')
    exitCode = 1
  }

  await wrapUp()
  return exitCode
}
