'use client'

// v1.3 (6.3): in-room chat over the DataChannel — a floating, collapsible
// panel. Chat is P2P only: frames ride the same DataChannel as the transfer
// (PIN-sealed when the PAKE session is active), the signaling server never
// sees a message. Mounted ONCE in page.tsx; visible only while a room is
// live and the DataChannel is open.

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MessageSquare, ShieldCheck, ShieldAlert, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useChatStore, type ChatMessage } from '@/stores/chat-store'
import { useSessionStore } from '@/stores/session-store'
import { toast } from 'sonner'

// Mirrors the router-side cap in use-fluxdrop.ts.
const CHAT_MAX_LEN = 2000
// Show the counter once the draft comes near the cap.
const CHAT_COUNTER_THRESHOLD = CHAT_MAX_LEN - 200

interface ChatPanelProps {
  /** `sendChat` from useFluxDrop — returns false when no channel is open. */
  onSend: (text: string) => boolean
}

export function ChatPanel({ onSend }: ChatPanelProps) {
  const open = useChatStore((s) => s.open)
  const toggleOpen = useChatStore((s) => s.toggleOpen)
  const messages = useChatStore((s) => s.messages)
  const unread = useChatStore((s) => s.unread)
  const markRead = useChatStore((s) => s.markRead)
  const roomId = useSessionStore((s) => s.roomId)
  const dataChannelOpen = useSessionStore((s) => s.dataChannelOpen)
  const e2eStatus = useSessionStore((s) => s.e2eStatus)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Chat only exists with a live room + DataChannel.
  const visible = !!roomId && dataChannelOpen

  const e2eActive = e2eStatus === 'active'
  const nearLimit = draft.length >= CHAT_COUNTER_THRESHOLD

  // Opening the panel (or a message arriving while it's open) clears unread.
  useEffect(() => {
    if (open) markRead()
  }, [open, messages.length, markRead])

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [messages.length, open])

  // Focus the composer when the panel opens (desktop nicety; on touch the
  // keyboard stays closed until the user taps the field because focus happens
  // on the same gesture that opened the panel).
  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true })
  }, [open])

  if (!visible) return null

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    if (!onSend(text)) {
      toast.info('Chat unavailable', {
        description: 'The DataChannel is not open — reconnect with the peer first.',
      })
      return
    }
    setDraft('')
  }

  return (
    <div className="fixed bottom-20 right-4 sm:right-6 z-40 flex flex-col items-end gap-2">
      {/* Collapsible transcript card */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="chat-card"
            initial={{ opacity: 0, height: 0, y: 8 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: 8 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <Card className="flux-glass flex w-80 sm:w-96 max-h-[28rem] flex-col overflow-hidden p-0">
              {/* Header */}
              <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-flux-500/15 text-flux-600 dark:text-flux-400">
                  <MessageSquare className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-tight">Room chat</p>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    P2P only · room {roomId}
                  </p>
                </div>
                {e2eActive ? (
                  <Badge
                    variant="outline"
                    className="shrink-0 gap-1 border-flux-500/40 bg-flux-500/10 text-[10px] text-flux-700 dark:text-flux-300"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    PIN-sealed
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="shrink-0 gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
                  >
                    <ShieldAlert className="h-3 w-3" />
                    DTLS only
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => toggleOpen()}
                  aria-label="Close room chat"
                  className="h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {/* Transcript */}
              <div
                ref={listRef}
                role="log"
                aria-live="polite"
                aria-label="Room messages"
                className="flux-scroll max-h-56 min-h-24 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5"
              >
                {messages.length === 0 ? (
                  <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                    No messages yet — coordinate the drop here.
                    <br />
                    <span className="text-[10px] text-muted-foreground/70">
                      Text never touches a server.
                    </span>
                  </p>
                ) : (
                  messages.map((m) => <ChatBubble key={m.id} m={m} />)
                )}
              </div>

              {/* Composer */}
              <form
                className="flex items-center gap-2 border-t border-border/50 p-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  submit()
                }}
              >
                <label htmlFor="fluxdrop-chat-input" className="sr-only">
                  Message
                </label>
                <div className="min-w-0 flex-1">
                  <Input
                    id="fluxdrop-chat-input"
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value.slice(0, CHAT_MAX_LEN))}
                    placeholder="Type a message…"
                    maxLength={CHAT_MAX_LEN}
                    autoComplete="off"
                    className="h-11 bg-background/60 text-sm"
                  />
                </div>
                <Button
                  type="submit"
                  aria-label="Send message"
                  disabled={!draft.trim()}
                  className="h-11 w-11 shrink-0 rounded-full bg-flux-600 text-white hover:bg-flux-700"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </form>
              {nearLimit && (
                <p className="px-3 pb-2 text-right text-[10px] tabular-nums text-amber-600 dark:text-amber-400">
                  {draft.length}/{CHAT_MAX_LEN}
                </p>
              )}
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating toggle */}
      <div className="relative">
        <Button
          onClick={() => toggleOpen()}
          aria-label="Room chat"
          aria-expanded={open}
          className="h-12 w-12 rounded-full bg-flux-600 text-white shadow-lg shadow-flux-600/25 hover:bg-flux-700"
        >
          <MessageSquare className="h-5 w-5" />
        </Button>
        {!open && unread > 0 && (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-background bg-flux-600 px-1 text-[10px] font-bold tabular-nums text-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>
    </div>
  )
}

function ChatBubble({ m }: { m: ChatMessage }) {
  const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}>
      <div className="flex items-baseline gap-1.5 px-1">
        <span className="text-[10px] font-medium text-muted-foreground">
          {m.mine ? 'You' : m.alias}
        </span>
        <span className="text-[10px] text-muted-foreground/70">{time}</span>
        {m.viaE2E && (
          <ShieldCheck
            className="h-3 w-3 text-flux-500"
            aria-label="PIN-sealed message"
          />
        )}
      </div>
      <div
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-xs leading-relaxed text-foreground ${
          m.mine
            ? 'rounded-br-sm bg-flux-500/15'
            : 'rounded-bl-sm border border-border/50 bg-card/60'
        }`}
      >
        {m.text}
      </div>
    </div>
  )
}
