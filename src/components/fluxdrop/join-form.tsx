'use client'

import { useState, useEffect } from 'react'
import { LogIn, ArrowLeft, KeyRound, Hash, Clock, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { toast } from 'sonner'
import { getRecentRooms, clearRecentRooms, type RecentRoom } from '@/lib/fluxdrop/recent-rooms'

interface JoinFormProps {
  onJoin: (roomId: string, pin: string) => void
  onBack: () => void
}

export function JoinForm({ onJoin, onBack }: JoinFormProps) {
  const [roomId, setRoomId] = useState('')
  const [pin, setPin] = useState('')
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecentRooms(getRecentRooms())
  }, [])

  const handleJoin = () => {
    const cleaned = roomId.trim().replace(/\s/g, '')
    // v5-e17: `ROOM@peer` joins a FEDERATED room through the named peer
    // server (the signaling server parses + routes the suffix).
    const fedMatch = /^([A-Za-z0-9]{4,12})@([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/.exec(cleaned)
    const normalized = fedMatch
      ? `${fedMatch[1].toUpperCase()}@${fedMatch[2].toLowerCase()}`
      : cleaned.toUpperCase()
    if (normalized.length < 4) {
      toast.error('Enter a valid room ID')
      return
    }
    if (pin.length !== 6) {
      toast.error('PIN must be 6 digits')
      return
    }
    onJoin(normalized, pin)
  }

  return (
    <Card className="flux-glass">
      <div className="p-6 sm:p-8">
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 -ml-2 text-muted-foreground">
          <ArrowLeft className="flux-flip-rtl me-1.5 h-4 w-4" />
          Back
        </Button>

        <div className="flex items-center gap-3 mb-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-flux-500/15 text-flux-600 dark:text-flux-400">
            <LogIn className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Join a transfer</h3>
            <p className="text-sm text-muted-foreground">Enter the room ID and PIN from the sender</p>
          </div>
        </div>

        <div className="mt-6 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="room-id" className="flex items-center gap-1.5">
              <Hash className="h-3.5 w-3.5" />
              Room ID
            </Label>
            <Input
              id="room-id"
              value={roomId}
              onChange={(e) => {
                // v5-e17: keep the @peer federation suffix lowercase.
                const raw = e.target.value
                const at = raw.indexOf('@')
                setRoomId(at === -1 ? raw.toUpperCase() : raw.slice(0, at).toUpperCase() + raw.slice(at).toLowerCase())
              }}
              placeholder="e.g. AB3K7Q or AB3K7Q@berlin"
              className="font-mono text-lg tracking-widest uppercase h-12 focus-visible:ring-flux-500/40 focus-visible:border-flux-500/50"
              maxLength={40}
              autoComplete="off"
              autoFocus
              inputMode="text"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              The 6-character code shown on the sender's screen — append @peer for a federated room
            </p>
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" />
              6-digit PIN
            </Label>
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={pin}
                onChange={(v) => setPin(v)}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              PIN authenticates your pairing request
            </p>
          </div>

          <Button
            onClick={handleJoin}
            disabled={roomId.trim().length < 4 || pin.length !== 6}
            className="w-full h-12 text-base bg-flux-600 hover:bg-flux-700 text-white shadow-lg shadow-flux-600/25"
          >
            <LogIn className="mr-2 h-5 w-5" />
            Join room
          </Button>

          {/* Recent rooms */}
          {recentRooms.length > 0 && (
            <div className="pt-4 border-t border-border/50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Recent rooms
                </span>
                <button
                  onClick={() => { clearRecentRooms(); setRecentRooms([]) }}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                >
                  Clear
                </button>
              </div>
              <div className="space-y-1.5">
                {recentRooms.map((room) => (
                  <button
                    key={room.roomId}
                    onClick={() => setRoomId(room.roomId)}
                    className="flex w-full items-center justify-between rounded-lg border border-border/40 bg-card/40 px-3 py-2 text-left hover:border-flux-500/30 hover:bg-flux-500/5 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-sm font-semibold tracking-wider">{room.roomId}</code>
                      <span className="text-xs text-muted-foreground">{room.peerAlias}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelative(room.joinedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}
