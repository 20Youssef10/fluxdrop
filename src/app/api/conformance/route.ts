import { NextResponse } from 'next/server'
import { spawn } from 'child_process'

export const dynamic = 'force-dynamic'

// v5-e16: live wire-conformance badge — runs the golden-vector suite
// (scripts/protocol-conformance.ts) as a child process and returns the parsed
// tally. Cached module-side for 60 s so the Dev tab can poll freely.
//
// The suite is deterministic (pure protocol code, no network, no fixtures on
// disk), so a cached result is always an honest answer.

interface ConformanceResult {
  ok: boolean
  passed: number
  failed: number
  durationMs: number
  generatedAt: number
  output?: string
}

let cached: { at: number; result: ConformanceResult } | null = null
const CACHE_MS = 60_000

function runConformance(): Promise<ConformanceResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    // ALWAYS bun: next dev runs this route under node (process.execPath is
    // node), which cannot execute the suite's TypeScript directly. The
    // project itself runs on bun — it's guaranteed present.
    const child = spawn('bun', ['scripts/protocol-conformance.ts'], {
      cwd: process.cwd(),
      env: { ...process.env },
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', (err) => {
      resolve({ ok: false, passed: 0, failed: -1, durationMs: Date.now() - started, generatedAt: Date.now(), output: String(err?.message ?? err) })
    })
    child.on('close', (code) => {
      const m = /(\d+) passed, (\d+) failed/.exec(out)
      const passed = m ? Number(m[1]) : 0
      const failed = m ? Number(m[2]) : -1
      resolve({
        ok: code === 0 && failed === 0,
        passed,
        failed,
        durationMs: Date.now() - started,
        generatedAt: Date.now(),
        output: out.split('\n').slice(-6).join('\n').slice(0, 1200),
      })
    })
    // Hard timeout — the suite normally finishes in well under a second.
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, 15_000)
  })
}

export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return NextResponse.json({ ...cached.result, cached: true })
  }
  const result = await runConformance()
  cached = { at: Date.now(), result }
  return NextResponse.json(result)
}
