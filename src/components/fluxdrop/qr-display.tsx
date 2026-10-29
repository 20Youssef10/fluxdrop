'use client'

import { useRef, useState } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { RefreshCw, Share2, KeyRound, Clock, Download, QrCode, Nfc } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useSessionStore } from '@/stores/session-store'
import { shortId } from '@/lib/fluxdrop/format'
import { toast } from 'sonner'
import { useEffect } from 'react'
import { CopyButton } from './copy-button'
import { isNfcSupported, writeNfcUrl } from '@/lib/fluxdrop/nfc'

export function QRDisplay() {
  const roomId = useSessionStore((s) => s.roomId)
  const joinCode = useSessionStore((s) => s.joinCode)
  const pin = useSessionStore((s) => s.pin)
  const qrData = useSessionStore((s) => s.qrData)
  const roomCreatedAt = useSessionStore((s) => s.roomCreatedAt)
  const [elapsed, setElapsed] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [nfcSupported, setNfcSupported] = useState(false)
  const qrWrapRef = useRef<HTMLDivElement>(null)

  // v4 (3.3): NFC capability is decided on the client (SSR has no NDEFReader).
  useEffect(() => {
    setNfcSupported(isNfcSupported())
  }, [])

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
  const expiryPct = Math.min(100, (elapsed / 300) * 100)

  const shareLink = roomId && pin
    ? `${window.location.origin}/#join=${roomId}&pin=${pin}`
    : ''
  const detailsText = roomId && pin
    ? `FluxDrop — Room: ${roomId} · PIN: ${pin}`
    : ''

  // Export the on-screen QR as a PNG file (rendered at 2x for crispness).
  const downloadQr = () => {
    const wrap = qrWrapRef.current
    const canvas = wrap?.querySelector('canvas')
    if (!canvas || !roomId) {
      toast.error('QR code is not ready yet')
      return
    }
    setExporting(true)
    try {
      // Compose onto a padded white canvas so the PNG frames nicely.
      const pad = 32
      const out = document.createElement('canvas')
      out.width = canvas.width + pad * 2
      out.height = canvas.height + pad * 2 + 28
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('canvas unavailable')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(canvas, pad, pad)
      // Small caption under the code.
      ctx.fillStyle = '#0a0f0d'
      ctx.font = '600 14px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(`FluxDrop · ${roomId}${pin ? ` · PIN ${pin}` : ''}`, out.width / 2, out.height - 10)

      const url = out.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = `fluxdrop-qr-${roomId}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast.success('QR code saved', { description: `fluxdrop-qr-${roomId}.png` })
    } catch {
      toast.error('Could not export the QR code', {
        description: 'Your browser blocked the canvas export. Try a screenshot instead.',
      })
    } finally {
      setTimeout(() => setExporting(false), 300)
    }
  }

  // Native share sheet where supported (mobile), clipboard fallback otherwise.
  const shareRoom = async () => {
    if (!shareLink) return
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({
          title: 'FluxDrop transfer',
          text: detailsText,
          url: shareLink,
        })
        return
      } catch (err) {
        // User dismissed the share sheet — not an error.
        if ((err as DOMException)?.name === 'AbortError') return
      }
    }
    try {
      await navigator.clipboard.writeText(`${detailsText}\n${shareLink}`)
      toast.success('Room details copied', { description: 'Paste them on the receiving device.' })
    } catch {
      toast.error('Sharing is not available in this browser')
    }
  }

  if (!roomId) return null

  return (
    <Card className="flux-hover-border flux-glass overflow-hidden">
      <div className="p-6 sm:p-8">
        <div className="flex flex-col items-center text-center">
          <Badge variant="outline" className={`mb-3 border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300 ${remainingSec <= 60 ? 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400' : ''}`}>
            <Clock className="mr-1.5 h-3 w-3" />
            {remainingSec <= 0 ? 'Expired — go back to refresh' : `Expires in ${mm}:${ss}`}
          </Badge>

          {/* Expiry progress bar — drains as the pairing window closes */}
          <div className="w-40 h-1 rounded-full bg-border/60 overflow-hidden mb-5" aria-hidden="true">
            <div
              className={`h-full rounded-full transition-all duration-1000 ease-linear ${remainingSec <= 60 ? 'bg-amber-500' : 'bg-flux-500'}`}
              style={{ width: `${100 - expiryPct}%` }}
            />
          </div>

          <h3 className="text-lg font-semibold">Scan to receive</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Open FluxDrop on the receiving device and scan this code
          </p>

          {/* QR code */}
          <div className="relative mt-6" ref={qrWrapRef}>
            <div className="absolute inset-0 -m-3 rounded-2xl bg-gradient-to-br from-flux-400/20 via-flux-500/10 to-flux-600/20 blur-xl" />
            <div className="relative rounded-2xl border-2 border-flux-500/30 bg-white p-4 shadow-xl">
              {qrData ? (
                <QRCodeCanvas
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
            />
            {pin && (
              <CodeRow
                label="PIN"
                value={pin}
                icon={<KeyRound className="h-3.5 w-3.5" />}
              />
            )}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 w-full">
            <CopyButton
              text={detailsText}
              label="Details"
              variant="outline"
              className="border-flux-500/40 hover:bg-flux-500/10"
            />
            <CopyButton
              text={shareLink}
              label="Link"
              variant="outline"
              className="border-flux-500/40 hover:bg-flux-500/10"
            />
            <Button
              variant="outline"
              onClick={shareRoom}
              className="border-flux-500/40 hover:bg-flux-500/10"
              title="Share the room link via your device's share sheet"
            >
              <Share2 className="mr-1.5 h-4 w-4" />
              Share
            </Button>
          </div>
          <Button
            variant="ghost"
            onClick={downloadQr}
            disabled={exporting || !qrData}
            className="mt-2 w-full text-muted-foreground hover:text-foreground text-xs"
            title="Save the QR code as a PNG image"
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Download QR as PNG'}
          </Button>

          {/* v4 (3.3): NFC tap-to-pair — Android Chrome writes the join URL
              as a URI record; other platforms never see the button. */}
          {nfcSupported && (
            <Button
              variant="ghost"
              onClick={async () => {
                const res = await writeNfcUrl(shareLink)
                if (res === 'written') toast.success('Written to the NFC tag', { description: 'Tap the receiving phone on the tag to open the join link.' })
                else if (res === 'cancelled') toast.info('NFC write cancelled', { description: 'Present the tag within 20 seconds and try again.' })
                else if (res !== 'unsupported') toast.error('NFC write failed', { description: String(res) })
              }}
              className="mt-1 w-full text-muted-foreground hover:text-foreground text-xs"
              title="Write the join link to an NFC tag (Android)"
            >
              <Nfc className="mr-1.5 h-3.5 w-3.5" />
              Write to NFC tag
            </Button>
          )}

          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <QrCode className="h-3.5 w-3.5" />
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
}: {
  label: string
  value: string
  hint?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-card/60 p-3 transition-colors hover:border-flux-500/30">
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <code className="font-mono text-base font-semibold tracking-wider">{value}</code>
        <CopyButton text={value} size="icon" variant="ghost" className="h-7 w-7" />
      </div>
    </div>
  )
}
