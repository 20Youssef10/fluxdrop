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

export function FileIcon({
  mime,
  name,
  className,
}: {
  mime: string
  name: string
  className?: string
}) {
  switch (fileTypeCategory(mime, name)) {
    case 'image': return <FileImage className={className} />
    case 'video': return <FileVideo className={className} />
    case 'audio': return <FileAudio className={className} />
    case 'document': return <FileText className={className} />
    case 'archive': return <FileArchive className={className} />
    case 'code': return <FileCode className={className} />
    default: return <FileDefault className={className} />
  }
}
