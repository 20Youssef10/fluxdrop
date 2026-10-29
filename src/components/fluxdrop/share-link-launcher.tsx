'use client'

// v4 (3.4): expiring share links — pre-create the room server-side (selectable
// TTL + one-join), then send a ready-made #join deep link instead of reading
// codes aloud. The link creator CLAIMS the room through create-room and the
// normal transfer flow continues unchanged (same QR, same PIN handshake).

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Link2, Loader2, Timer, Unlock } from 'lucide-react'
import { createShareLink, type ShareLink } from '@/lib/fluxdrop/share-link'
import { toast } from 'sonner'
import { useT } from '@/lib/fluxdrop/i18n'

interface ShareLinkLauncherProps {
  /** Files to send once the link room is claimed. */
  files: File[]
  /** Same entry point as "Send now" — receives the claim for create-room. */
  onStartSend: (files: File[], resumeManifest: undefined, claim: { roomCode: string; pin: string }) => void
  disabled?: boolean
}

const TTL_OPTIONS: Array<{ value: 5 | 60 | 1440; label: string }> = [
  { value: 5, label: '5 minutes' },
  { value: 60, label: '1 hour' },
  { value: 1440, label: '24 hours' },
]

export function ShareLinkLauncher({ files, onStartSend, disabled }: ShareLinkLauncherProps) {
  const [open, setOpen] = useState(false)
  const [ttl, setTtl] = useState<5 | 60 | 1440>(60)
  const [oneJoin, setOneJoin] = useState(false)
  const [creating, setCreating] = useState(false)
  const t = useT()

  const create = async () => {
    if (files.length === 0) return
    setCreating(true)
    try {
      const link: ShareLink = await createShareLink({ ttlMinutes: ttl, oneJoin })
      // Copy for instant sharing…
      try {
        await navigator.clipboard.writeText(link.url)
        toast.success(t('link.created', 'Share link ready'), {
          description: 'Copied to clipboard · send it to the receiving device.',
        })
      } catch {
        toast.success(t('link.created', 'Share link ready'), {
          description: link.url,
        })
      }
      // …then claim the room and start the normal send flow.
      onStartSend(files, undefined, { roomCode: link.roomCode, pin: link.pin })
      setOpen(false)
    } catch (err: any) {
      toast.error('Could not create the link', { description: err?.message ?? 'The signaling server refused.' })
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        disabled={disabled || files.length === 0}
        onClick={() => setOpen(true)}
        aria-label={t('sender.shareLink', 'Create expiring link')}
      >
        <Link2 className="h-3.5 w-3.5" aria-hidden />
        {t('sender.shareLink', 'Create expiring link')}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-flux-600 dark:text-flux-400" aria-hidden />
              {t('link.title', 'Expiring share link')}
            </DialogTitle>
            <DialogDescription>{t('link.desc', 'Pre-create the room server-side and send a link instead of reading codes aloud.')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('link.ttl', 'Link expires after')}</Label>
              <RadioGroup
                value={String(ttl)}
                onValueChange={(v) => setTtl(Number(v) as 5 | 60 | 1440)}
                className="grid grid-cols-3 gap-2"
              >
                {TTL_OPTIONS.map((o) => (
                  <Label
                    key={o.value}
                    htmlFor={`ttl-${o.value}`}
                    className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs transition-colors ${
                      ttl === o.value
                        ? 'border-flux-500/60 bg-flux-500/10 font-medium'
                        : 'border-border/60 hover:bg-card/60'
                    }`}
                  >
                    <RadioGroupItem id={`ttl-${o.value}`} value={String(o.value)} className="sr-only" />
                    {o.label}
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
              <div className="space-y-0.5 pr-3">
                <Label htmlFor="one-join" className="text-xs font-medium">
                  {t('link.oneJoin', 'One-join (room closes after first pairing)')}
                </Label>
                <p className="text-[10px] text-muted-foreground">
                  Safer for public channels — no second device can join after the first.
                </p>
              </div>
              <Switch id="one-join" checked={oneJoin} onCheckedChange={setOneJoin} />
            </div>

            <div className="flex items-center gap-2 rounded-md border border-flux-500/20 bg-flux-500/5 p-2.5 text-[10px] text-muted-foreground">
              <Unlock className="h-3 w-3 shrink-0 text-flux-600 dark:text-flux-400" aria-hidden />
              The link carries the room code + PIN. Payloads stay end-to-end encrypted via the PAKE
              handshake — the link only opens the door.
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Badge variant="outline" className="mr-auto gap-1 text-[10px] text-muted-foreground">
              <Link2 className="h-3 w-3" aria-hidden />
              {files.length} file{files.length > 1 ? 's' : ''} will follow the link
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void create()}
              disabled={creating || files.length === 0}
              className="bg-flux-600 text-white hover:bg-flux-700 dark:text-white"
            >
              {creating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              {t('link.create', 'Create link & start')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
