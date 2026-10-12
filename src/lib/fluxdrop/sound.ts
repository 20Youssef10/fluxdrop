// FluxDrop sound feedback: tiny WebAudio synth — no audio assets needed.
// All sounds are short, subtle, and synthesized on demand.

'use client'

const STORAGE_KEY = 'fluxdrop:sound-enabled'

let enabled: boolean | null = null
let ctx: AudioContext | null = null

/** Lazily get (and unlock) the shared AudioContext. */
function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

export function isSoundEnabled(): boolean {
  if (enabled !== null) return enabled
  if (typeof window === 'undefined') return false
  try {
    enabled = localStorage.getItem(STORAGE_KEY) !== 'false' // default: on
  } catch {
    enabled = true
  }
  return enabled
}

export function setSoundEnabled(v: boolean): void {
  enabled = v
  try {
    localStorage.setItem(STORAGE_KEY, v ? 'true' : 'false')
  } catch { /* ignore */ }
  // Warm up / unlock the context on explicit user enable.
  if (v) getCtx()
}

/** Play a short pre-audible warm-up blip so later chimes aren't clipped. */
export function unlockAudio(): void {
  getCtx()
}

interface ToneOptions {
  freq: number
  /** Absolute start time offset in seconds. */
  startAt?: number
  duration?: number
  type?: OscillatorType
  gain?: number
  /** Glide target frequency (Hz) — creates a chirp. */
  glideTo?: number
}

function tone(o: ToneOptions): void {
  const audio = getCtx()
  if (!audio) return
  try {
    const t0 = audio.currentTime + (o.startAt ?? 0)
    const dur = o.duration ?? 0.18
    const osc = audio.createOscillator()
    const g = audio.createGain()
    osc.type = o.type ?? 'sine'
    osc.frequency.setValueAtTime(o.freq, t0)
    if (o.glideTo != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.glideTo), t0 + dur)
    }
    // Quick attack, exponential decay — reads as a soft "ding".
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(o.gain ?? 0.08, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g).connect(audio.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  } catch { /* ignore — audio must never break a transfer */ }
}

/** Rising two-note chime — transfer complete / success. */
export function playSuccess(): void {
  if (!isSoundEnabled()) return
  tone({ freq: 523.25, duration: 0.16, gain: 0.07 })            // C5
  tone({ freq: 783.99, startAt: 0.12, duration: 0.28, gain: 0.08 }) // G5
  tone({ freq: 1046.5, startAt: 0.24, duration: 0.34, gain: 0.05 }) // C6 sparkle
}

/** Low double-buzz — failure / error. */
export function playError(): void {
  if (!isSoundEnabled()) return
  tone({ freq: 220, duration: 0.22, type: 'sawtooth', gain: 0.05 })
  tone({ freq: 174.6, startAt: 0.18, duration: 0.3, type: 'sawtooth', gain: 0.05 })
}

/** Soft single ping — peer connection established. */
export function playConnect(): void {
  if (!isSoundEnabled()) return
  tone({ freq: 659.25, duration: 0.15, gain: 0.05 })            // E5
  tone({ freq: 880, startAt: 0.08, duration: 0.18, gain: 0.04 }) // A5
}

/** Neutral tick — transfer paused / resumed. */
export function playPause(): void {
  if (!isSoundEnabled()) return
  tone({ freq: 440, glideTo: 330, duration: 0.2, type: 'triangle', gain: 0.06 })
}

export function playResume(): void {
  if (!isSoundEnabled()) return
  tone({ freq: 330, glideTo: 440, duration: 0.2, type: 'triangle', gain: 0.06 })
}
