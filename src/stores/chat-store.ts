// FluxDrop chat store: v1.3 (6.3) in-room text chat over the DataChannel.
//
// Chat is P2P only by design — the signaling server never sees a message.
// The store keeps the room's transcript (bounded), the unread counter for
// the collapsed floating panel, and the panel's open state (living here so
// the router can decide whether an incoming frame should bump `unread`
// without any component round-trip).

'use client'

import { create } from 'zustand'

export interface ChatMessage {
  id: string
  /** deviceId of the peer that sent it ('' legacy-safe) or of ourselves when `mine`. */
  fromDeviceId: string
  alias: string
  text: string
  at: number
  mine: boolean
  /** True when the frame travelled inside the PAKE-derived AES-256-GCM seal. */
  viaE2E: boolean
}

interface ChatStoreState {
  messages: ChatMessage[]
  /** Append one message; bumps `unread` for incoming messages while collapsed. */
  addMessage: (m: ChatMessage) => void
  clearMessages: () => void

  unread: number
  markRead: () => void

  open: boolean
  setOpen: (v: boolean) => void
  toggleOpen: () => void
}

// Transcript bound: chat is coordination chatter for a live transfer room,
// not a messaging app — keep the last 200 messages per room.
const MAX_MESSAGES = 200

export const useChatStore = create<ChatStoreState>((set) => ({
  messages: [],
  addMessage: (m) =>
    set((s) => ({
      messages: [...s.messages, m].slice(-MAX_MESSAGES),
      // Only incoming messages while the panel is COLLAPSED count as unread —
      // an open panel is read by definition.
      unread: !m.mine && !s.open ? s.unread + 1 : s.unread,
    })),
  clearMessages: () => set({ messages: [], unread: 0 }),

  unread: 0,
  markRead: () => set({ unread: 0 }),

  open: false,
  setOpen: (v) => set({ open: v }),
  // Opening the panel consumes the unread badge in the same transaction.
  toggleOpen: () => set((s) => ({ open: !s.open, unread: !s.open ? 0 : s.unread })),
}))
