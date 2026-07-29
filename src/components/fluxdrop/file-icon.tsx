'use client'

import {
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  FileCode,
  File as FileDefault,
} from 'lucide-react'
import { fileTypeCategory } from '@/lib/fluxdrop/format'

// Color classes per category — used for the icon background tint
const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  image: { bg: 'bg-purple-500/15', text: 'text-purple-500 dark:text-purple-400' },
  video: { bg: 'bg-rose-500/15', text: 'text-rose-500 dark:text-rose-400' },
  audio: { bg: 'bg-amber-500/15', text: 'text-amber-500 dark:text-amber-400' },
  document: { bg: 'bg-flux-500/15', text: 'text-flux-600 dark:text-flux-400' },
  archive: { bg: 'bg-orange-500/15', text: 'text-orange-500 dark:text-orange-400' },
  code: { bg: 'bg-cyan-500/15', text: 'text-cyan-500 dark:text-cyan-400' },
  other: { bg: 'bg-muted', text: 'text-muted-foreground' },
}

export function FileIcon({
  mime,
  name,
  className,
}: {
  mime: string
  name: string
  className?: string
}) {
  const cat = fileTypeCategory(mime, name)
  switch (cat) {
    case 'image': return <FileImage className={className} />
    case 'video': return <FileVideo className={className} />
    case 'audio': return <FileAudio className={className} />
    case 'document': return <FileText className={className} />
    case 'archive': return <FileArchive className={className} />
    case 'code': return <FileCode className={className} />
    default: return <FileDefault className={className} />
  }
}

/**
 * Returns the background + text color classes for a file's category.
 * Use this to tint icon containers with category-appropriate colors.
 */
export function getFileCategoryColors(mime: string, name: string) {
  const cat = fileTypeCategory(mime, name)
  return CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.other
}
