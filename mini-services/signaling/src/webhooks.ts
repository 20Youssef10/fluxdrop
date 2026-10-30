// v5-e14: Webhooks / event bus — the signaling server's automation surface.
//
// The server already emits structured log lines; this module turns the
// interesting LIFECYCLE points into a small event bus (`emitBusEvent`) and
// fans matching events out to admin-configured webhook URLs (Home Assistant,
// scripts, n8n…). The admin dashboard is the automation hub: add/remove/test
// hooks, watch delivery stats + a recent-deliveries log.
//
// Design notes:
//   • Config persists to data/webhooks.json (survives restarts); env
//     WEBHOOKS='[{"url":…,"events":[…],"secret":…}]' seeds extra hooks.
//   • Deliveries are signed Stripe-style: X-FluxDrop-Signature: t=<ts>,v1=<hex>
//     where v1 = HMAC-SHA256(secret, `${ts}.${rawBody}`). A per-hook secret
//     is minted at add time when the admin doesn't supply one.
//   • PRIVACY: payloads mirror the existing log discipline — room codes,
//     counts, sizes and timestamps ONLY. Never PINs, aliases, SDP or content.
//   • Delivery is best-effort (5 s timeout, 2 retries, 1 s backoff) and never
//     blocks or crashes the room path — the bus await is fire-and-forget.

import { createHmac, randomBytes } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type LogFn = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void

/** The catalog of emittable bus events (also drives the admin UI checkboxes). */
export const BUS_EVENTS = [
  'room.created',
  'room.joined',
  'room.closed',
  'pairing.confirmed',
  'transfer.started',
  'transfer.complete',
  'relay.quota',
  'federation.link',
  'leaderboard.entry',
  'webhook.test',
] as const
export type BusEvent = (typeof BUS_EVENTS)[number]

export interface WebhookConfig {
  id: string
  url: string
  events: string[]
  secret: string
  active: boolean
  createdAt: number
}

export interface WebhookStats {
  delivered: number
  failed: number
  lastStatus: number | null
  lastAt: number | null
}

interface DeliveryLogEntry {
  at: number
  hookId: string
  event: string
  status: number | 'error' | 'skipped'
  attempt: number
}

const DATA_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'data')
const STORE_PATH = join(DATA_DIR, 'webhooks.json')

const hooks = new Map<string, WebhookConfig>()
const stats = new Map<string, WebhookStats>()
const deliveryLog: DeliveryLogEntry[] = []
const DELIVERY_LOG_MAX = 50
let initialized = false

function logVia(log: LogFn): void {
  // module-level logging goes through the host's structured logger
  log('debug', 'webhooks', { hooks: hooks.size })
}

function defaultStats(): WebhookStats {
  return { delivered: 0, failed: 0, lastStatus: null, lastAt: null }
}

function isValidWebhookUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

function sanitizeEvents(events: unknown): string[] {
  if (!Array.isArray(events)) return []
  const wanted = new Set<string>()
  for (const e of events) {
    if (typeof e === 'string' && (BUS_EVENTS as readonly string[]).includes(e)) wanted.add(e)
  }
  return [...wanted]
}

async function persist(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(STORE_PATH, JSON.stringify(Array.from(hooks.values()), null, 2))
  } catch {
    /* persistence is best-effort; the in-memory registry stays authoritative */
  }
}

export async function initWebhooks(log: LogFn, env: { WEBHOOKS?: string }): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const raw = await readFile(STORE_PATH, 'utf8')
    const arr = JSON.parse(raw) as WebhookConfig[]
    if (Array.isArray(arr)) {
      for (const h of arr) {
        if (h?.id && isValidWebhookUrl(h.url)) {
          hooks.set(h.id, { ...h, events: sanitizeEvents(h.events) })
          stats.set(h.id, defaultStats())
        }
      }
    }
  } catch {
    /* no store yet — fine */
  }
  // Env seeds (not persisted; merged on every boot).
  try {
    if (env.WEBHOOKS) {
      const arr = JSON.parse(env.WEBHOOKS) as Array<{ url: string; events?: string[]; secret?: string }>
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (!isValidWebhookUrl(e.url)) continue
          const id = `env-${createHmac('sha256', e.url).digest('hex').slice(0, 8)}`
          if (hooks.has(id)) continue
          hooks.set(id, {
            id,
            url: e.url,
            events: sanitizeEvents(e.events) ?? [],
            secret: e.secret || randomBytes(24).toString('hex'),
            active: true,
            createdAt: Date.now(),
          })
          stats.set(id, defaultStats())
        }
      }
    }
  } catch {
    log('warn', 'webhooks_env_invalid', {})
  }
  logVia(log)
  log('info', 'webhooks_ready', { hooks: hooks.size })
}

function sign(secret: string, ts: number, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
}

async function deliver(hook: WebhookConfig, event: string, data: Record<string, unknown>, log: LogFn, attempt = 1): Promise<void> {
  const body = JSON.stringify({ event, at: Date.now(), data })
  const ts = Math.floor(Date.now() / 1000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  let status: number | 'error' = 'error'
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FluxDrop-Event': event,
        'X-FluxDrop-Signature': `t=${ts},v1=${sign(hook.secret, ts, body)}`,
        'User-Agent': 'FluxDrop-Signaling-Webhook/1',
      },
      body,
      signal: controller.signal,
    })
    status = res.status
  } catch {
    status = 'error'
  } finally {
    clearTimeout(timer)
  }
  const st = stats.get(hook.id) ?? defaultStats()
  const ok = typeof status === 'number' && status >= 200 && status < 300
  if (ok) st.delivered++
  else st.failed++
  st.lastStatus = typeof status === 'number' ? status : null
  st.lastAt = Date.now()
  stats.set(hook.id, st)
  deliveryLog.push({ at: Date.now(), hookId: hook.id, event, status, attempt })
  if (deliveryLog.length > DELIVERY_LOG_MAX) deliveryLog.splice(0, deliveryLog.length - DELIVERY_LOG_MAX)
  if (!ok && attempt < 3) {
    setTimeout(() => { void deliver(hook, event, data, log, attempt + 1) }, 1000 * attempt)
    return
  }
  log(ok ? 'info' : 'warn', 'webhook_delivery', { hookId: hook.id, event, status, attempt })
}

/** Fan a lifecycle event out to every matching active hook (fire-and-forget). */
export function emitBusEvent(log: LogFn, event: BusEvent, data: Record<string, unknown>): void {
  if (!initialized || hooks.size === 0) return
  const payload = { ...data }
  // Defense-in-depth: strip fields that must never leave the server.
  delete payload.pin
  delete payload.sdp
  delete payload.candidate
  for (const hook of hooks.values()) {
    if (!hook.active) continue
    if (!hook.events.includes(event)) continue
    void deliver(hook, event, payload, log)
  }
}

// ── Admin surface ──

export function webhookSnapshot(): Record<string, unknown> {
  return {
    catalog: BUS_EVENTS,
    hooks: Array.from(hooks.values()).map((h) => ({
      id: h.id,
      url: h.url,
      events: h.events,
      active: h.active,
      createdAt: h.createdAt,
      stats: stats.get(h.id) ?? defaultStats(),
    })),
    recentDeliveries: [...deliveryLog].slice(-12).reverse(),
  }
}

export async function webhookAdminAction(
  log: LogFn,
  action: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (action === 'webhook-add') {
    const url = String(body.url ?? '').trim()
    if (!isValidWebhookUrl(url)) return { status: 400, body: { error: 'valid http(s) url required' } }
    const events = sanitizeEvents(body.events)
    if (events.length === 0) return { status: 400, body: { error: `events must be a non-empty subset of: ${BUS_EVENTS.join(', ')}` } }
    const id = `wh-${randomBytes(4).toString('hex')}`
    const secret = String(body.secret ?? '') || randomBytes(24).toString('hex')
    hooks.set(id, { id, url, events, secret, active: true, createdAt: Date.now() })
    stats.set(id, defaultStats())
    await persist()
    log('info', 'webhook_added', { hookId: id, events })
    return { status: 200, body: { ok: true, action, webhook: { id, secret } } }
  }
  if (action === 'webhook-remove' || action === 'webhook-toggle') {
    const id = String(body.id ?? '')
    const hook = hooks.get(id)
    if (!hook) return { status: 404, body: { error: 'webhook not found' } }
    if (action === 'webhook-remove') {
      hooks.delete(id)
      stats.delete(id)
    } else {
      hook.active = !hook.active
    }
    await persist()
    log('info', `webhook_${action === 'webhook-remove' ? 'removed' : 'toggled'}`, { hookId: id, active: hook.active !== false })
    return { status: 200, body: { ok: true, action } }
  }
  if (action === 'webhook-test') {
    const id = String(body.id ?? '')
    const hook = hooks.get(id)
    if (!hook) return { status: 404, body: { error: 'webhook not found' } }
    emitBusEvent(log, 'webhook.test', { message: 'FluxDrop webhook test — if you can read this, the automation hub works.' })
    return { status: 200, body: { ok: true, action } }
  }
  return { status: 400, body: { error: `unknown webhook action '${action}'` } }
}
