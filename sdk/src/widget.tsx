// @fluxdrop/sdk/widget — React <FluxDropWidget> skeleton.
//
// Plain React only (no next/* imports, no shadcn/ui, no CSS framework): the
// widget is a drop-in SHELL that embedders can theme via the `theme` prop,
// point at their FluxDrop instance via the `endpoint` prop, and wire to their
// own app via the `onSend` callback. TODO/FULL-UI-SLOT comments mark where the
// full FluxDrop UI components (src/components/fluxdrop/*) slot in when the
// SDK graduates from scaffold to full embeddable client (FEATURES.md 9.3).
//
// Usage:
//   import { FluxDropWidget } from '@fluxdrop/sdk/widget'
//   <FluxDropWidget
//     endpoint="https://fluxdrop.example.com"
//     onSend={files => myUploadQueue.addAll(files)}
//     theme={{ accent: '#6d28d9' }}
//   />

import React, { useCallback, useRef, useState } from 'react'

export interface FluxDropWidgetTheme {
  /** Accent color for buttons/progress (any CSS color). */
  accent?: string
  /** Widget chrome radius in px. */
  radius?: number
  /** Dark mode chrome. */
  dark?: boolean
}

export interface FluxDropWidgetProps {
  /**
   * Called with the user's selected files when they hit "Send".
   * In the full SDK this starts a FluxDrop room transfer; in the scaffold it
   * hands the files to the host app (the transfer pipeline remains in the
   * main FluxDrop app until 9.3's follow-up lands).
   */
  onSend?: (files: File[]) => void | Promise<void>
  /**
   * Base URL of the FluxDrop instance this widget fronts. Rendered as an
   * "open in FluxDrop" affordance today; once the client façade is wired it
   * becomes the join-URL base (endpoint + /?room=… + QR payload) for the
   * generated rooms.
   */
  endpoint?: string
  /** Visual theming (accent color, radius, dark chrome). */
  theme?: FluxDropWidgetTheme
  /** Compact variant for sidebars/support chats. */
  compact?: boolean
}

const DEFAULT_THEME: Required<Pick<FluxDropWidgetTheme, 'accent' | 'radius'>> = {
  accent: '#6d28d9',
  radius: 12,
}

export function FluxDropWidget({
  onSend,
  endpoint,
  theme = {},
  compact = false,
}: FluxDropWidgetProps): React.ReactElement {
  const { accent, radius } = { ...DEFAULT_THEME, ...theme }
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)

  const pick = useCallback(() => inputRef.current?.click(), [])

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? [])
    setFiles((prev) => [...prev, ...picked].slice(0, 100 /* CONSTANTS.MAX_FILES_PER_TRANSFER */))
    e.target.value = '' // allow re-selecting the same file
  }, [])

  const send = useCallback(async () => {
    if (files.length === 0 || !onSend) return
    setBusy(true)
    try {
      await onSend(files)
      setFiles([])
    } finally {
      setBusy(false)
    }
  }, [files, onSend])

  const shell: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: compact ? 8 : 12,
    padding: compact ? 12 : 16,
    borderRadius: radius,
    border: '1px solid rgba(127,127,127,.35)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: compact ? 320 : 420,
  }

  const dropzone: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: compact ? 64 : 96,
    borderRadius: radius - 4,
    border: `1.5px dashed ${accent}`,
    color: accent,
    cursor: 'pointer',
    fontWeight: 500,
    fontSize: compact ? 13 : 14,
  }

  const button: React.CSSProperties = {
    backgroundColor: accent,
    color: '#fff',
    border: 'none',
    borderRadius: radius - 4,
    padding: compact ? '8px 14px' : '10px 18px',
    fontSize: compact ? 13 : 14,
    fontWeight: 600,
    cursor: busy || files.length === 0 ? 'not-allowed' : 'pointer',
    opacity: busy || files.length === 0 ? 0.55 : 1,
  }

  const link: React.CSSProperties = {
    fontSize: 12,
    color: accent,
    textDecoration: 'none',
  }

  return (
    <div style={shell} data-fluxdrop-widget="" data-endpoint={endpoint ?? ''}>
      {/* FULL-UI SLOT: in the complete SDK this is where the production
          components mount — file-picker, transfer-progress, consent-dialog,
          qr-display, chat-panel (src/components/fluxdrop/*). The shell below
          is intentionally minimal so embedders see the contract, not our
          chrome. */}
      <div style={dropzone} onClick={pick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && pick()}>
        {files.length > 0 ? `${files.length} file(s) ready` : 'Drop or choose files'}
      </div>
      <input ref={inputRef} type="file" multiple hidden onChange={onInputChange} />
      {files.length > 0 && (
        <ul aria-label="queued files" style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'rgba(0,0,0,.7)' }}>
          {files.slice(0, 5).map((f) => (
            <li key={`${f.name}:${f.lastModified}`} title={f.name}>{f.name}</li>
          ))}
          {files.length > 5 && <li>… {files.length - 5} more</li>}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" style={button} disabled={busy || files.length === 0} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        {/* TODO(full-UI): once the façade creates rooms, this becomes a live
            join URL + QR (endpoint + ?room=<joinCode>) via qr-display. */}
        {endpoint && (
          <a style={link} href={endpoint} target="_blank" rel="noreferrer noopener">
            open in FluxDrop ↗
          </a>
        )}
      </div>
    </div>
  )
}

export default FluxDropWidget
