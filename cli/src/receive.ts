// FluxDrop CLI — `fluxdrop receive` command.
//
// Joins a room (room code + PIN), answers the sender's WebRTC offer, receives
// chunks over the DataChannel, ACKs per chunk, verifies SHA-256 and writes
// the files into --out.

import { decodeFrame } from './proto'
import { Signaling } from './signaling'
import { createPeerFactory, type RtcPeer } from './peer'
import { ReceiverSession, type ReceiverProgress } from './session'
import { fmtBytes, fmtDuration, randomUUID, ProgressLine } from './util'
import { CONSTANTS } from './proto'

export interface ReceiveOptions {
  room: string
  pin: string
  signalUrl: string
  alias: string
  iceServers: string[]
  outDir: string
}

export async function cmdReceive(opts: ReceiveOptions): Promise<number> {
  const say = (s: string) => process.stdout.write(s + '\n')

  // ---- 1. join the room ------------------------------------------------------
  const deviceId = randomUUID()
  const sig = new Signaling(opts.signalUrl, opts.alias, deviceId)
  await sig.connect()
  say(`✓ connected to ${opts.signalUrl}`)
  const joined = await sig.joinRoom(opts.room, opts.pin)
  const peers = joined.peers ?? []
  if (peers.length === 0) {
    process.stderr.write('✗ room has no sender in it (did the sender create the room?)\n')
    sig.leaveRoom()
    return 1
  }
  const sender = peers.find((p) => p.role === 'sender') ?? peers[0]
  say(`✓ joined room ${joined.roomId} — sender: ${sender.alias} (${sender.id.slice(0, 8)})`)

  // ---- 2. WebRTC answerer ----------------------------------------------------
  const peerFactory = await createPeerFactory(opts.iceServers)
  const progress = new ProgressLine(process.stdout.isTTY === true)
  let peer: RtcPeer | null = null
  let session: ReceiverSession | null = null
  let transferDone = false
  let offered = false
  let exitCode = 0

  const fail = (reason: string): void => {
    if (transferDone) return
    transferDone = true
    exitCode = 1
    progress.done()
    process.stderr.write(`\n✗ ${reason}\n`)
    void wrapUp().finally(() => process.exit(1))
  }

  const ensurePeer = (): RtcPeer => {
    if (peer) return peer
    peer = peerFactory('fluxdrop-cli-receiver', {
      onDescription: (sdp, type) => {
        say(`✓ ${type} ready — relaying via signaling`)
        sig.sendAnswer(sender.id, { type, sdp })
      },
      onCandidate: (candidate, mid) => sig.sendIce(sender.id, candidate, mid),
      onDataChannel: (wire) => {
        say('DataChannel received — ready for the manifest')
        session = new ReceiverSession(wire, opts.outDir, {
          log: (m) => say(`  ${m}`),
          onManifest: (m) => {
            progress.done()
            say(`\nManifest: ${m.files.length} file(s), ${fmtBytes(m.totalSize)} (${m.totalChunks} chunks of ${fmtBytes(m.chunkSize)})${m.compression === 'gzip' ? ' · gzip wire compression' : ''}`)
            for (const f of m.files) {
              say(`  • ${f.name.padEnd(24)} ${fmtBytes(f.size).padStart(9)}  ${f.type}`)
            }
            say('')
          },
          progress: (p: ReceiverProgress) => {
            const pct = p.totalChunks ? Math.floor((p.storedChunks / p.totalChunks) * 100) : 100
            const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5))
            progress.update(`  ${String(pct).padStart(3)}% [${bar}] ${fmtBytes(p.storedBytes)} / ${fmtBytes(p.totalBytes)}`)
          },
        })
        wire.onMessage((msg) => {
          try {
            session?.handleMessage(decodeFrame(msg))
          } catch (err) {
            fail(`malformed frame from sender: ${String(err)}`)
          }
        })
      },
      onDataChannelClosed: () => {
        if (!transferDone) fail('sender closed the DataChannel before completing the transfer')
      },
      onStateChange: (state) => {
        if (state === 'connected' || state === 'failed' || state === 'disconnected') {
          say(`WebRTC: ${state}`)
        }
      },
    })
    return peer
  }

  sig.setHandlers({
    onOffer: (p) => {
      if (p.from !== sender.id && offered) return
      offered = true
      const pc = ensurePeer()
      // Triggers automatic answer generation -> onDescription.
      pc.applyRemoteDescription(p.sdp.sdp, p.sdp.type)
    },
    onIce: (p) => {
      ensurePeer().addRemoteCandidate(p.candidate.candidate, p.candidate.sdpMid ?? '0')
    },
    onDeviceDiscovered: (p) => {
      if (p.device.role === 'sender') say(`✓ sender ${p.device.alias} is in the room`)
    },
    onDeviceLeft: (p) => {
      if (p.deviceId === sender.id && !transferDone) fail('sender left the room')
    },
    onDisconnect: (reason) => {
      if (!transferDone) fail(`signaling connection lost (${reason})`)
    },
  })

  // Mirror the web receiver: announce ourselves so the sender offers to us.
  sig.sendPairingRequest(sender.id)

  const wrapUp = async (): Promise<void> => {
    try {
      await session?.close()
    } catch {
      /* ignore */
    }
    peer?.close()
    sig.leaveRoom()
  }

  // ---- 3. run the receive ------------------------------------------------------
  const done = await new Promise<{ verified: boolean; files: { name: string; path: string; checksum: string; ok: boolean }[] }>(
    (resolve) => {
      let inner: Promise<{ verified: boolean; files: { name: string; path: string; checksum: string; ok: boolean }[] }> | null = null
      const poll = setInterval(() => {
        if (!inner && session) inner = session.waitDone()
        if (inner) {
          clearInterval(poll)
          void inner.then(resolve)
        }
      }, 100)
      // Overall guard: if no offer ever arrives, stop instead of hanging.
      setTimeout(() => {
        if (!offered && !session) fail(`no sender connected within ${fmtDuration(CONSTANTS.PAIRING_TIMEOUT_MS)}`)
      }, CONSTANTS.PAIRING_TIMEOUT_MS)
    }
  )
  transferDone = true

  if (done.verified) {
    progress.done()
    say('\n✓ Transfer complete — all SHA-256 checksums verified')
    for (const f of done.files) {
      say(`  ${f.ok ? '✓' : '✗'} ${f.name.padEnd(24)} → ${f.path}`)
      say(`     sha256 ${f.checksum}`)
    }
  } else {
    progress.done()
    process.stderr.write('\n✗ verification failed — the receiver kept the .part temp file for inspection\n')
    exitCode = 1
  }

  await wrapUp()
  return exitCode
}
