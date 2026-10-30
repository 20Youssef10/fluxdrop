// v4 central preferences store (zustand + localStorage).
// Holds every NEW v4 user-facing toggle that doesn't belong to the transfer
// session itself (accent theming, i18n, QoS, sounds & haptics, sync,
// automation, accessibility). Kept SEPARATE from session-store on purpose:
// session-store owns identity/room/peer state, prefs own device-wide UX knobs.

'use client'

import { create } from 'zustand'
// v5-a1: clamps the fast-lane count (shared protocol constant).
import { FAST_LANE_MAX } from './protocol'

export type AccentId = 'emerald' | 'fern' | 'amber' | 'rose' | 'violet' | 'custom'
export type SoundPack = 'calm' | 'lively' | 'silent'
export type LocaleId = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'ja' | 'ar'

export interface QuietHours {
  enabled: boolean
  /** 0-23, local time. */
  from: number
  to: number
}

interface PrefsState {
  // 5.5 accent theming
  accent: AccentId
  setAccent: (a: AccentId) => void
  highContrast: boolean
  setHighContrast: (v: boolean) => void

  // 10.1 i18n
  locale: LocaleId
  setLocale: (l: LocaleId) => void

  // v5-c10: OLED black — pure-black surfaces under dark mode (only applies
  // while the dark theme is active; harmless no-op in light).
  oledBlack: boolean
  setOledBlack: (v: boolean) => void

  // v5-c10: custom accent — user-chosen hue for the 'custom' accent preset.
  customAccentHue: number
  setCustomAccentHue: (h: number) => void

  // 10.3 low-vision transfer mode (large type + extra contrast + SAS readout)
  lowVision: boolean
  setLowVision: (v: boolean) => void

  // 10.2 a11y: force-reduce motion (overrides animations app-wide)
  reduceMotion: boolean
  setReduceMotion: (v: boolean) => void

  // 1.3 bandwidth throttle / QoS — 0 = unlimited
  qosCapMbps: number
  setQosCapMbps: (mbps: number) => void

  // v5-a1 fast lanes: number of parallel transports (1 = off/legacy, up to
  // FAST_LANE_MAX) used to stripe a large single-receiver transfer. Read once
  // when a transfer starts — applies to the NEXT transfer.
  fastLanes: number
  setFastLanes: (n: number) => void

  // v5-a2 server relay fallback: when the recovery ladder exhausts and P2P
  // is impossible, stream the (already end-to-end-encrypted) chunks through
  // the signaling server instead of failing the transfer. Rate-limited
  // server-side; never engages while P2P works (dead code path then).
  relayFallback: boolean
  setRelayFallback: (v: boolean) => void

  // v5-a3w delta sync: single-file sends may stream only the CHANGED bytes
  // when the receiver already keeps a similar older copy in its files vault
  // (rsync-lite patch). Read when a transfer starts — applies to the NEXT
  // transfer; any failure anywhere silently falls back to a full send.
  deltaSync: boolean
  setDeltaSync: (v: boolean) => void

  // v5-b1: disappearing transfers — minutes a received copy stays in the
  // receiver's vault before auto-purging (sender-side default, stamped into
  // every manifest as ttlMs). 0 = keep until the receiver's own budget rules
  // evict. Applies to the NEXT transfer.
  disappearTtlMinutes: number
  setDisappearTtlMinutes: (m: number) => void

  // 1.7 Merkle integrity tree on send (extra pre-send read pass)
  merkleEnabled: boolean
  setMerkleEnabled: (v: boolean) => void

  // 5.4 sound & haptics
  soundPack: SoundPack
  setSoundPack: (p: SoundPack) => void
  hapticsEnabled: boolean
  setHapticsEnabled: (v: boolean) => void
  quietHours: QuietHours
  setQuietHours: (q: Partial<QuietHours>) => void

  // 4.6 clipboard sync (opt-in, both peers must enable)
  clipboardSync: boolean
  setClipboardSync: (v: boolean) => void

  // 1.8 post-transfer automation
  autoOpenFirstFile: boolean
  setAutoOpenFirstFile: (v: boolean) => void

  // 3.2 nearby visibility — announce this device on the LAN panel
  nearbyVisible: boolean
  setNearbyVisible: (v: boolean) => void

  // 7.3 background resilience — auto-pause on hidden/frozen + resume notify
  backgroundResilience: boolean
  setBackgroundResilience: (v: boolean) => void

  // 5.6 first-run speedrun — completed flag (also gates re-showing)
  speedrunDone: boolean
  setSpeedrunDone: () => void

  // v5-a6 watch folder: auto-send the detected-file queue whenever a send
  // session is live (open room) and no transfer is in flight. Opt-in.
  watchAutoSend: boolean
  setWatchAutoSend: (v: boolean) => void

  // v5-a6 scheduled send: fire the watch queue at a fixed local time.
  // scheduleTime is 'HH:MM' (24h); scheduleDaily keeps it recurring (one-shot
  // when off — the enable switch flips itself back off after firing).
  scheduleEnabled: boolean
  setScheduleEnabled: (v: boolean) => void
  scheduleTime: string
  setScheduleTime: (v: string) => void
  scheduleDaily: boolean
  setScheduleDaily: (v: boolean) => void
}

const KEY = 'fluxdrop:prefs-v4'

function loadPrefs(): Partial<PrefsState> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed as Partial<PrefsState>
  } catch {
    return {}
  }
}

function persist(patch: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem(KEY)
    const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    localStorage.setItem(KEY, JSON.stringify({ ...current, ...patch }))
  } catch { /* ignore */ }
}

const stored = typeof window === 'undefined' ? {} : loadPrefs()

export const usePrefsStore = create<PrefsState>((set) => ({
  accent: 'emerald',
  setAccent: (accent) => {
    set({ accent })
    persist({ accent })
    applyAccent(accent)
  },

  highContrast: false,
  setHighContrast: (v) => {
    set({ highContrast: v })
    persist({ highContrast: v })
    applyBodyClass('flux-highcontrast', v)
  },

  locale: 'en',
  setLocale: (locale) => {
    set({ locale })
    persist({ locale })
    applyLocaleDirection(locale)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fluxdrop:locale-changed', { detail: { locale } }))
    }
  },

  // v5-c10: OLED black (scoped to dark mode via CSS — the class is harmless
  // in light theme because every override lives under `.dark.flux-oled`).
  oledBlack: false,
  setOledBlack: (v) => {
    set({ oledBlack: v })
    persist({ oledBlack: v })
    applyBodyClass('flux-oled', v)
  },

  // v5-c10: custom accent hue (0–360, oklch chroma follows the family default).
  customAccentHue: 174,
  setCustomAccentHue: (h) => {
    const v = Math.max(0, Math.min(360, Math.round(h) || 0))
    set({ customAccentHue: v })
    persist({ customAccentHue: v })
    // Live preview: re-apply the accent when 'custom' is the active preset.
    if (usePrefsStore.getState().accent === 'custom') {
      applyAccent('custom', v)
    }
  },

  lowVision: false,
  setLowVision: (v) => {
    set({ lowVision: v })
    persist({ lowVision: v })
    applyBodyClass('flux-lowvision', v)
  },

  reduceMotion: false,
  setReduceMotion: (v) => {
    set({ reduceMotion: v })
    persist({ reduceMotion: v })
    applyBodyClass('flux-reduce-motion', v)
  },

  qosCapMbps: 0,
  setQosCapMbps: (mbps) => {
    const v = Math.max(0, Math.min(1000, Math.round(mbps)))
    set({ qosCapMbps: v })
    persist({ qosCapMbps: v })
  },

  // v5-a1: 1..FAST_LANE_MAX, default 1 (= legacy single transport).
  fastLanes: 1,
  setFastLanes: (n) => {
    const v = Math.max(1, Math.min(FAST_LANE_MAX, Math.round(n) || 1))
    set({ fastLanes: v })
    persist({ fastLanes: v })
  },

  // v5-a2: on by default — a last-ditch relay beats a failed transfer.
  relayFallback: true,
  setRelayFallback: (v) => {
    set({ relayFallback: v })
    persist({ relayFallback: v })
  },

  // v5-a3w: on by default — an opportunistic patch beats re-sending the whole
  // file; declining (no prior copy, oversized patch) is always safe.
  deltaSync: true,
  setDeltaSync: (v) => {
    set({ deltaSync: v })
    persist({ deltaSync: v })
  },

  // v5-b1: off by default — retention is the receiver's business until the
  // sender explicitly asks for disappearing copies.
  disappearTtlMinutes: 0,
  setDisappearTtlMinutes: (m) => {
    const v = Math.max(0, Math.min(10080, Math.round(m) || 0)) // ≤ 1 week
    set({ disappearTtlMinutes: v })
    persist({ disappearTtlMinutes: v })
  },

  merkleEnabled: true,
  setMerkleEnabled: (v) => {
    set({ merkleEnabled: v })
    persist({ merkleEnabled: v })
  },

  soundPack: 'calm',
  setSoundPack: (p) => {
    set({ soundPack: p })
    persist({ soundPack: p })
  },

  hapticsEnabled: false,
  setHapticsEnabled: (v) => {
    set({ hapticsEnabled: v })
    persist({ hapticsEnabled: v })
  },

  quietHours: { enabled: false, from: 22, to: 8 },
  setQuietHours: (q) => {
    set((s) => {
      const next = { ...s.quietHours, ...q }
      persist({ quietHours: next })
      return { quietHours: next }
    })
  },

  clipboardSync: false,
  setClipboardSync: (v) => {
    set({ clipboardSync: v })
    persist({ clipboardSync: v })
  },

  autoOpenFirstFile: false,
  setAutoOpenFirstFile: (v) => {
    set({ autoOpenFirstFile: v })
    persist({ autoOpenFirstFile: v })
  },

  nearbyVisible: true,
  setNearbyVisible: (v) => {
    set({ nearbyVisible: v })
    persist({ nearbyVisible: v })
  },

  backgroundResilience: true,
  setBackgroundResilience: (v) => {
    set({ backgroundResilience: v })
    persist({ backgroundResilience: v })
  },

  speedrunDone: false,
  setSpeedrunDone: () => {
    set({ speedrunDone: true })
    persist({ speedrunDone: true })
  },

  // v5-a6: watch folder + scheduled send knobs (consumed by watch-folder-panel.tsx).
  watchAutoSend: false,
  setWatchAutoSend: (v) => {
    set({ watchAutoSend: v })
    persist({ watchAutoSend: v })
  },

  scheduleEnabled: false,
  setScheduleEnabled: (v) => {
    set({ scheduleEnabled: v })
    persist({ scheduleEnabled: v })
  },

  scheduleTime: '09:00',
  setScheduleTime: (v) => {
    // v5-a6: normalize to a valid 24h 'HH:MM' slot; anything else falls back to the default.
    const m = /^(\d{2}):(\d{2})$/.exec(v)
    const time = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? v : '09:00'
    set({ scheduleTime: time })
    persist({ scheduleTime: time })
  },

  scheduleDaily: true,
  setScheduleDaily: (v) => {
    set({ scheduleDaily: v })
    persist({ scheduleDaily: v })
  },

  ...stored,
}))

// === Accent presets (5.5) ===
// Tailwind v4 utilities reference the --color-flux-* variables, so overriding
// them on <html> re-skins the whole app without touching any component.
// Hue values keep the brand's "green family" first; others are warm/cool
// accents that avoid the indigo/blue lane.
// v5-c10: 'custom' resolves its hue from the prefs store at apply time.
export const ACCENTS: Record<AccentId, { label: string; hue: number; chroma: number }> = {
  emerald: { label: 'Emerald', hue: 172, chroma: 0.15 },
  fern: { label: 'Fern', hue: 148, chroma: 0.14 },
  amber: { label: 'Amber', hue: 75, chroma: 0.13 },
  rose: { label: 'Rose', hue: 18, chroma: 0.14 },
  violet: { label: 'Violet', hue: 305, chroma: 0.13 },
  custom: { label: 'Custom', hue: 174, chroma: 0.14 },
}

function fluxScale(hue: number, chroma: number): Record<string, string> {
  // Lightness/chroma ramp mirroring the original oklch flux scale, re-hued.
  const steps: Array<[number, number, number]> = [
    [50, 0.97, 0.03], [100, 0.93, 0.06], [200, 0.86, 0.1], [300, 0.78, 0.13],
    [400, 0.7, Math.max(0.13, chroma - 0.01)], [500, 0.62, chroma],
    [600, 0.54, Math.max(0.12, chroma - 0.01)], [700, 0.45, 0.12],
    [800, 0.36, 0.08], [900, 0.27, 0.05], [950, 0.18, 0.03],
  ]
  const out: Record<string, string> = {}
  for (const [step, l, c] of steps) out[`--color-flux-${step}`] = `oklch(${l} ${c} ${hue})`
  return out
}

export function applyAccent(accent: AccentId, customHue?: number): void {
  if (typeof document === 'undefined') return
  const preset = ACCENTS[accent] ?? ACCENTS.emerald
  // v5-c10: the custom preset takes its hue from the prefs store (live slider).
  const hue = accent === 'custom' ? (customHue ?? usePrefsStore.getState().customAccentHue) : preset.hue
  const chroma = preset.chroma
  const vars = fluxScale(hue, chroma)
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  // Keep primary/ring/chart-1 in the same family so shadcn surfaces match.
  root.style.setProperty('--primary', `oklch(0.54 ${Math.max(0.12, chroma - 0.01)} ${hue})`)
  root.style.setProperty('--ring', `oklch(0.62 ${chroma} ${hue})`)
  root.style.setProperty('--chart-1', `oklch(0.62 ${chroma} ${hue})`)
}

/**
 * v5-c9: RTL pass — set <html dir> (+ lang) for the locale. Arabic is the
 * first RTL locale; every logical-property layout follows the attribute.
 */
export function applyLocaleDirection(locale: LocaleId): void {
  if (typeof document === 'undefined') return
  const rtl = locale === 'ar'
  document.documentElement.dir = rtl ? 'rtl' : 'ltr'
  document.documentElement.lang = locale
}

function applyBodyClass(cls: string, on: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(cls, on)
}

/** Apply every persisted visual pref on boot (called once from the app root). */
export function applyPersistedPrefs(): void {
  const s = usePrefsStore.getState()
  applyAccent(s.accent)
  applyBodyClass('flux-highcontrast', s.highContrast)
  applyBodyClass('flux-lowvision', s.lowVision)
  applyBodyClass('flux-reduce-motion', s.reduceMotion)
  // v5-c10 / v5-c9: OLED black + locale direction.
  applyBodyClass('flux-oled', s.oledBlack)
  applyLocaleDirection(s.locale)
}
