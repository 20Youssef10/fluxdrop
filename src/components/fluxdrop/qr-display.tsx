'use client'

import { QRCodeSVG } from 'qrcode.react'
import { Copy, RefreshCw, Share2, KeyRound, Clock, Link2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useSessionStore } from '@/stores/session-store'
import { copyToClipboard, shortId } from '@/lib/fluxdrop/format'
import { toast } from 'sonner'
import { useEffect, useState } from 'react'

export function QRDisplay() {
  const roomId = useSessionStore((s) => s.roomId)
  const joinCode = useSessionStore((s) => s.joinCode)
  const pin = useSessionStore((s) => s.pin)
  const qrData = useSessionStore((s) => s.qrData)
  const roomCreatedAt = useSessionStore((s) => s.roomCreatedAt)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!roomCreatedAt) return
    const tick = () => setElapsed(Math.floor((Date.now() - roomCreatedAt) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [roomCreatedAt])

  const remainingSec = Math.max(0, 300 - elapsed)
  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0')
  const ss = String(remainingSec % 60).padStart(2, '0')

  const copyRoom = async () => {
    if (!roomId) return
    const ok = await copyToClipboard(roomId)
    toast[ok ? 'success' : 'error'](ok ? 'Room ID copied' : 'Copy failed')
  }
  const copyPin = async () => {
    if (!pin) return
    const ok = await copyToClipboard(pin)
    toast[ok ? 'success' : 'error'](ok ? 'PIN copied' : 'Copy failed')
  }
  const copyAll = async () => {
    if (!roomId || !pin) return
    const text = `FluxDrop — Room: ${roomId} · PIN: ${pin}`
    const ok = await copyToClipboard(text)
    toast[ok ? 'success' : 'error'](ok ? 'Transfer details copied' : 'Copy failed')
  }
  const copyLink = async () => {
    if (!roomId || !pin) return
    const url = `${window.location.origin}/#join=${roomId}&pin=${pin}`
    const ok = await copyToClipboard(url)
    toast[ok ? 'success' : 'error'](ok ? 'Share link copied' : 'Copy failed')
  }

  if (!roomId) return null

  return (
    <Card className="flux-glass overflow-hidden">
      <div className="p-6 sm:p-8">
        <div className="flex flex-col items-center text-center">
          <Badge variant="outline" className="mb-4 border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300">
            <Clock className="mr-1.5 h-3 w-3" />
            Expires in {mm}:{ss}
          </Badge>

          <h3 className="text-lg font-semibold">Scan to receive</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Open FluxDrop on the receiving device and scan this code
          </p>

          {/* QR code */}
          <div className="relative mt-6">
            <div className="absolute inset-0 -m-3 rounded-2xl bg-gradient-to-br from-flux-400/20 via-flux-500/10 to-flux-600/20 blur-xl" />
            <div className="relative rounded-2xl border-2 border-flux-500/30 bg-white p-4 shadow-xl">
              {qrData ? (
                <QRCodeSVG
                  value={qrData}
                  size={208}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#0a0f0d"
                  marginSize={0}
                />
              ) : (
                <div className="h-[208px] w-[208px] flex items-center justify-center text-muted-foreground">
                  <RefreshCw className="h-6 w-6 animate-spin" />
                </div>
              )}
            </div>
          </div>

          <Separator className="my-6" />

          {/* Manual codes */}
          <div className="w-full space-y-3">
            <CodeRow
              label="Room ID"
              value={roomId}
              hint={shortId(roomId, 6)}
              onCopy={copyRoom}
            />
            {pin && (
              <CodeRow
                label="PIN"
                value={pin}
                icon={<KeyRound className="h-3.5 w-3.5" />}
                onCopy={copyPin}
              />
            )}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 w-full">
            <Button
              variant="outline"
              onClick={copyAll}
              className="border-flux-500/40 hover:bg-flux-500/10"
            >
              <Share2 className="mr-1.5 h-3.5 w-3.5" />
              Copy details
            </Button>
            <Button
              variant="outline"
              onClick={copyLink}
              className="border-flux-500/40 hover:bg-flux-500/10"
            >
              <Link2 className="mr-1.5 h-3.5 w-3.5" />
              Copy link
            </Button>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Waiting for a receiver to join…
          </p>
        </div>
      </div>
    </Card>
  )
}

function CodeRow({
  label,
  value,
  hint,
  icon,
  onCopy,
}: {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
  onCopy: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/60 p-3">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <code className="font-mono text-base font-semibold tracking-wider">{value}</code>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCopy}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
