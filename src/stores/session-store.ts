// FluxDrop session store: device identity, signaling connection, room state, peers.

'use client'

import { create } from 'zustand'
import type { DeviceRole, TransferManifest } from '@/lib/fluxdrop/protocol'
import { generateDeviceAlias } from '@/lib/fluxdrop/format'
import { randomUUID } from '@/lib/fluxdrop/random'
import { getDevicePreferences, saveDevicePreferences, type DevicePreferences } from '@/lib/fluxdrop/resume'
import type { E2EStatus } from '@/lib/fluxdrop/e2e'

export type SessionView = 'landing' | 'sender' | 'receiver'

export interface PeerDevice {
  id: string
  alias: string
  role: DeviceRole
}

export interface IceServerConfig {
  urls: string
  username?: string
  credential?: string
}

interface SessionState {
  // Device identity
  deviceId: string
  alias: string
  setAlias: (alias: string, opts?: { custom?: boolean }) => void
  initDevice: () => Promise<void>

  // v1.2: true end-to-end payload encryption (SPAKE2 PAKE over the room PIN).
  e2eEnabled: boolean
  setE2EEnabled: (v: boolean) => void
  e2eStatus: E2EStatus
  setE2EStatus: (s: E2EStatus) => void
  e2eSas: string | null
  setE2ESas: (sas: string | null) => void

  // ICE server config (TURN/STUN)
  customIceServers: IceServerConfig[]
  useCustomIce: boolean
  setCustomIceServers: (servers: IceServerConfig[]) => void
  setUseCustomIce: (v: boolean) => void

  // Alert preferences (sound + desktop notifications)
  soundEnabled: boolean
  notificationsEnabled: boolean
  setSoundEnabled: (v: boolean) => void
  setNotificationsEnabled: (v: boolean) => void

  // Auto-accept incoming transfers from trusted devices (opt-in)
  autoAcceptTrusted: boolean
  setAutoAcceptTrusted: (v: boolean) => void

  // Auto-accept RE-SENDS of transfers we already started receiving from the
  // SAME device (resume flow — skips the consent dialog on the receiver).
  // Safety anchors: known transferId + matching peerDeviceId + partial progress.
  autoAcceptResume: boolean
  setAutoAcceptResume: (v: boolean) => void

  // v1.1: wire compression (per-chunk gzip) for compressible transfers.
  compressionEnabled: boolean
  setCompressionEnabled: (v: boolean) => void

  // v1.1: allow auto-minted TURN relay credentials as an ICE fallback.
  useTurnRelay: boolean
  setUseTurnRelay: (v: boolean) => void

  // v1.2 (2.3): paranoid mode — at-rest encryption + wipe the received-chunk
  // cache the moment this tab closes. Persisted to 'fluxdrop:paranoid-mode'
  // (secure-store reads the same flag directly to arm the wipe listeners).
  paranoidMode: boolean
  setParanoidMode: (v: boolean) => void

  // v1.3 (4.1): Files vault — keep verified received transfers on this device
  // (OPFS + IndexedDB). vaultBudgetMb: 512/2048/8192, 0 = unlimited.
  // vaultBudgetMb is persisted to 'fluxdrop:vault-budget-mb' and mirrored in
  // bytes at 'fluxdrop:vault-budget-bytes' (vault.ts's budget reader accepts
  // both so the module works standalone).
  vaultEnabled: boolean
  setVaultEnabled: (v: boolean) => void
  vaultBudgetMb: number
  setVaultBudgetMb: (mb: number) => void

  // View / mode
  view: SessionView
  setView: (view: SessionView) => void

  // Signaling connection
  signalingConnected: boolean
  setSignalingConnected: (connected: boolean) => void

  // Room
  roomId: string | null
  joinCode: string | null
  pin: string | null
  qrData: string | null
  roomCreatedAt: number | null
  setRoom: (room: { id: string; joinCode: string; pin?: string | null; qrData?: string | null }) => void
  clearRoom: () => void

  // Peers
  peers: PeerDevice[]
  addPeer: (peer: PeerDevice) => void
  removePeer: (deviceId: string) => void
  clearPeers: () => void

  // Pairing
  pairingInProgress: boolean
  setPairingInProgress: (v: boolean) => void
  pairingAccepted: boolean | null
  setPairingAccepted: (v: boolean | null) => void

  // WebRTC connection state
  rtcState: string
  setRtcState: (s: string) => void
  dataChannelOpen: boolean
  setDataChannelOpen: (v: boolean) => void

  // Pending manifest for receiver consent (set before user accepts)
  pendingManifest: TransferManifest | null
  setPendingManifest: (m: TransferManifest | null) => void

  // WebRTC diagnostics
  iceGatheringState: string
  setIceGatheringState: (s: string) => void
  iceConnectionState: string
  setIceConnectionState: (s: string) => void
  diagnostics: WebRtcDiagnostics | null
  setDiagnostics: (d: WebRtcDiagnostics | null) => void

  // Retry tracking
  retryCount: number
  setRetryCount: (n: number) => void

  // Reset everything
  resetSession: () => void
}

const ICE_STORAGE_KEY = 'fluxdrop:ice-servers'

export interface WebRtcDiagnostics {
  selectedPair?: {
    localCandidateType?: string
    localAddress?: string
    localPort?: number
    remoteCandidateType?: string
    remoteAddress?: string
    remotePort?: number
    protocol?: string
    currentRoundTripTime?: number
    nominated?: boolean
    bytesSent?: number
    bytesReceived?: number
    requestsSent?: number
    requestsReceived?: number
  }
  bytesSent: number
  bytesReceived: number
}

const STORAGE_KEY = 'fluxdrop:device'
// v1.2 (2.4): marks that the USER chose their alias. Until then the alias is
// ephemeral and rotates per browser session (FEATURES.md alias rotation).
const ALIAS_CUSTOM_KEY = 'fluxdrop:alias-custom'
// Session-scoped rotated alias — fresh value per tab session, stable within it.
const SESSION_ALIAS_KEY = 'fluxdrop:session-alias'

function loadOrCreateDevice(): { id: string; alias: string } {
  if (typeof window === 'undefined') return { id: '', alias: '' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.id && parsed.alias) return parsed
    }
  } catch { /* ignore */ }
  const id = randomUUID()
  const alias = generateDeviceAlias()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, alias }))
  } catch { /* ignore */ }
  return { id, alias }
}

/**
 * v1.2 alias rotation: unless the user set a custom alias, pick a FRESH alias
 * for this browser session (sessionStorage — survives reloads within the tab,
 * rotates when the tab closes). Prevents long-term device correlation across
 * rooms via a persistent pet name. deviceId stays stable by design: trusted
 * peers and resume records key off it, not the alias.
 */
function resolveAlias(preferred: string): string {
  if (typeof window === 'undefined') return preferred
  try {
    if (localStorage.getItem(ALIAS_CUSTOM_KEY) === 'true') return preferred
    let rotated = sessionStorage.getItem(SESSION_ALIAS_KEY)
    if (!rotated) {
      rotated = generateDeviceAlias()
      sessionStorage.setItem(SESSION_ALIAS_KEY, rotated)
    }
    return rotated
  } catch {
    return preferred
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  deviceId: '',
  alias: '',
  setAlias: (alias, opts) => {
    const custom = opts?.custom !== false
    set({ alias })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: get().deviceId, alias }))
        // Only an explicit user choice pins the alias — programmatic fallbacks
        // must keep the ephemeral rotation behavior intact.
        if (custom) {
          localStorage.setItem(ALIAS_CUSTOM_KEY, 'true')
          sessionStorage.setItem(SESSION_ALIAS_KEY, alias)
        }
      } catch { /* ignore */ }
    }
    const prefs: DevicePreferences = {
      deviceId: get().deviceId,
      alias,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    }
    void saveDevicePreferences(prefs)
  },
  initDevice: async () => {
    if (typeof window === 'undefined') return
    // Prefer IndexedDB-stored prefs, fall back to localStorage
    const stored = await getDevicePreferences()
    if (stored?.deviceId && stored?.alias) {
      const rotated = resolveAlias(stored.alias)
      set({ deviceId: stored.deviceId, alias: rotated })
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: stored.deviceId, alias: rotated }))
      } catch { /* ignore */ }
    } else {
      const { id, alias } = loadOrCreateDevice()
      const rotated = resolveAlias(alias)
      set({ deviceId: id, alias: rotated })
      await saveDevicePreferences({ deviceId: id, alias: rotated, createdAt: Date.now(), lastSeen: Date.now() })
    }
    // Load ICE server config from localStorage
    try {
      const iceRaw = localStorage.getItem(ICE_STORAGE_KEY)
      if (iceRaw) {
        const parsed = JSON.parse(iceRaw) as IceServerConfig[]
        if (Array.isArray(parsed)) set({ customIceServers: parsed })
      }
      const useIceRaw = localStorage.getItem('fluxdrop:use-custom-ice')
      if (useIceRaw) {
        set({ useCustomIce: JSON.parse(useIceRaw) === true })
      }
      const soundRaw = localStorage.getItem('fluxdrop:sound-enabled')
      if (soundRaw !== null) set({ soundEnabled: soundRaw === 'true' })
      const notifRaw = localStorage.getItem('fluxdrop:notifications-enabled')
      if (notifRaw !== null) set({ notificationsEnabled: notifRaw === 'true' })
      const autoRaw = localStorage.getItem('fluxdrop:auto-accept-trusted')
      if (autoRaw !== null) set({ autoAcceptTrusted: autoRaw === 'true' })
      const autoResumeRaw = localStorage.getItem('fluxdrop:auto-accept-resume')
      if (autoResumeRaw !== null) set({ autoAcceptResume: autoResumeRaw === 'true' })
      const compressRaw = localStorage.getItem('fluxdrop:compression-enabled')
      if (compressRaw !== null) set({ compressionEnabled: compressRaw === 'true' })
      const turnRaw = localStorage.getItem('fluxdrop:use-turn-relay')
      if (turnRaw !== null) set({ useTurnRelay: turnRaw === 'true' })
      // v1.2 (2.3): paranoid mode defaults OFF (privacy hardening is opt-in).
      const paranoidRaw = localStorage.getItem('fluxdrop:paranoid-mode')
      if (paranoidRaw !== null) set({ paranoidMode: paranoidRaw === 'true' })
      // v1.2: E2E payload encryption defaults ON (PAKE over the room PIN).
      const e2eRaw = localStorage.getItem('fluxdrop:e2e-enabled')
      if (e2eRaw !== null) set({ e2eEnabled: e2eRaw === 'true' })
      // v1.3 (4.1): Files vault — default ON, budget default 2048 MB.
      const vaultRaw = localStorage.getItem('fluxdrop:vault-enabled')
      if (vaultRaw !== null) set({ vaultEnabled: vaultRaw === 'true' })
      const vaultBudgetRaw = localStorage.getItem('fluxdrop:vault-budget-mb')
      if (vaultBudgetRaw !== null) {
        const n = Number(vaultBudgetRaw)
        if (Number.isFinite(n) && n >= 0) set({ vaultBudgetMb: Math.floor(n) })
      }
    } catch { /* ignore */ }
  },

  // v1.2: E2E payload encryption — defaults ON. Paired peers without v1.2
  // support downgrade VISIBLY (toast + badge), never silently.
  e2eEnabled: true,
  setE2EEnabled: (v) => {
    set({ e2eEnabled: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:e2e-enabled', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },
  e2eStatus: 'idle' as E2EStatus,
  setE2EStatus: (s) => set({ e2eStatus: s }),
  e2eSas: null,
  setE2ESas: (sas) => set({ e2eSas: sas }),

  view: 'landing',
  setView: (view) => set({ view }),

  signalingConnected: false,
  setSignalingConnected: (connected) => set({ signalingConnected: connected }),

  roomId: null,
  joinCode: null,
  pin: null,
  qrData: null,
  roomCreatedAt: null,
  setRoom: (room) =>
    set({
      roomId: room.id,
      joinCode: room.joinCode,
      pin: room.pin ?? null,
      qrData: room.qrData ?? null,
      roomCreatedAt: Date.now(),
      peers: [],
    }),
  clearRoom: () =>
    set({
      roomId: null,
      joinCode: null,
      pin: null,
      qrData: null,
      roomCreatedAt: null,
      peers: [],
      pairingInProgress: false,
      pairingAccepted: null,
    }),

  peers: [],
  addPeer: (peer) =>
    set((s) => {
      if (s.peers.find((p) => p.id === peer.id)) return s
      return { peers: [...s.peers, peer] }
    }),
  removePeer: (deviceId) => set((s) => ({ peers: s.peers.filter((p) => p.id !== deviceId) })),
  clearPeers: () => set({ peers: [] }),

  pairingInProgress: false,
  setPairingInProgress: (v) => set({ pairingInProgress: v }),
  pairingAccepted: null,
  setPairingAccepted: (v) => set({ pairingAccepted: v }),

  rtcState: 'new',
  setRtcState: (s) => set({ rtcState: s }),
  dataChannelOpen: false,
  setDataChannelOpen: (v) => set({ dataChannelOpen: v }),

  pendingManifest: null,
  setPendingManifest: (m) => set({ pendingManifest: m }),

  iceGatheringState: 'new',
  setIceGatheringState: (s) => set({ iceGatheringState: s }),
  iceConnectionState: 'new',
  setIceConnectionState: (s) => set({ iceConnectionState: s }),
  diagnostics: null,
  setDiagnostics: (d) => set({ diagnostics: d }),

  retryCount: 0,
  setRetryCount: (n) => set({ retryCount: n }),

  customIceServers: [],
  useCustomIce: false,
  setCustomIceServers: (servers) => {
    set({ customIceServers: servers })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(ICE_STORAGE_KEY, JSON.stringify(servers))
      } catch { /* ignore */ }
    }
  },
  setUseCustomIce: (v) => {
    set({ useCustomIce: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:use-custom-ice', JSON.stringify(v))
      } catch { /* ignore */ }
    }
  },

  soundEnabled: true,
  notificationsEnabled: true,
  setSoundEnabled: (v) => {
    set({ soundEnabled: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:sound-enabled', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },
  setNotificationsEnabled: (v) => {
    set({ notificationsEnabled: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:notifications-enabled', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },

  autoAcceptTrusted: false,
  setAutoAcceptTrusted: (v) => {
    set({ autoAcceptTrusted: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:auto-accept-trusted', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },

  // Default ON: a resume re-send is scoped to a transferId we already
  // accepted from this exact peer — no new content can sneak in.
  autoAcceptResume: true,
  setAutoAcceptResume: (v) => {
    set({ autoAcceptResume: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:auto-accept-resume', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },

  // v1.1: compression defaults ON (native streams API, compressible types only).
  compressionEnabled: true,
  setCompressionEnabled: (v) => {
    set({ compressionEnabled: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:compression-enabled', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },

  // v1.1: TURN fallback defaults ON — ICE still prefers direct paths; the
  // relay only kicks in when no direct pair can be formed. If the signaling
  // server has no TURN configured the client silently stays STUN-only.
  useTurnRelay: true,
  setUseTurnRelay: (v) => {
    set({ useTurnRelay: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:use-turn-relay', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },

  // v1.2 (2.3): paranoid mode defaults OFF. The actual wipe listeners live in
  // secure-store (armed on module load, reading this same localStorage flag).
  paranoidMode: false,
  setParanoidMode: (v) => {
    set({ paranoidMode: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:paranoid-mode', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },

  // v1.3 (4.1): Files vault defaults ON (verified transfers are kept on
  // device; the budget below caps how much disk they may use).
  vaultEnabled: true,
  setVaultEnabled: (v) => {
    set({ vaultEnabled: v })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:vault-enabled', v ? 'true' : 'false')
      } catch { /* ignore */ }
    }
  },
  vaultBudgetMb: 2048,
  setVaultBudgetMb: (mb) => {
    set({ vaultBudgetMb: mb })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fluxdrop:vault-budget-mb', String(mb))
        // Mirror in bytes — vault.ts's enforceVaultBudget reads this key.
        localStorage.setItem('fluxdrop:vault-budget-bytes', String(mb * 1024 * 1024))
      } catch { /* ignore */ }
    }
  },

  resetSession: () =>
    set({
      view: 'landing',
      roomId: null,
      joinCode: null,
      pin: null,
      qrData: null,
      roomCreatedAt: null,
      peers: [],
      pairingInProgress: false,
      pairingAccepted: null,
      rtcState: 'new',
      dataChannelOpen: false,
      iceGatheringState: 'new',
      iceConnectionState: 'new',
      diagnostics: null,
      retryCount: 0,
      e2eStatus: 'idle',
      e2eSas: null,
    }),
}))
