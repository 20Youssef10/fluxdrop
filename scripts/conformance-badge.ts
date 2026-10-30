// v5-e16: conformance badge generator — runs the golden-vector suite and
// writes the static badge pair consumed by READMEs and the docs site:
//   ci/conformance-badge.json  (machine-readable)
//   ci/conformance-badge.svg   (shields-style)
// The Dev tab serves the LIVE variant via /api/conformance.

import { spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'

const ROOT = process.cwd()
const CI_DIR = `${ROOT}/ci`

function run(): Promise<{ ok: boolean; passed: number; failed: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/protocol-conformance.ts'], { cwd: ROOT })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { out += d.toString() })
    child.on('close', (code) => {
      const m = /(\d+) passed, (\d+) failed/.exec(out)
      resolve({
        ok: code === 0 && m != null && Number(m[2]) === 0,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : -1,
      })
    })
  })
}

const { ok, passed, failed } = await run()
mkdirSync(CI_DIR, { recursive: true })
writeFileSync(
  `${CI_DIR}/conformance-badge.json`,
  JSON.stringify(
    { schemaVersion: 1, label: 'wire conformance', message: ok ? `${passed} passed` : `${failed} failed`, status: ok ? 'pass' : 'fail', generatedAt: new Date().toISOString() },
    null,
    2
  )
)
const message = ok ? `${passed}%20passed` : `${failed < 0 ? 'suite error' : `${failed} failed`}`
const color = ok ? '3fd68f' : 'ff5c5c'
const widthL = 122
const widthR = 22 + decodeURIComponent(message).length * 6.6
writeFileSync(
  `${CI_DIR}/conformance-badge.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(widthL + widthR)}" height="20" role="img" aria-label="wire conformance: ${decodeURIComponent(message)}">` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${Math.round(widthL + widthR)}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${widthL}" height="20" fill="#555"/><rect x="${widthL}" width="${Math.round(widthR)}" height="20" fill="#${color}"/>` +
    `<rect width="${Math.round(widthL + widthR)}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${widthL / 2}" y="14">wire conformance</text>` +
    `<text x="${widthL + widthR / 2}" y="14">${decodeURIComponent(message)}</text></g></svg>\n`
)
console.log(`conformance badge: ${ok ? `${passed} passed` : `${failed} failed`} → ci/conformance-badge.{json,svg}`)
process.exit(ok ? 0 : 1)
