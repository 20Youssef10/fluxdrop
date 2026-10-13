'use client'

import { useEffect } from 'react'

export interface ShortcutHandlers {
  onSend?: () => void
  onReceive?: () => void
  onBack?: () => void
  onCancel?: () => void
  onToggleTheme?: () => void
  onToggleDiagnostics?: () => void
  onTogglePause?: () => void
  onShowShortcuts?: () => void
}

/**
 * Registers global keyboard shortcuts.
 *  - S          → start send flow (only on landing)
 *  - R          → start receive flow (only on landing)
 *  - Esc        → back / cancel
 *  - P          → pause / resume the active transfer (sender & receiver views)
 *  - Cmd/Ctrl+K → toggle diagnostics panel
 *  - Cmd/Ctrl+J → toggle theme
 *  - ? (Shift+/)→ keyboard shortcuts dialog
 * Ignores shortcuts when focus is in an input/textarea/contenteditable.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, view: string) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const isTyping =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.tagName === 'SELECT'

      // Cmd/Ctrl combos work even when typing
      if (e.metaKey || e.ctrlKey) {
        if (e.key === 'k' || e.key === 'K') {
          e.preventDefault()
          handlers.onToggleDiagnostics?.()
          return
        }
        if (e.key === 'j' || e.key === 'J') {
          e.preventDefault()
          handlers.onToggleTheme?.()
          return
        }
        return
      }

      if (isTyping) return

      // "?" (Shift+/) opens the shortcuts dialog from any view.
      if (e.key === '?') {
        e.preventDefault()
        handlers.onShowShortcuts?.()
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        if (view === 'sender' || view === 'receiver') {
          handlers.onBack?.()
        }
        return
      }

      if (view === 'landing') {
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault()
          handlers.onSend?.()
        } else if (e.key === 'r' || e.key === 'R') {
          e.preventDefault()
          handlers.onReceive?.()
        }
      } else if (view === 'sender' || view === 'receiver') {
        if (e.key === 'p' || e.key === 'P') {
          e.preventDefault()
          handlers.onTogglePause?.()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handlers, view])
}
