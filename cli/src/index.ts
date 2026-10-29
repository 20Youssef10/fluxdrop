#!/usr/bin/env bun
// FluxDrop CLI — headless sender/receiver for the FluxDrop P2P file transfer
// app (Next.js client + socket.io signaling on :3003).
//
// Implements the v1 wire protocol from docs/protocol-spec.md using the REAL
// encoders (src/lib/fluxdrop/encoding.ts imported read-only through proto.ts).
//
// Commands:   send | receive | loopback | help | version
// Runtime:    bun (bun src/index.ts … or `bunx fluxdrop …` once linked)

const VERSION = '1.0.0'
const DEFAULT_SIGNAL = 'ws://localhost:3003'
const DEFAULT_WEB = 'http://localhost:3000'
const DEFAULT_STUN = 'stun:stun.l.google.com:19302'

interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Map<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>()
  const positionals: string[] = []
  const needsValue = new Set(['--signal', '--alias', '--stun', '--web', '--out', '--room', '--pin', '--size', '--drops', '--ice'])
  let command: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const [key, inline] = a.split('=', 2)
      if (needsValue.has(key)) {
        if (inline !== undefined) flags.set(key, inline)
        else if (i + 1 < argv.length) flags.set(key, argv[++i])
        else throw new Error(`${key} requires a value`)
      } else {
        flags.set(key, true)
      }
    } else if (a === '-h' || a === 'help') {
      command = command ?? 'help'
    } else if (command === null) {
      command = a
    } else {
      positionals.push(a)
    }
  }
  return { command: command ?? 'help', positionals, flags }
}

function help(): void {
  process.stdout.write(`
FluxDrop CLI v${VERSION} — headless P2P file transfer (wire protocol v1)

USAGE
  fluxdrop send <files...> [options]
      Create a room on the signaling server, print room code + PIN + join
      URL, wait for a receiver, then send the files over WebRTC with the
      real binary protocol (manifest first, 64 KiB chunks, CHUNK_ACK pacing).
      Prints the SHA-256 aggregate on verified completion.

  fluxdrop receive --room CODE --pin PIN [options]
      Join the room, answer the WebRTC offer, receive + ACK chunks, verify
      SHA-256 and write the files into --out (default: current directory).

  fluxdrop loopback [--size BYTES] [files...]
      In-process demo: no network, no WebRTC — runs the sender and receiver
      protocol cores over a memory pipe (framing + hashing self-test), with
      simulated lost ACKs to prove the re-send sweep. Exit 0 = PASS.

OPTIONS (send)
  --signal <url>     Signaling server (default: ${DEFAULT_SIGNAL})
  --alias <name>     Device alias shown to peers (default: fluxdrop-cli)
  --no-e2e           Accepted for symmetry — the CLI always sends plaintext;
                     the web client shows a visible downgrade by design
  --stun <url>       STUN server (default: ${DEFAULT_STUN}; use --no-stun to
                     disable — host candidates suffice on a LAN)
  --web <url>        Base URL used to print the receiver join link
                     (default: ${DEFAULT_WEB})

OPTIONS (receive)
  --room <code>      Room code to join (required)
  --pin <pin>        Room PIN (required when the room has one — always, for
                     rooms created by this CLI and by the web app)
  --out <dir>        Output directory (default: .)
  --signal, --alias, --stun   as above

OPTIONS (loopback)
  --size <bytes>     Random payload size when no files given (default: 1 MiB)
  --out <dir>        Where received files land (default: ./fluxdrop-loopback)
  --drops <n>        Simulated lost CHUNK_ACKs the sender must recover from
                     via its re-send sweep (default: 3)
  files...           Optional real files to pipe through instead of random data

EXAMPLES
  # two shells on machines that can reach the same signaling server:
  fluxdrop send ./report.pdf ./data.csv --signal ws://signaling.example.com:3003
  fluxdrop receive --room 7LNVHM --pin 842130 --out ~/downloads

  # quick self-test without any network:
  fluxdrop loopback --size 5242880

  # against the local dev stack (signaling on :3003, web on :3000):
  cd cli && bun src/index.ts send /tmp/big.bin
  cd cli && bun src/index.ts receive --room <code> --pin <pin> --out /tmp/recv
`)
}

function die(msg: string): never {
  process.stderr.write(`✗ ${msg}\n\nRun "fluxdrop help" for usage.\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    help()
    process.exit(0)
  }
  if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version') {
    process.stdout.write(`fluxdrop CLI v${VERSION} (wire protocol v1)\n`)
    process.exit(0)
  }

  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    die(String((err as Error).message))
  }
  const flags = parsed.flags
  const signalUrl = String(flags.get('--signal') ?? DEFAULT_SIGNAL)
  const alias = String(flags.get('--alias') ?? 'fluxdrop-cli')
  const noStun = flags.has('--no-stun')
  const stun = String(flags.get('--stun') ?? DEFAULT_STUN)
  const iceServers = noStun ? [] : [stun]
  const webBase = String(flags.get('--web') ?? DEFAULT_WEB)

  // Ctrl-C: best-effort cleanup happens inside the commands; make the exit fast.
  process.on('SIGINT', () => {
    process.stderr.write('\n✗ interrupted\n')
    process.exit(130)
  })

  switch (parsed.command) {
    case 'send': {
      if (parsed.positionals.length === 0) die('send requires at least one file path')
      const { cmdSend } = await import('./send')
      process.exit(
        await cmdSend({
          files: parsed.positionals,
          signalUrl,
          alias,
          iceServers,
          webBase,
          noE2e: flags.has('--no-e2e'),
        })
      )
      break
    }
    case 'receive': {
      const room = flags.get('--room')
      const pin = flags.get('--pin')
      if (typeof room !== 'string' || room.length === 0) die('receive requires --room CODE')
      if (typeof pin !== 'string' || pin.length === 0) die('receive requires --pin PIN (rooms created by fluxdrop always have one)')
      const { cmdReceive } = await import('./receive')
      process.exit(
        await cmdReceive({
          room,
          pin,
          signalUrl,
          alias,
          iceServers,
          outDir: String(flags.get('--out') ?? '.'),
        })
      )
      break
    }
    case 'loopback': {
      const { cmdLoopback } = await import('./loopback')
      process.exit(
        await cmdLoopback({
          files: parsed.positionals,
          size: Number(flags.get('--size') ?? 1024 * 1024),
          outDir: String(flags.get('--out') ?? './fluxdrop-loopback'),
          drops: Number(flags.get('--drops') ?? 3),
        })
      )
      break
    }
    default:
      die(`unknown command "${parsed.command}"`)
  }
}

void main().catch((err) => {
  const e = err as Error
  process.stderr.write(`✗ ${e?.message ?? String(err)}\n`)
  process.exit(1)
})
