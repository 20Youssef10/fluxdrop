// v5-F18: Chaos harness — the CI gate that drives the REAL app through the
// REAL transfer pipeline under network impairment.
//
//   bun run chaos                          # steady + lossy-wifi profiles
//   bun run chaos -- --profiles flaky      # a specific profile set
//   bun run chaos -- --base http://localhost:3000 --seed-signaling http://localhost:3003
//                                          # gateway-less mode (CI): pages hit
//                                          # the app directly and localStorage
//                                          # seeds the signaling endpoint pref
//
// What it does per profile:
//   1. boots signaling (:3003) + `next dev` (:3000) as children of this
//      process (they die with it — the sandbox/CI one-shot pattern),
//   2. opens TWO headless Chromium contexts (playwright),
//   3. sender page loads `/?chaos=<profile>` (impairment active in-app),
//      queues a 3 MiB file, creates the room,
//   4. receiver joins with the code + PIN, ACCEPTS the consent,
//   5. asserts "Transfer complete" + "SHA-256 verified" within the budget,
//   6. records elapsed + bytes into ci/chaos-report.json (+ a badge SVG).
//
// The profiles live in src/lib/fluxdrop/chaos.ts — the SAME code the app's
// Settings → Network chaos lab uses. Latency/jitter/ICE-loss/throttle/flake
// are applied inside the client, so the harness runs anywhere playwright
// does (no tc/netem, no root).

import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { chromium } from 'playwright'
import { randomBytes } from 'crypto'

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function argFlag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const PROFILES = (argFlag('profiles') ?? 'steady,lossy-wifi').split(',').map((s) => s.trim()).filter(Boolean)
const BASE = argFlag('base') ?? 'http://localhost:81'
const SEED_SIGNALING = argFlag('seed-signaling') // gateway-less mode (CI)
const APP_PORT = argFlag('app-port') ?? '3000'
const SIGNALING_PORT = argFlag('signaling-port') ?? '3003'
const CHAOS_FILE_BYTES = 3 * 1024 * 1024
const COMPLETE_BUDGET_MS = 150_000

const ROOT = process.cwd()
const CI_DIR = `${ROOT}/ci`

interface ProfileResult {
  profile: string
  ok: boolean
  elapsedMs: number | null
  verified: boolean
  error?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not up */ }
    await sleep(500)
  }
  throw new Error(`service at ${url} never came up`)
}

function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return
  try { child.kill('SIGKILL') } catch { /* ignore */ }
}

// ─── The app-flow driver (selectors mirror the shipped UI) ─────────────────

async function driveTransfer(
  senderPage: import('playwright').Page,
  receiverPage: import('playwright').Page,
  filePath: string,
  chaosQuery = ''
): Promise<{ elapsedMs: number; verified: boolean }> {
  const startedAt = Date.now()

  // --- sender: skip onboarding → send flow → queue file → create room ---
  await senderPage.goto(`${BASE}/${chaosQuery}`, { waitUntil: 'domcontentloaded' })
  await senderPage.waitForFunction(() => !document.body.innerText.includes('Offline'), null, { timeout: 30_000 })
  const skip = senderPage.getByRole('button', { name: 'Skip' })
  await skip.click({ timeout: 10_000 }).catch(() => undefined)
  await sleep(1500) // let the onboarding modal finish its exit animation
  await senderPage.getByRole('button', { name: 'Send files' }).click()
  // The send view mounts asynchronously — wait for its queue panel before
  // touching the file input (the landing view has its own hidden input).
  await senderPage.waitForFunction(() => document.body.innerText.includes('PENDING QUEUE'), null, { timeout: 10_000 })
  await sleep(500)
  await senderPage.setInputFiles('input[type=file]', filePath)
  // Validation + hashing of the payload runs before the room button unlocks.
  await senderPage.getByRole('button', { name: 'Create transfer room' }).click({ timeout: 30_000 })

  // room code + pin from the <code> elements
  let room = ''
  let pin = ''
  for (let i = 0; i < 30 && !room; i++) {
    const codes = await senderPage.locator('code').allTextContents()
    const r0 = (codes[0] ?? '').trim()
    if (r0.length >= 4 && r0.length <= 12 && /^[A-Z0-9]+$/.test(r0)) {
      room = r0
      pin = (codes[1] ?? '').trim()
    }
    if (!room) await sleep(1000)
  }
  if (!room) throw new Error('sender never showed a room code')

  // --- receiver: receive flow → join ---
  await receiverPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await receiverPage.waitForFunction(() => !document.body.innerText.includes('Offline'), null, { timeout: 30_000 })
  const skip2 = receiverPage.getByRole('button', { name: 'Skip' })
  await skip2.click({ timeout: 10_000 }).catch(() => undefined)
  await sleep(1500)
  await receiverPage.getByRole('button', { name: 'Receive files' }).click()
  // The join form mounts through a view transition — let it settle before
  // filling (a fill during the remount gets wiped by React's re-render).
  await receiverPage.locator('#room-id').waitFor({ state: 'visible', timeout: 10_000 })
  await sleep(800)
  await receiverPage.locator('#room-id').fill(room)
  await receiverPage.getByRole('textbox').nth(1).fill(pin)
  await receiverPage.getByRole('button', { name: 'Join room' }).click()

  // --- consent → accept ---
  // Impaired profiles (esp. flaky's 15 s signaling drops) can push the
  // PAKE/manifest exchange across multiple reconnect windows — the consent
  // dialog legitimately takes longer to appear. 150 s covers ~10 flakes.
  await receiverPage.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 150_000 })

  // --- completion (proper poll — the summary h3 says "Transfer complete") ---
  const outcome = await receiverPage.waitForFunction(() => {
    const t = document.body.innerText
    if (t.includes('Transfer complete')) return 'complete'
    if (t.includes('Transfer failed')) return 'failed'
    return ''
  }, null, { timeout: COMPLETE_BUDGET_MS }).then((r) => r.evaluate((v) => v as string))

  const bodyText = await receiverPage.evaluate(() => document.body.innerText)
  const verified = bodyText.includes('SHA-256 verified')
  if (outcome !== 'complete') throw new Error(`receiver reported: ${outcome || 'timeout'}`)
  return { elapsedMs: Date.now() - startedAt, verified }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  mkdirSync(CI_DIR, { recursive: true })

  // 0. Conformance gate first — the chaos run is meaningless on a broken wire.
  console.log('== [0] wire conformance gate ==')
  const conf = spawn(process.execPath, ['scripts/protocol-conformance.ts'], { cwd: ROOT, stdio: 'inherit' })
  const confCode = await new Promise<number>((resolve) => conf.on('close', resolve))
  if (confCode !== 0) {
    console.error('protocol conformance FAILED — aborting chaos run')
    writeReport([{ profile: 'conformance-gate', ok: false, elapsedMs: null, verified: false, error: 'protocol-conformance failed' }])
    return 1
  }

  // 1. Boot the stack (children of this process — one-shot lifecycle).
  console.log('== [1] boot signaling + dev server ==')
  for (const pat of ['next dev', `bun --hot src/index.ts`]) {
    try {
      const out = spawn('pkill', ['-f', pat])
      await new Promise((r) => out.on('close', r))
    } catch { /* ignore */ }
  }
  await sleep(800)
  const signaling = spawn('bun', ['src/index.ts'], { cwd: `${ROOT}/mini-services/signaling`, stdio: 'ignore' })
  const dev = spawn('bun', ['run', 'dev'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env } })
  try {
    await waitForHttp(`http://localhost:${SIGNALING_PORT}/healthz`, 30_000)
    await waitForHttp(`http://localhost:${APP_PORT}/`, 120_000)
    console.log('stack up')

    // 2. Fixed 3 MiB payload (deterministic-ish content, random name per run).
    const payloadPath = `/tmp/chaos-payload-${Date.now()}.bin`
    writeFileSync(payloadPath, randomBytes(CHAOS_FILE_BYTES))

    const browser = await chromium.launch({ headless: true })
    const results: ProfileResult[] = []
    try {
      for (const profile of PROFILES) {
        console.log(`== [2] profile: ${profile} ==`)
        const senderCtx = await browser.newContext()
        const receiverCtx = await browser.newContext()
        if (SEED_SIGNALING) {
          const seed = JSON.stringify({ signalingEndpoint: SEED_SIGNALING })
          for (const ctx of [senderCtx, receiverCtx]) {
            await ctx.addInitScript((s) => {
              try { localStorage.setItem('fluxdrop:prefs-v4', s) } catch { /* ignore */ }
            }, seed)
          }
        }
        const sender = await senderCtx.newPage()
        const receiver = await receiverCtx.newPage()
        try {
          const chaosQuery = profile === 'steady' ? '' : `?chaos=${profile}`
          // Sender carries the impairment; the receiver is the clean endpoint.
          const { elapsedMs, verified } = await driveTransfer(sender, receiver, payloadPath, chaosQuery)
          results.push({ profile, ok: verified, elapsedMs, verified })
          console.log(`  ${verified ? '✓' : '✗'} ${profile}: complete in ${(elapsedMs / 1000).toFixed(1)}s${verified ? ' (SHA-256 verified)' : ' (NOT verified!)'}`)
        } catch (err) {
          const dbg = await sender.evaluate(() => {
            const codes = [...document.querySelectorAll('code')].map((c) => c.textContent)
            const inputs = [...document.querySelectorAll('input[type=file]')].map((i) => ({
              files: i.files?.length ?? 0,
              accept: i.accept,
              visible: !!(i.offsetWidth || i.offsetHeight),
            }))
            return JSON.stringify({
              head: document.body.innerText.slice(0, 300).replace(/\n/g, ' | '),
              queue: (document.body.innerText.match(/PENDING QUEUE[^\n]*/) || ['?'])[0],
              codes,
              inputs,
            })
          }).catch(() => '<dead>')
          const dbgR = await receiver.evaluate(() => document.body.innerText.slice(0, 300).replace(/\n/g, ' | ')).catch(() => '<dead>')
          results.push({ profile, ok: false, elapsedMs: null, verified: false, error: String((err as Error)?.message ?? err) })
          console.log(`  ✗ ${profile}: ${String((err as Error)?.message ?? err)}`)
          console.log(`    sender state: ${dbg}`)
          console.log(`    recv body:   ${dbgR}`)
        } finally {
          await senderCtx.close().catch(() => undefined)
          await receiverCtx.close().catch(() => undefined)
        }
      }
    } finally {
      await browser.close().catch(() => undefined)
    }
    writeReport(results)
    const failed = results.filter((r) => !r.ok)
    console.log(failed.length === 0
      ? `\nCHAOS HARNESS PASSED — ${results.length}/${results.length} profiles completed verified transfers`
      : `\nCHAOS HARNESS FAILED — ${failed.map((r) => r.profile).join(', ')}`)
    return failed.length === 0 ? 0 : 1
  } finally {
    killTree(dev)
    killTree(signaling)
  }
}

function writeReport(results: ProfileResult[]): void {
  const passed = results.filter((r) => r.ok).length
  const total = results.length
  const ok = total > 0 && passed === total
  writeFileSync(
    `${CI_DIR}/chaos-report.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), passed, total, ok, results }, null, 2)
  )
  // Shields-style static badge for READMEs / the docs site.
  const label = 'chaos%20harness'
  const message = ok ? `${passed}%2F${total}%20passed` : 'failing'
  const color = ok ? '3fd68f' : 'ff5c5c'
  const widthL = 86
  const widthR = 22 + message.length * 6.6
  writeFileSync(
    `${CI_DIR}/chaos-badge.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(widthL + widthR)}" height="20" role="img" aria-label="chaos harness: ${decodeURIComponent(message)}">` +
      `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
      `<clipPath id="r"><rect width="${Math.round(widthL + widthR)}" height="20" rx="3" fill="#fff"/></clipPath>` +
      `<g clip-path="url(#r)"><rect width="${widthL}" height="20" fill="#555"/><rect x="${widthL}" width="${Math.round(widthR)}" height="20" fill="#${color}"/>` +
      `<rect width="${Math.round(widthL + widthR)}" height="20" fill="url(#s)"/></g>` +
      `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
      `<text x="${widthL / 2}" y="14">${decodeURIComponent(label)}</text>` +
      `<text x="${widthL + widthR / 2}" y="14">${decodeURIComponent(message)}</text></g></svg>\n`
  )
}

void main().then((code) => process.exit(code))
