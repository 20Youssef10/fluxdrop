'use client'

import { useCallback, useRef, useState } from 'react'
import { UploadCloud, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { formatBytes, validateFiles } from '@/lib/fluxdrop/format'
import { CONSTANTS } from '@/lib/fluxdrop/protocol'
import { FileIcon } from './file-icon'

interface FilePickerProps {
  files: File[]
  onFilesChange: (files: File[]) => void
  onSend: () => void
  disabled?: boolean
}

export function FilePicker({ files, onFilesChange, onSend, disabled }: FilePickerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    (incoming: FileList | null) => {
      if (!incoming || incoming.length === 0) return
      const arr = Array.from(incoming)
      const merged = [...files, ...arr]
      onFilesChange(merged)
    },
    [files, onFilesChange]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles]
  )

  const removeFile = (idx: number) => {
    onFilesChange(files.filter((_, i) => i !== idx))
  }

  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const validation = validateFiles(files)

  return (
    <div className="space-y-4">
      <Card
        className={`relative overflow-hidden border-2 border-dashed transition-all ${
          isDragging
            ? 'border-flux-500 bg-flux-500/5'
            : 'border-border hover:border-flux-500/50 hover:bg-flux-500/[0.02]'
        }`}
      >
        <div
          className="flex flex-col items-center justify-center px-6 py-12 text-center cursor-pointer"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-flux-500/10 text-flux-600 dark:text-flux-400 transition-transform ${isDragging ? 'scale-110' : ''}`}>
            <UploadCloud className="h-8 w-8" />
          </div>
          <p className="text-base font-medium">
            {isDragging ? 'Drop to add files' : 'Drag & drop files here'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            or <span className="text-flux-600 dark:text-flux-400 font-medium">browse</span> from your device
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Up to {CONSTANTS.MAX_FILES_PER_TRANSFER} files · {formatBytes(CONSTANTS.MAX_FILE_SIZE)} max · all types welcome
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      </Card>

      {files.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="font-medium">{files.length}</span>{' '}
              <span className="text-muted-foreground">file{files.length > 1 ? 's' : ''} ·</span>{' '}
              <span className="font-medium">{formatBytes(totalSize)}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onFilesChange([])}
              className="text-xs h-8 text-muted-foreground"
            >
              Clear all
            </Button>
          </div>

          <div className="max-h-72 overflow-y-auto flux-scroll space-y-2 pr-1">
            {files.map((file, idx) => (
              <FileRow key={`${file.name}-${idx}`} file={file} onRemove={() => removeFile(idx)} />
            ))}
          </div>

          {validation.errors.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {validation.errors.map((e, i) => (
                <p key={i}>• {e}</p>
              ))}
            </div>
          )}

          <Button
            onClick={onSend}
            disabled={disabled || !validation.ok || files.length === 0}
            className="w-full h-12 text-base bg-flux-600 hover:bg-flux-700 text-white shadow-lg shadow-flux-600/25"
          >
            <UploadCloud className="mr-2 h-5 w-5" />
            Create transfer room
          </Button>
        </div>
      )}
    </div>
  )
}

function FileRow({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 p-3 transition-colors hover:bg-card">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileIcon mime={file.type} name={file.name} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(file.size)} · {file.type || 'unknown type'}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
