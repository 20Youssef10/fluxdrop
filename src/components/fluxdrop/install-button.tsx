'use client'

import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * "Install app" button — appears once the browser fires `beforeinstallprompt`
 * (Chrome/Edge/Android). Clicking it shows the native install dialog.
 * Renders nothing in browsers that don't support installation.
 */
export function InstallButton() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault() // prevent the mini-infobar; we own the UX
      setPromptEvent(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setPromptEvent(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    // Already running as an installed PWA? Don't offer the button.
    if (window.matchMedia('(display-mode: standalone)').matches) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInstalled(true)
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (!promptEvent || installed) return null

  const handleInstall = async () => {
    try {
      await promptEvent.prompt()
      const { outcome } = await promptEvent.userChoice
      if (outcome === 'accepted') setInstalled(true)
    } catch { /* ignore */ }
    setPromptEvent(null)
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleInstall}
      className="h-7 text-xs border-flux-500/30 text-flux-700 dark:text-flux-300 hover:bg-flux-500/10"
    >
      <Download className="mr-1.5 h-3.5 w-3.5" />
      Install app
    </Button>
  )
}
