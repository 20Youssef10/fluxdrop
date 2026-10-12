// FluxDrop session store: device identity, signaling connection, room state, peers.

'use client'

import { create } from 'zustand'
import type { DeviceRole, TransferManifest } from '@/lib/fluxdrop/protocol'
import { generateDeviceAlias } from '@/lib/fluxdrop/format'
import { getDevicePreferences, saveDevicePreferences, type DevicePreferences } from '@/lib/fluxdrop/resume'

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
  setAlias: (alias: string) => void
  initDevice: () => Promise<void>

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
  }
  bytesSent: number
  bytesReceived: number
}

const STORAGE_KEY = 'fluxdrop:device'

function loadOrCreateDevice(): { id: string; alias: string } {
  if (typeof window === 'undefined') return { id: '', alias: '' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.id && parsed.alias) return parsed
    }
  } catch { /* ignore */ }
  const id = crypto.randomUUID()
  const alias = generateDeviceAlias()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, alias }))
  } catch { /* ignore */ }
  return { id, alias }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  deviceId: '',
  alias: '',
  setAlias: (alias) => {
    set({ alias })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: get().deviceId, alias }))
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
      set({ deviceId: stored.deviceId, alias: stored.alias })
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: stored.deviceId, alias: stored.alias }))
      } catch { /* ignore */ }
    } else {
      const { id, alias } = loadOrCreateDevice()
      set({ deviceId: id, alias })
      await saveDevicePreferences({ deviceId: id, alias, createdAt: Date.now(), lastSeen: Date.now() })
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
    } catch { /* ignore */ }
  },

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
    }),
}))
