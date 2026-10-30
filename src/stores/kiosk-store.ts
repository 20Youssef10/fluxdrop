// v5-c7 (FEATURES-v5.md C7): kiosk / broadcast receive station.
//
// A fullscreen receive overlay for classrooms / events / TVs: it mints
// pre-created share-link rooms (POST /link — the sender CLAIMS the room via
// the normal deep-link), shows a huge QR, auto-accepts incoming transfers
// (from everyone, or trusted devices only — the whitelist), saves straight
// to the Files vault (no pickers on a TV!), and renders a progress wall of
// everything received this kiosk session. After each transfer it rotates to
// a FRESH room so the next person can claim it (one claim per link room by
// design — rotation is what makes the station multi-sender).

'use client'

import { create } from 'zustand'

export type KioskAcceptMode = 'trusted' | 'all'

export interface KioskWallEntry {
  id: string
  name: string
  fileCount: number
  totalSize: number
  at: number
  status: 'complete' | 'failed'
}

export interface KioskSession {
  roomCode: string
  pin: string
  url: string
  expiresAt: number
}

interface KioskState {
  /** Overlay visible (the station is running). */
  active: boolean
  /** Who may auto-send to this station without a consent dialog. */
  acceptMode: KioskAcceptMode
  /** The currently advertised (minted + joined) room. */
  session: KioskSession | null
  /** Minting in flight (QR placeholder shown). */
  minting: boolean
  /** Everything received this kiosk run — the progress wall's history. */
  wall: KioskWallEntry[]
  /** Sum of the wall's completed bytes (quick stat chip). */
  totalReceived: number

  open: (mode?: KioskAcceptMode) => void
  close: () => void
  setAcceptMode: (m: KioskAcceptMode) => void
  setSession: (s: KioskSession | null) => void
  setMinting: (v: boolean) => void
  pushWall: (e: KioskWallEntry) => void
  reset: () => void
}

export const useKioskStore = create<KioskState>((set) => ({
  active: false,
  acceptMode: 'trusted',
  session: null,
  minting: false,
  wall: [],
  totalReceived: 0,

  open: (mode) =>
    set((s) => ({ active: true, ...(mode ? { acceptMode: mode } : {}) })),
  close: () => set({ active: false, session: null, minting: false }),
  setAcceptMode: (acceptMode) => set({ acceptMode }),
  setSession: (session) => set({ session }),
  setMinting: (minting) => set({ minting }),
  pushWall: (e) =>
    set((s) => ({
      wall: [e, ...s.wall].slice(0, 50),
      totalReceived: e.status === 'complete' ? s.totalReceived + e.totalSize : s.totalReceived,
    })),
  reset: () => set({ session: null, minting: false, wall: [], totalReceived: 0 }),
}))
