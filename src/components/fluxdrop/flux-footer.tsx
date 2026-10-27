'use client'

import { FluxLogo, FluxWordmark } from './flux-logo'
import { Shield, Zap, Lock } from 'lucide-react'
import { InstallButton } from './install-button'

export function FluxFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background/60 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <FluxLogo size={24} animated={false} />
            <FluxWordmark className="text-sm" />
            <span className="text-xs text-muted-foreground ml-2">
              · peer-to-peer file transfer
            </span>
          </div>

          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 text-flux-500" />
              E2E encrypted
            </span>
            <span className="flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-flux-500" />
              WebRTC direct
            </span>
            <span className="flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5 text-flux-500" />
              Zero storage
            </span>
            <InstallButton />
          </div>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Files travel directly between devices over a DTLS-encrypted WebRTC tunnel.
          The signaling server only relays connection metadata — it never touches
          your data.
        </p>
      </div>
    </footer>
  )
}
