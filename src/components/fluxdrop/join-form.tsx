'use client'

import { useState } from 'react'
import { LogIn, ArrowLeft, KeyRound, Hash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { toast } from 'sonner'

interface JoinFormProps {
  onJoin: (roomId: string, pin: string) => void
  onBack: () => void
}

export function JoinForm({ onJoin, onBack }: JoinFormProps) {
  const [roomId, setRoomId] = useState('')
  const [pin, setPin] = useState('')

  const handleJoin = () => {
    const cleaned = roomId.trim().toUpperCase().replace(/\s/g, '')
    if (cleaned.length < 4) {
      toast.error('Enter a valid room ID')
      return
    }
    if (pin.length !== 6) {
      toast.error('PIN must be 6 digits')
      return
    }
    onJoin(cleaned, pin)
  }

  return (
    <Card className="flux-glass">
      <div className="p-6 sm:p-8">
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 -ml-2 text-muted-foreground">
          <ArrowLeft className="mr-1.5 h-4 w-4" />
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
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
              placeholder="e.g. AB3K7Q"
              className="font-mono text-lg tracking-widest uppercase h-12"
              maxLength={8}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              The 6-character code shown on the sender's screen
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
        </div>
      </div>
    </Card>
  )
}
