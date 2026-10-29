'use client'

import { useCallback, useRef, useState } from 'react'
import { UploadCloud, FolderOpen, X, FilePlus, ClipboardPaste } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { formatBytes, validateFiles, fileTypeCategory } from '@/lib/fluxdrop/format'
import { CONSTANTS } from '@/lib/fluxdrop/protocol'
import { FileIcon, getFileCategoryColors } from './file-icon'
import { FilePreview } from './file-preview'
import { TextSnippetShare } from './text-snippet-share'
import { ShareLinkLauncher } from './share-link-launcher'

interface FilePickerProps {
  files: File[]
  onFilesChange: (files: File[]) => void
  onSend: () => void
  /** v4 (3.4): entry point for the expiring-share-link flow (claims a pre-created room). */
  onSendWithClaim?: (files: File[], resumeManifest: undefined, claim: { roomCode: string; pin: string }) => void
  disabled?: boolean
}

export function FilePicker({ files, onFilesChange, onSend, onSendWithClaim, disabled }: FilePickerProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

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

  const addSnippet = useCallback(
    (file: File) => {
      if (files.length >= CONSTANTS.MAX_FILES_PER_TRANSFER) {
        toast.error(`Maximum ${CONSTANTS.MAX_FILES_PER_TRANSFER} files per transfer`)
        return
      }
      onFilesChange([...files, file])
      toast.success('Snippet added to transfer', {
        description: `${file.name} · ${formatBytes(file.size)}`,
      })
    },
    [files, onFilesChange]
  )

  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const validation = validateFiles(files)

  // Category breakdown for the summary chips
  const categoryCounts = files.reduce<Record<string, number>>((acc, f) => {
    const cat = fileTypeCategory(f.type, f.name)
    acc[cat] = (acc[cat] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <Card
        className={`flux-hover-border relative overflow-hidden border-2 border-dashed transition-all ${
          isDragging
            ? 'border-flux-500 bg-flux-500/5 scale-[1.01]'
            : 'border-border hover:border-flux-500/50 hover:bg-flux-500/[0.02]'
        }`}
      >
        {/* Decorative gradient corner */}
        <div className="pointer-events-none absolute -top-12 -right-12 h-32 w-32 rounded-full bg-flux-500/10 blur-2xl" />
        <div
          className="relative flex flex-col items-center justify-center px-6 py-12 text-center cursor-pointer"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          <div className={`mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-flux-500/10 text-flux-600 dark:text-flux-400 transition-all ${isDragging ? 'scale-110 -translate-y-1' : ''}`}>
            <UploadCloud className="h-8 w-8" />
          </div>
          <p className="text-base font-medium">
            {isDragging ? 'Drop to add files' : 'Drag & drop files here'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            or <span className="text-flux-600 dark:text-flux-400 font-medium">browse</span> from your device
          </p>
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2.5 py-1 text-[11px] text-muted-foreground">
            <ClipboardPaste className="h-3 w-3 text-flux-500" />
            or press <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] font-semibold">Ctrl</kbd>
            <span className="text-[10px]">+</span>
            <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px] font-semibold">V</kbd> to paste files or text
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
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error webkitdirectory is a non-standard but widely-supported attribute
            webkitdirectory=""
            directory=""
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
        {/* Quick-action buttons row */}
        <div className="relative flex items-center justify-center gap-2 border-t border-border/50 px-4 py-2.5 bg-muted/20">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              inputRef.current?.click()
            }}
            className="h-7 text-xs text-muted-foreground hover:text-flux-600 dark:hover:text-flux-400"
          >
            <FilePlus className="mr-1.5 h-3.5 w-3.5" />
            Select files
          </Button>
          <div className="h-3 w-px bg-border" />
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              folderInputRef.current?.click()
            }}
            className="h-7 text-xs text-muted-foreground hover:text-flux-600 dark:hover:text-flux-400"
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            Select folder
          </Button>
        </div>
      </Card>

      {/* Text snippet share option — always available while picking files */}
      <TextSnippetShare onShare={addSnippet} disabled={disabled} />

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

          {/* Category chips */}
          {Object.keys(categoryCounts).length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(categoryCounts).map(([cat, count]) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  <span className="font-medium text-foreground">{count}</span>
                  {cat}
                </span>
              ))}
            </div>
          )}

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

          <div className="space-y-2">
            <Button
              onClick={onSend}
              disabled={disabled || !validation.ok || files.length === 0}
              className="w-full h-12 text-base bg-flux-600 hover:bg-flux-700 text-white shadow-lg shadow-flux-600/25"
            >
              <UploadCloud className="mr-2 h-5 w-5" />
              Create transfer room
            </Button>
            {/* v4 (3.4): expiring share link — same files, pre-created room, link-first flow */}
            {onSendWithClaim && (
              <div className="flex justify-center">
                <ShareLinkLauncher files={files} onStartSend={onSendWithClaim} disabled={disabled || !validation.ok} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FileRow({ file, onRemove }: { file: File; onRemove: () => void }) {
  const relPath = (file as any).webkitRelativePath as string | undefined
  const displayName = relPath && relPath.includes('/') ? relPath : file.name
  const colors = getFileCategoryColors(file.type, file.name)
  const isImage = fileTypeCategory(file.type, file.name) === 'image'
  return (
    <div className="group flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 p-3 transition-colors hover:bg-card hover:border-flux-500/30">
      {isImage ? (
        <FilePreview file={file} size={36} className="shrink-0 ring-1 ring-border/50" />
      ) : (
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${colors.bg} ${colors.text} transition-colors`}>
          <FileIcon mime={file.type} name={file.name} className="h-4 w-4" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={displayName}>{displayName}</p>
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
