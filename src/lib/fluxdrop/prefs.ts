// v4 central preferences store (zustand + localStorage).
// Holds every NEW v4 user-facing toggle that doesn't belong to the transfer
// session itself (accent theming, i18n, QoS, sounds & haptics, sync,
// automation, accessibility). Kept SEPARATE from session-store on purpose:
// session-store owns identity/room/peer state, prefs own device-wide UX knobs.

'use client'

import { create } from 'zustand'

export type AccentId = 'emerald' | 'fern' | 'amber' | 'rose' | 'violet'
export type SoundPack = 'calm' | 'lively' | 'silent'
export type LocaleId = 'en' | 'es' | 'fr' | 'de' | 'pt' | 'ja'

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

  // 10.3 low-vision transfer mode (large type + extra contrast + SAS readout)
  lowVision: boolean
  setLowVision: (v: boolean) => void

  // 10.2 a11y: force-reduce motion (overrides animations app-wide)
  reduceMotion: boolean
  setReduceMotion: (v: boolean) => void

  // 1.3 bandwidth throttle / QoS — 0 = unlimited
  qosCapMbps: number
  setQosCapMbps: (mbps: number) => void

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
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fluxdrop:locale-changed', { detail: { locale } }))
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

  ...stored,
}))

// === Accent presets (5.5) ===
// Tailwind v4 utilities reference the --color-flux-* variables, so overriding
// them on <html> re-skins the whole app without touching any component.
// Hue values keep the brand's "green family" first; others are warm/cool
// accents that avoid the indigo/blue lane.
export const ACCENTS: Record<AccentId, { label: string; hue: number; chroma: number }> = {
  emerald: { label: 'Emerald', hue: 172, chroma: 0.15 },
  fern: { label: 'Fern', hue: 148, chroma: 0.14 },
  amber: { label: 'Amber', hue: 75, chroma: 0.13 },
  rose: { label: 'Rose', hue: 18, chroma: 0.14 },
  violet: { label: 'Violet', hue: 305, chroma: 0.13 },
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

export function applyAccent(accent: AccentId): void {
  if (typeof document === 'undefined') return
  const preset = ACCENTS[accent] ?? ACCENTS.emerald
  const vars = fluxScale(preset.hue, preset.chroma)
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  // Keep primary/ring/chart-1 in the same family so shadcn surfaces match.
  root.style.setProperty('--primary', `oklch(0.54 ${Math.max(0.12, preset.chroma - 0.01)} ${preset.hue})`)
  root.style.setProperty('--ring', `oklch(0.62 ${preset.chroma} ${preset.hue})`)
  root.style.setProperty('--chart-1', `oklch(0.62 ${preset.chroma} ${preset.hue})`)
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
}
