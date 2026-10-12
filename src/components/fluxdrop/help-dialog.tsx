'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Shield, Zap, Wifi, AlertTriangle, Lock, Server } from 'lucide-react'

interface HelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const FAQS = [
  {
    q: 'How does FluxDrop transfer files?',
    a: 'FluxDrop uses WebRTC DataChannels to establish a direct, peer-to-peer connection between your device and the receiver. A lightweight signaling server helps coordinate the initial handshake (exchanging room IDs, PINs, and WebRTC connection metadata), but after that, all file data flows directly between the two devices — never touching any server.',
  },
  {
    q: 'Is it secure? Can anyone see my files?',
    a: 'Yes, it\'s secure. WebRTC mandates DTLS encryption for all data channels, meaning every byte is encrypted in transit. Even the signaling server cannot read your files — it only relays connection setup metadata. SHA-256 checksums verify file integrity on arrival, so corrupted or tampered bytes are detected and rejected.',
  },
  {
    q: 'What are the size and file limits?',
    a: 'You can send up to 100 files per transfer, with a maximum total size of 10 GB. Individual files can be up to 10 GB. Certain executable file types (.exe, .bat, .cmd, .sh, etc.) are blocked for safety. Files are chunked into 1 MB pieces for reliable transfer with backpressure-aware flow control.',
  },
  {
    q: 'Does it work across different networks (not on the same Wi-Fi)?',
    a: 'Yes, in most cases. WebRTC uses STUN servers to discover your public IP and traverse NATs. This works for most home and mobile networks. However, some corporate firewalls block UDP traffic entirely — in those cases, you can configure a custom TURN server in Settings → Network, which relays traffic (still encrypted) when direct P2P fails.',
  },
  {
    q: 'Does it use internet data if both devices are on the same LAN?',
    a: 'No — the file transfer is 100% local. WebRTC detects "host" candidates (your LAN IP like 192.168.x.x) and establishes a direct local connection. File bytes never leave your network. Only a few KB of internet data is used for the initial signaling (room setup, SDP/ICE exchange via the signaling server) and STUN queries (~1-2 KB each). Once the DataChannel opens, all data flows over your LAN. Check the Diagnostics panel (⌘K) — it shows a green "Direct LAN" badge when this is the case.',
  },
  {
    q: 'What happens if the transfer is interrupted?',
    a: 'FluxDrop persists transfer state in your browser\'s IndexedDB. If a transfer is interrupted (network drop, tab close, device sleep), the receiver stores received chunks locally. The sender can resume from the last acknowledged chunk rather than restarting. Look for the resume button (↻) on incomplete transfers in your transfer history.',
  },
  {
    q: 'Which browsers are supported?',
    a: 'FluxDrop works in Chrome 90+, Firefox 90+, Safari 15+, and Edge 90+. The File System Access API (for native save dialogs) is available in Chrome/Edge but falls back to a standard download in other browsers.',
  },
  {
    q: 'Why is there a PIN?',
    a: 'The 6-digit PIN authenticates the pairing request, ensuring that only someone you\'ve shared the PIN with can join your transfer room. Rooms expire automatically after 5 minutes of inactivity. You can share the PIN via the QR code, a shareable link, or manually.',
  },
  {
    q: 'Is anything stored on a server?',
    a: 'No file data is ever stored on any server. The signaling server is ephemeral and stateless after session establishment — it only holds room metadata (room ID, PIN, device aliases) in memory during the active session, then discards it. Your transfer history is stored locally in your browser\'s IndexedDB.',
  },
]

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-flux-500" />
            How FluxDrop works
          </DialogTitle>
          <DialogDescription>
            Common questions about security, privacy, and limitations.
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto flux-scroll pr-1 -mr-1">
          <Accordion type="single" collapsible className="w-full">
            {FAQS.map((faq, i) => (
              <AccordionItem key={i} value={`item-${i}`}>
                <AccordionTrigger className="text-sm font-medium text-left">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>

          {/* Quick facts grid */}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <FactCard
              icon={<Lock className="h-3.5 w-3.5" />}
              label="Encryption"
              value="DTLS (WebRTC)"
            />
            <FactCard
              icon={<Zap className="h-3.5 w-3.5" />}
              label="Max speed"
              value="LAN/Wi-Fi direct"
            />
            <FactCard
              icon={<Wifi className="h-3.5 w-3.5" />}
              label="NAT traversal"
              value="STUN + optional TURN"
            />
            <FactCard
              icon={<Server className="h-3.5 w-3.5" />}
              label="Server storage"
              value="Zero"
            />
          </div>

          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-muted-foreground">
            <p className="flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
              <span>
                <span className="font-medium text-amber-600 dark:text-amber-400">Limitation:</span>{' '}
                Some corporate/firewalled networks block UDP. If the connection fails, try
                configuring a TURN server in Settings → Network, or switch to a different network.
              </span>
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FactCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-card/40 p-2.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-0.5 text-xs font-medium">{value}</p>
    </div>
  )
}
