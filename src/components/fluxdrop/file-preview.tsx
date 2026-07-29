'use client'

import { useEffect, useState } from 'react'
import { FileIcon } from './file-icon'
import { fileTypeCategory } from '@/lib/fluxdrop/format'

interface FilePreviewProps {
  file: File
  size?: number
  className?: string
}

/**
 * Renders a thumbnail preview for image files, or a FileIcon for other types.
 * Uses URL.createObjectURL for the thumbnail (revoked on unmount/change).
 */
export function FilePreview({ file, size = 36, className }: FilePreviewProps) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const cat = fileTypeCategory(file.type, file.name)
    if (cat !== 'image') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThumbUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setThumbUrl(url)
    setLoaded(false)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file])

  const cat = fileTypeCategory(file.type, file.name)

  if (cat === 'image' && thumbUrl) {
    return (
      <div
        className={`relative overflow-hidden rounded-md bg-muted ${className ?? ''}`}
        style={{ width: size, height: size }}
      >
        {!loaded && (
          <div className="absolute inset-0 animate-pulse bg-muted" />
        )}
        <img
          src={thumbUrl}
          alt={file.name}
          className={`h-full w-full object-cover transition-opacity ${loaded ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setLoaded(true)}
        />
      </div>
    )
  }

  return (
    <div
      className={`flex items-center justify-center rounded-md bg-muted text-muted-foreground ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <FileIcon mime={file.type} name={file.name} className="h-4 w-4" />
    </div>
  )
}
