'use client'

/**
 * Manages recently-joined room IDs in localStorage.
 * Used by the receiver panel for quick-join suggestions.
 */

const STORAGE_KEY = 'fluxdrop:recent-rooms'
const MAX_ROOMS = 5

export interface RecentRoom {
  roomId: string
  peerAlias: string
  joinedAt: number
}

export function getRecentRooms(): RecentRoom[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RecentRoom[]
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, MAX_ROOMS)
  } catch {
    return []
  }
}

export function addRecentRoom(room: RecentRoom): void {
  if (typeof window === 'undefined') return
  try {
    const existing = getRecentRooms()
    // Remove duplicates (same roomId)
    const filtered = existing.filter((r) => r.roomId !== room.roomId)
    // Add to front
    filtered.unshift(room)
    // Trim to max
    const trimmed = filtered.slice(0, MAX_ROOMS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch { /* ignore */ }
}

export function clearRecentRooms(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}
