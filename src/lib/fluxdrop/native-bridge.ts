// v5-d12/d13: native shell bridge — the ONE typed surface the web app uses to
// talk to the native shells (Tauri desktop / Capacitor Android), plus a
// first-class SIMULATION mode so the whole integration is demo- and
// E2E-testable in a plain browser.
//
// Design rules:
//   - Detection is sync and cheap (`__TAURI__` global / `window.Capacitor`).
//   - Every function is a safe no-op on the plain web build — the app must
//     stay byte-for-byte functional in a browser.
//   - Simulation mirrors the real capability matrix of the chosen shell and
//     logs every bridge call (`[native-bridge] ▸ op`) so behavior is
//     observable in devtools and assertions in E2E.
//   - The web side NEVER imports @tauri-apps/* or @capacitor/* — the shells
//     inject globals; we probe them with local, minimal typings.
//
// Shell ownership of features (why caps differ):
//   Tauri    — tray + status, autostart, fluxdrop:// deep links (plugin),
//              file associations ("open with"), chunked reads of OS-handed
//              files (allowlisted in Rust), opener.
//   Capacitor— Android foreground transfer service (v5-d13) + partial wake
//              lock, share-sheet in/out, fluxdrop:// intent filter,
//              keep-screen-on, opener.

'use client'

import { usePrefsStore } from './prefs'

export type NativeShellKind = 'web' | 'tauri' | 'capacitor'

export interface NativeShellCapabilities {
  tray: boolean
  autostart: boolean
  deepLinks: boolean
  /** OS → app: "share to FluxDrop" / "open with FluxDrop". */
  shareTarget: boolean
  /** app → OS share sheet (Android ACTION_SEND). */
  shareOut: boolean
  foregroundService: boolean
  keepScreenAwake: boolean
  openExternal: boolean
  /** Chunked reads of OS-handed files (Tauri file associations). */
  readFileChunk: boolean
}

export interface NativeShellInfo {
  kind: NativeShellKind
  platform: string
  simulated: boolean
  capabilities: NativeShellCapabilities
}

/** A file handed to us by the OS (share sheet / file association). */
export interface NativeSharedFile {
  name: string
  size: number
  mime: string
  /** Absolute path (Tauri: OS path; Capacitor: cache copy to fetch). */
  path?: string
  /** Simulation only: in-memory bytes so the sender can be armed for real. */
  data?: Uint8Array
}

export type NativeShellEvent =
  | { type: 'deep-link'; url: string }
  | { type: 'open-files'; files: NativeSharedFile[] }

// ---------------------------------------------------------------------------
// Minimal structural typings for the shell globals (no npm deps).

interface TauriGlobal {
  core?: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  event?: {
    listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>
  }
}

interface CapacitorPluginProxy {
  [method: string]: (...args: unknown[]) => Promise<unknown> & { addListener?: (ev: string, cb: (data: unknown) => void) => Promise<unknown> }
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  convertFileSrc?: (path: string) => string
  Plugins?: Record<string, CapacitorPluginProxy | undefined>
}

// ---------------------------------------------------------------------------
// Detection

const WEB_CAPS: NativeShellCapabilities = {
  tray: false,
  autostart: false,
  deepLinks: false,
  shareTarget: false,
  shareOut: false,
  foregroundService: false,
  keepScreenAwake: false,
  openExternal: false,
  readFileChunk: false,
}

const TAURI_CAPS: NativeShellCapabilities = {
  tray: true,
  autostart: true,
  deepLinks: true,
  shareTarget: true,
  shareOut: false, // no cross-platform desktop share API in Tauri v2 (documented)
  foregroundService: false,
  keepScreenAwake: true, // Wake Lock API inside the desktop webview
  openExternal: true,
  readFileChunk: true,
}

const CAPACITOR_CAPS: NativeShellCapabilities = {
  tray: false,
  autostart: false,
  deepLinks: true,
  shareTarget: true,
  shareOut: true,
  foregroundService: true,
  keepScreenAwake: true,
  openExternal: true,
  readFileChunk: false, // files arrive as cache copies fetched over the bridge
}

function detectTauri(): TauriGlobal | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __TAURI__?: TauriGlobal; __TAURI_INTERNALS__?: unknown }
  if (w.__TAURI__) return w.__TAURI__
  return null
}

function detectCapacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null
  const c = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (c && typeof c.isNativePlatform === 'function' && c.isNativePlatform()) return c
  return null
}

/** One-shot `?shellSim=tauri|capacitor` override (demo/testing; session-long
 *  until the user explicitly picks a shell in Settings — see
 *  clearNativeShellOverride). Deliberately NOT stripped from the URL: Next's
 *  router restores the query anyway, and a visible param is honest. */
let querySim: NativeShellKind | null = null
if (typeof window !== 'undefined') {
  try {
    const q = new URLSearchParams(window.location.search).get('shellSim')
    if (q === 'tauri' || q === 'capacitor') {
      querySim = q
    }
  } catch {
    /* ignore */
  }
}

/** An explicit Settings selection beats the URL override. */
export function clearNativeShellOverride(): void {
  querySim = null
}

/** The simulated shell for this session ('web' = none). */
export function getSimulatedShell(): NativeShellKind {
  if (querySim) return querySim
  try {
    const pref = usePrefsStore.getState().nativeShellSim
    if (pref === 'tauri' || pref === 'capacitor') return pref
  } catch {
    /* prefs not ready — fall through */
  }
  return 'web'
}

function osFromUA(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos'
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Linux/i.test(ua)) return 'linux'
  return 'unknown'
}

/**
 * Sync shell detection (real shell first, then the simulation override).
 * Cheap enough to call per render; never throws; SSR-safe.
 */
export function getNativeShellInfo(): NativeShellInfo {
  if (typeof window === 'undefined') {
    return { kind: 'web', platform: 'server', simulated: false, capabilities: WEB_CAPS }
  }
  if (detectTauri()) {
    return { kind: 'tauri', platform: osFromUA(), simulated: false, capabilities: TAURI_CAPS }
  }
  if (detectCapacitor()) {
    return {
      kind: 'capacitor',
      platform: osFromUA() === 'ios' ? 'ios' : 'android',
      simulated: false,
      capabilities: CAPACITOR_CAPS,
    }
  }
  const sim = getSimulatedShell()
  if (sim === 'tauri') return { kind: 'tauri', platform: osFromUA(), simulated: true, capabilities: TAURI_CAPS }
  if (sim === 'capacitor') {
    return { kind: 'capacitor', platform: 'android', simulated: true, capabilities: CAPACITOR_CAPS }
  }
  return { kind: 'web', platform: 'web', simulated: false, capabilities: WEB_CAPS }
}

/** True when running inside a real or simulated native shell. */
export function isNativeShell(): boolean {
  return getNativeShellInfo().kind !== 'web'
}

// ---------------------------------------------------------------------------
// Observable bridge state (Settings card + E2E assertions subscribe to this)

export interface BridgeCall {
  at: number
  op: string
  detail?: string
}

export interface BridgeState {
  /** Android foreground service (or, conceptually, the tray status line). */
  serviceRunning: boolean
  lastStatus: string
  calls: BridgeCall[]
}

let bridgeState: BridgeState = { serviceRunning: false, lastStatus: 'Idle', calls: [] }
const bridgeSubs = new Set<() => void>()

export function subscribeBridgeState(cb: () => void): () => void {
  bridgeSubs.add(cb)
  return () => {
    bridgeSubs.delete(cb)
  }
}

export function getBridgeState(): BridgeState {
  return bridgeState
}

function setBridgeState(patch: Partial<BridgeState>): void {
  bridgeState = { ...bridgeState, ...patch }
  for (const cb of bridgeSubs) {
    try {
      cb()
    } catch {
      /* listener errors never break the bridge */
    }
  }
}

function recordCall(op: string, detail?: string): void {
  const calls = bridgeState.calls.slice(-39)
  calls.push({ at: Date.now(), op, detail })
  setBridgeState({ calls })
}

// ---------------------------------------------------------------------------
// Shell plumbing

function tauri(): TauriGlobal | null {
  return detectTauri()
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const t = tauri()
  if (!t?.core?.invoke) return null
  try {
    return (await t.core.invoke(cmd, args)) as T
  } catch (err) {
    console.warn(`[native-bridge] ${cmd} failed:`, err)
    return null
  }
}

function capacitorPlugin(): CapacitorPluginProxy | null {
  const c = detectCapacitor()
  return c?.Plugins?.FluxDropShell ?? null
}

// --- unified native → web events -------------------------------------------

type NativeListener = (e: NativeShellEvent) => void
const listeners = new Set<NativeListener>()
let attachedRealListeners = false

function dispatchNativeEvent(e: NativeShellEvent): void {
  for (const l of Array.from(listeners)) {
    try {
      l(e)
    } catch {
      /* listener errors never break the bridge */
    }
  }
}

function attachRealListenersOnce(): void {
  if (attachedRealListeners || typeof window === 'undefined') return
  attachedRealListeners = true
  // Tauri: the Rust shell re-emits EVERYTHING (deep links, file associations,
  // second-instance args) as one unified `fluxdrop://native` event.
  const t = tauri()
  if (t?.event?.listen) {
    void t.event.listen('fluxdrop://native', (e) => {
      const payload = e.payload as Partial<NativeShellEvent> | null
      if (!payload || typeof payload.type !== 'string') return
      if (payload.type === 'deep-link' && typeof payload.url === 'string') {
        dispatchNativeEvent({ type: 'deep-link', url: payload.url })
      } else if (payload.type === 'open-files' && Array.isArray(payload.files)) {
        dispatchNativeEvent({
          type: 'open-files',
          files: (payload.files as NativeSharedFile[]).filter(
            (f) => f && typeof f.name === 'string' && typeof f.size === 'number'
          ),
        })
      }
    })
  }
  // Capacitor: our FluxDropShell plugin notifies the same shapes on
  // 'fluxdrop:native' (share sheet, intent deep links).
  const plugin = capacitorPlugin()
  if (plugin?.addListener) {
    void plugin.addListener('fluxdrop:native', (data: unknown) => {
      const payload = data as Partial<NativeShellEvent> | null
      if (!payload || typeof payload.type !== 'string') return
      if (payload.type === 'deep-link' && typeof payload.url === 'string') {
        dispatchNativeEvent({ type: 'deep-link', url: payload.url })
      } else if (payload.type === 'open-files' && Array.isArray(payload.files)) {
        dispatchNativeEvent({
          type: 'open-files',
          files: (payload.files as NativeSharedFile[]).filter(
            (f) => f && typeof f.name === 'string' && typeof f.size === 'number'
          ),
        })
      }
    })
  }
}

/** Subscribe to native shell events (deep links, OS share/file opens). */
export function onNativeEvent(cb: NativeListener): () => void {
  listeners.add(cb)
  attachRealListenersOnce()
  return () => {
    listeners.delete(cb)
  }
}

// ---------------------------------------------------------------------------
// Bridge API — every function is a safe no-op on the web build

/**
 * v5-d13: transfer lifecycle → the shell's "keep it alive" machinery.
 * `active=true` starts (or updates) the Android foreground service /
 * refreshes the desktop tray status; `active=false` stops / returns to Idle.
 */
export function nativeTransferStatus(active: boolean, statusText: string): void {
  const info = getNativeShellInfo()
  if (info.kind === 'web') return
  recordCall(`transfersActive(${active})`, statusText)
  setBridgeState({ serviceRunning: active, lastStatus: statusText })
  if (info.simulated) {
    console.info(`[native-bridge] ▸ transfersActive(${active}) — "${statusText}"`)
    return
  }
  if (info.kind === 'capacitor') {
    const p = capacitorPlugin()
    if (!p) return
    if (active) {
      void p.startTransferService({ title: 'FluxDrop', text: statusText })
    } else {
      void p.stopTransferService()
    }
  } else if (info.kind === 'tauri') {
    void tauriInvoke('flux_set_tray_status', { text: active ? statusText : 'Idle' })
  }
}

/** Simulated autostart state (round-trips the Settings toggle in sim). */
let simAutostart = false

export async function nativeSetAutostart(enabled: boolean): Promise<boolean> {
  const info = getNativeShellInfo()
  if (!info.capabilities.autostart) return false
  recordCall('setAutostart', String(enabled))
  if (info.simulated) {
    simAutostart = enabled
    console.info(`[native-bridge] ▸ setAutostart(${enabled})`)
    return enabled
  }
  if (info.kind === 'tauri') {
    await tauriInvoke<boolean>('flux_set_autostart', { enabled })
    return nativeGetAutostart()
  }
  return false
}

export async function nativeGetAutostart(): Promise<boolean> {
  const info = getNativeShellInfo()
  if (!info.capabilities.autostart) return false
  if (info.simulated) return simAutostart
  if (info.kind === 'tauri') {
    return (await tauriInvoke<boolean>('flux_autostart_enabled')) ?? false
  }
  return false
}

let webviewWakeLock: WakeLockSentinel | null = null

/** TS 5.7: Uint8Array<ArrayBufferLike> isn't assignable to BlobPart (it may
 *  be backed by a SharedArrayBuffer) — copy into a plain ArrayBuffer. */
function toBlobPart(u: Uint8Array): BlobPart {
  return u.slice().buffer as ArrayBuffer
}

/** Keep the screen on while a transfer runs (Android window flag / wake lock). */
export function nativeKeepScreenAwake(on: boolean): void {
  const info = getNativeShellInfo()
  if (!info.capabilities.keepScreenAwake) return
  recordCall('keepScreenAwake', String(on))
  if (info.simulated) {
    console.info(`[native-bridge] ▸ keepScreenAwake(${on})`)
    return
  }
  if (info.kind === 'capacitor') {
    capacitorPlugin()?.keepScreenAwake({ enabled: on })
    return
  }
  if (info.kind === 'tauri') {
    // Desktop: the process survives screen lock regardless — the wake lock
    // is a UX nicety for kiosk-style senders. Best-effort via the webview.
    try {
      if (on && 'wakeLock' in navigator) {
        void navigator.wakeLock
          .request('screen')
          .then((l) => {
            webviewWakeLock = l
          })
          .catch(() => {
            /* denied — transfers still run */
          })
      } else if (!on && webviewWakeLock) {
        void webviewWakeLock.release().catch(() => undefined)
        webviewWakeLock = null
      }
    } catch {
      /* unsupported — no-op */
    }
  }
}

/** Open an http(s) URL with the OS (docs, help, room links on desktop). */
export function nativeOpenExternal(url: string): void {
  const info = getNativeShellInfo()
  if (!info.capabilities.openExternal || !/^https?:\/\//i.test(url)) return
  recordCall('openExternal', url.slice(0, 80))
  if (info.simulated) {
    console.info(`[native-bridge] ▸ openExternal(${url})`)
    return
  }
  if (info.kind === 'capacitor') {
    capacitorPlugin()?.openExternal({ url })
  } else if (info.kind === 'tauri') {
    void tauriInvoke('flux_open_external', { url })
  }
}

/**
 * Chunked read of an OS-handed file (Tauri file associations). The Rust side
 * only serves paths it recorded when the OS opened them with FluxDrop — the
 * webview can't read arbitrary disk locations through this.
 */
export async function nativeReadFileChunk(
  path: string,
  offset: number,
  length: number
): Promise<Uint8Array | null> {
  const info = getNativeShellInfo()
  if (!info.capabilities.readFileChunk || info.simulated) return null
  if (info.kind === 'tauri') {
    const buf = await tauriInvoke<ArrayBuffer | Uint8Array>('flux_read_file_chunk', { path, offset, length })
    if (!buf) return null
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  }
  return null
}

/**
 * Turn an open-files event into real File objects for the sender queue.
 *  - Tauri: chunked reads through the allowlisted Rust command (64 MiB cap
 *    per file — larger associations fall back to the manual picker).
 *  - Capacitor: fetch the plugin's cache copies via convertFileSrc.
 *  - Simulation: build Files from in-memory bytes.
 */
export async function resolveNativeEventFiles(e: NativeShellEvent): Promise<File[]> {
  if (e.type !== 'open-files') return []
  const info = getNativeShellInfo()
  const out: File[] = []
  const MAX_BYTES = 64 * 1024 * 1024

  for (const f of e.files) {
    try {
      if (f.data) {
        // Simulation (or any shell that already provided bytes).
        out.push(new File([toBlobPart(f.data)], f.name, { type: f.mime || 'application/octet-stream' }))
        continue
      }
      if (info.kind === 'tauri' && !info.simulated && f.path) {
        if (f.size > MAX_BYTES) {
          console.warn(`[native-bridge] ${f.name} is over the 64 MiB association cap — pick it manually`)
          continue
        }
        const CHUNK = 4 * 1024 * 1024
        const parts: BlobPart[] = []
        for (let off = 0; off < f.size; off += CHUNK) {
          const part = await nativeReadFileChunk(f.path, off, Math.min(CHUNK, f.size - off))
          if (!part) throw new Error('chunk read failed')
          parts.push(toBlobPart(part))
        }
        out.push(new File(parts, f.name, { type: f.mime || 'application/octet-stream' }))
        continue
      }
      if (info.kind === 'capacitor' && !info.simulated && f.path) {
        const c = detectCapacitor()
        const src = c?.convertFileSrc ? c.convertFileSrc(f.path) : null
        if (!src) continue
        const res = await fetch(src)
        if (!res.ok) throw new Error(`fetch ${f.name}: ${res.status}`)
        out.push(new File([await res.blob()], f.name, { type: f.mime || res.type || 'application/octet-stream' }))
      }
    } catch (err) {
      console.warn(`[native-bridge] could not read shared file ${f.name}:`, err)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Simulation hooks (window.__fluxdropSim) — demo + E2E entry points.

export interface SimShareInput {
  name: string
  text?: string
  bytes?: Uint8Array
  mime?: string
}

export interface FluxDropSimApi {
  /** Deliver a fluxdrop:// (or #hash) link exactly like the OS would. */
  deepLink(url: string): void
  /** Deliver an OS share-sheet / file-association open with in-memory files. */
  openFiles(files: SimShareInput[]): void
  /** Current simulated autostart state. */
  autostart(): boolean
}

if (typeof window !== 'undefined') {
  const api: FluxDropSimApi = {
    deepLink(url) {
      recordCall('sim.deepLink', url.slice(0, 80))
      dispatchNativeEvent({ type: 'deep-link', url })
    },
    openFiles(files) {
      recordCall('sim.openFiles', files.map((f) => f.name).join(',').slice(0, 80))
      dispatchNativeEvent({
        type: 'open-files',
        files: files.map((f) => ({
          name: f.name,
          size: f.bytes?.length ?? new TextEncoder().encode(f.text ?? '').length,
          mime: f.mime ?? 'application/octet-stream',
          data: f.bytes ?? (f.text !== undefined ? new TextEncoder().encode(f.text) : undefined),
        })),
      })
    },
    autostart() {
      return simAutostart
    },
  }
  ;(window as unknown as { __fluxdropSim?: FluxDropSimApi }).__fluxdropSim = api
}
