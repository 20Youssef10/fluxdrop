'use client'

import { motion } from 'framer-motion'
import { Upload, Download, Shield, Zap, ArrowRight, Lock, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { FluxLogo } from './flux-logo'

interface FluxHeroProps {
  onSend: () => void
  onReceive: () => void
}

export function FluxHero({ onSend, onReceive }: FluxHeroProps) {
  return (
    <section className="flux-mesh-bg flux-grid-overlay relative overflow-hidden">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16 sm:py-24 lg:py-28">
        {/* Hero copy */}
        <div className="mx-auto max-w-3xl text-center">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <Badge
              variant="outline"
              className="mb-6 border-flux-500/40 bg-flux-500/10 text-flux-700 dark:text-flux-300 px-3 py-1"
            >
              <span className="mr-1.5 flex h-1.5 w-1.5 rounded-full bg-flux-500 flux-pulse-dot" />
              WebRTC · End-to-end encrypted · No cloud
            </Badge>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mb-8 flex justify-center"
          >
            <div className="flux-float">
              <FluxLogo size={88} />
            </div>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight"
          >
            Files that <span className="flux-gradient-text">flow directly</span>
            <br />
            between your devices
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto"
          >
            FluxDrop beams files peer-to-peer over WebRTC. No accounts, no cloud
            storage, no servers holding your data. Just a QR scan and a direct,
            encrypted tunnel.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.4 }}
            className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3"
          >
            <Button
              size="lg"
              onClick={onSend}
              className="w-full sm:w-auto h-12 px-8 text-base bg-flux-600 hover:bg-flux-700 text-white shadow-lg shadow-flux-600/25"
            >
              <Upload className="mr-2 h-5 w-5" />
              Send files
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={onReceive}
              className="w-full sm:w-auto h-12 px-8 text-base border-flux-500/40 hover:bg-flux-500/10"
            >
              <Download className="mr-2 h-5 w-5" />
              Receive files
            </Button>
          </motion.div>
        </div>

        {/* Feature cards */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-20 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl mx-auto"
        >
          <FeatureCard
            icon={<Lock className="h-5 w-5" />}
            title="End-to-end encrypted"
            description="WebRTC DTLS encrypts every byte in transit. Not even the signaling server can read your files."
          />
          <FeatureCard
            icon={<Zap className="h-5 w-5" />}
            title="LAN-speed fast"
            description="Bytes travel the shortest path — straight between peers. No round-trips to a cloud."
          />
          <FeatureCard
            icon={<Shield className="h-5 w-5" />}
            title="Zero footprint"
            description="Nothing is stored on a server. Close the tab and the transfer vanishes — only your devices hold the data."
          />
        </motion.div>

        {/* How it works */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.6 }}
          className="mt-20 max-w-4xl mx-auto"
        >
          <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-8">
            How it works
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <StepCard step={1} title="Pick files" description="Drag in anything — photos, docs, archives up to 10 GB." />
            <StepCard step={2} title="Show QR" description="A scannable code links your two devices instantly." />
            <StepCard step={3} title="Confirm" description="Receiver accepts. A direct P2P tunnel opens." />
            <StepCard step={4} title="Flow" description="Bytes stream over WebRTC. SHA-256 verified on arrival." />
          </div>
        </motion.div>
      </div>
    </section>
  )
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <Card className="flux-glass p-5 border-border/40">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-flux-500/15 text-flux-600 dark:text-flux-400">
          {icon}
        </div>
        <div>
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{description}</p>
        </div>
      </div>
    </Card>
  )
}

function StepCard({ step, title, description }: { step: number; title: string; description: string }) {
  return (
    <div className="relative rounded-xl border border-border/50 bg-card/50 p-5">
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-flux-500/15 text-flux-600 dark:text-flux-400 font-bold text-sm">
        {step}
      </div>
      <h3 className="font-semibold text-sm">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{description}</p>
    </div>
  )
}
