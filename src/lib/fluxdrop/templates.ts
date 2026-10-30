// v5-c8 (FEATURES-v5.md C8): transfer templates — one-tap presets that
// combine the transfer-affecting prefs (and the sound pack) into named
// scenarios. Pure data + appliers: no new engine state, everything routes
// through the existing prefs store so "applies to the NEXT transfer" keeps
// its existing semantics (prefs are read at manifest/send time).
//
// Design notes:
// - A template NEVER touches identity/trust state (trusted peers, duress
//   PIN, paranoid mode) — those are safety knobs, not per-send flavors.
// - `appliedLabel` lists what actually changed so the toast is honest when
//   a pref was already at the target value.

'use client'

import { usePrefsStore } from './prefs'
import { useSessionStore } from '@/stores/session-store'

export type TemplateIcon = 'zap' | 'image' | 'moon' | 'timer' | 'shield'

export interface TransferTemplate {
  id: string
  label: string
  description: string
  icon: TemplateIcon
  /** Pref targets applied on tap (sound pack included — "quiet" means quiet). */
  prefs: {
    compressionEnabled?: boolean
    deltaSync?: boolean
    fastLanes?: number
    qosCapMbps?: number
    disappearTtlMinutes?: number
    relayFallback?: boolean
    merkleEnabled?: boolean
    soundPack?: 'calm' | 'lively' | 'silent'
  }
}

export const TEMPLATES: TransferTemplate[] = [
  {
    id: 'quick',
    label: 'Quick drop',
    description: 'Balanced defaults for everyday sends.',
    icon: 'zap',
    prefs: {
      compressionEnabled: true,
      deltaSync: true,
      fastLanes: 1,
      qosCapMbps: 0,
      disappearTtlMinutes: 0,
      relayFallback: true,
      merkleEnabled: true,
    },
  },
  {
    id: 'photos',
    label: 'Photo burst',
    description: 'Max lanes, no gzip (JPEGs are already compressed).',
    icon: 'image',
    prefs: {
      compressionEnabled: false,
      deltaSync: false,
      fastLanes: 4,
      qosCapMbps: 0,
    },
  },
  {
    id: 'quiet',
    label: 'Quiet hours',
    description: 'Capped at 25 Mbit/s, silent sounds — polite late-night sends.',
    icon: 'moon',
    prefs: {
      qosCapMbps: 25,
      soundPack: 'silent',
    },
  },
  {
    id: 'ephemeral',
    label: 'Ephemeral',
    description: 'Disappears from the receiver\'s vault after 10 minutes.',
    icon: 'timer',
    prefs: {
      disappearTtlMinutes: 10,
      deltaSync: true,
    },
  },
  {
    id: 'careful',
    label: 'Careful',
    description: 'Every integrity and fallback layer on.',
    icon: 'shield',
    prefs: {
      compressionEnabled: true,
      merkleEnabled: true,
      relayFallback: true,
      deltaSync: true,
    },
  },
]

/** Apply a template's prefs. Returns the human labels of what changed. */
export function applyTemplate(tpl: TransferTemplate): string[] {
  const s = usePrefsStore.getState()
  // compressionEnabled lives on the SESSION store (v1.1 wire-compression
  // toggle) — everything else is a pref.
  const sess = useSessionStore.getState()
  const changed: string[] = []
  const p = tpl.prefs
  if (p.compressionEnabled !== undefined && sess.compressionEnabled !== p.compressionEnabled) {
    sess.setCompressionEnabled(p.compressionEnabled)
    changed.push(p.compressionEnabled ? 'gzip on' : 'gzip off')
  }
  if (p.deltaSync !== undefined && s.deltaSync !== p.deltaSync) {
    s.setDeltaSync(p.deltaSync)
    changed.push(p.deltaSync ? 'delta sync on' : 'delta sync off')
  }
  if (p.fastLanes !== undefined && s.fastLanes !== p.fastLanes) {
    s.setFastLanes(p.fastLanes)
    changed.push(p.fastLanes > 1 ? `${p.fastLanes}× lanes` : 'lanes off')
  }
  if (p.qosCapMbps !== undefined && s.qosCapMbps !== p.qosCapMbps) {
    s.setQosCapMbps(p.qosCapMbps)
    changed.push(p.qosCapMbps > 0 ? `cap ${p.qosCapMbps} Mbit/s` : 'uncapped')
  }
  if (p.disappearTtlMinutes !== undefined && s.disappearTtlMinutes !== p.disappearTtlMinutes) {
    s.setDisappearTtlMinutes(p.disappearTtlMinutes)
    changed.push(
      p.disappearTtlMinutes > 0 ? `TTL ${p.disappearTtlMinutes} min` : 'no TTL'
    )
  }
  if (p.relayFallback !== undefined && s.relayFallback !== p.relayFallback) {
    s.setRelayFallback(p.relayFallback)
    changed.push(p.relayFallback ? 'relay fallback on' : 'relay fallback off')
  }
  if (p.merkleEnabled !== undefined && s.merkleEnabled !== p.merkleEnabled) {
    s.setMerkleEnabled(p.merkleEnabled)
    changed.push(p.merkleEnabled ? 'Merkle on' : 'Merkle off')
  }
  if (p.soundPack !== undefined && s.soundPack !== p.soundPack) {
    s.setSoundPack(p.soundPack)
    changed.push(p.soundPack === 'silent' ? 'sounds off' : `sounds ${p.soundPack}`)
  }
  return changed
}
