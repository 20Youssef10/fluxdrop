'use client'

import { Laptop, Smartphone, Tablet, Monitor } from 'lucide-react'

export function DeviceIcon({ alias, className }: { alias: string; className?: string }) {
  const lower = alias.toLowerCase()
  let h = 0
  for (let i = 0; i < alias.length; i++) h = (h * 31 + alias.charCodeAt(i)) >>> 0
  const idx = h % 4

  if (/phone|mobile|pocket/.test(lower)) return <Smartphone className={className} />
  if (/tablet|slate|pad/.test(lower)) return <Tablet className={className} />
  if (/laptop|book|notebook/.test(lower)) return <Laptop className={className} />
  if (/desktop|tower|workstation/.test(lower)) return <Monitor className={className} />

  switch (idx) {
    case 0: return <Laptop className={className} />
    case 1: return <Smartphone className={className} />
    case 2: return <Tablet className={className} />
    default: return <Monitor className={className} />
  }
}
