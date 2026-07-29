// FluxDrop session store: device identity, signaling connection, room state, peers.

'use client'

import { create } from 'zustand'
import type { DeviceRole } from '@/lib/fluxdrop/protocol'
import { generateDeviceAlias } from '@/lib/fluxdrop/format'
import { getDevicePreferences, saveDevicePreferences, type DevicePreferences } from '@/lib/fluxdrop/resume'

export type SessionView = 'landing' | 'sender' | 'receiver'

export interface PeerDevice {
  id: string
  alias: string
  role: DeviceRole
}

interface SessionState {
  // Device identity
  deviceId: string
  alias: string
  setAlias: (alias: string) => void
  initDevice: () => Promise<void>

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

  // Reset everything
  resetSession: () => void
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
      return
    }
    const { id, alias } = loadOrCreateDevice()
    set({ deviceId: id, alias })
    await saveDevicePreferences({ deviceId: id, alias, createdAt: Date.now(), lastSeen: Date.now() })
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
    }),
}))
