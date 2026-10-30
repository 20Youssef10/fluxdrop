// @fluxdrop/sdk/widget — `<fluxdrop-widget>` custom element.
//
// A framework-free, shadow-DOM'd send widget: pick files → a PIN-protected
// room is created (code + copy button + join link) → the receiver (any
// FluxDrop app instance) joins → WebRTC transfer with live progress and
// SHA-256 verification. ZERO dependencies beyond the SDK itself — usable from
// plain HTML:
//
//   <script type="module">
//     import '@fluxdrop/sdk/widget'
//   </script>
//   <fluxdrop-widget signal-url="/signal" accent="#0d9488"></fluxdrop-widget>
//
// Attributes (all optional):
//   signal-url — signaling server base URL (default: page origin)
//   endpoint   — FluxDrop web instance for the join link (default: page origin)
//   accent     — theme color (default: the FluxDrop teal-green)
//   lang       — 'en' | 'ar' (RTL) label set
//
// Events (all CustomEvents on the element):
//   fluxdrop-ready     { roomId, pin, joinUrl }
//   fluxdrop-progress  { bytesTransferred, totalBytes }
//   fluxdrop-complete  { verified, files, totalBytes }
//   fluxdrop-error     { message }

import { createFluxdropClient, type FluxdropClient } from './index'

interface WidgetStrings {
  title: string
  hint: string
  choose: string
  send: string
  room: string
  pin: string
  copy: string
  copied: string
  waiting: string
  sending: string
  done: string
  verified: string
  failed: string
  retry: string
}

const STRINGS: Record<'en' | 'ar', WidgetStrings> = {
  en: {
    title: 'FluxDrop',
    hint: 'Pick files — the receiver scans or opens the link.',
    choose: 'Choose files',
    send: 'Send',
    room: 'Room',
    pin: 'PIN',
    copy: 'Copy',
    copied: 'Copied!',
    waiting: 'Waiting for the receiver…',
    sending: 'Sending',
    done: 'Sent & verified',
    verified: 'Receiver verified all checksums.',
    failed: 'Transfer failed',
    retry: 'Try again',
  },
  ar: {
    title: 'فلَكس‌درُوب',
    hint: 'اختر الملفات — يستلمها الطرف الآخر عبر الرمز أو الرابط.',
    choose: 'اختر الملفات',
    send: 'إرسال',
    room: 'الغرفة',
    pin: 'الرمز',
    copy: 'نسخ',
    copied: 'تم النسخ!',
    waiting: 'في انتظار المستلم…',
    sending: 'جارٍ الإرسال',
    done: 'أُرسل وتَم التحقق',
    verified: 'تحقّق المستلم من جميع البصمات.',
    failed: 'فشل النقل',
    retry: 'أعد المحاولة',
  },
}

const CSS = (accent: string): string => `
  :host { display: block; max-width: 360px; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  * { box-sizing: border-box; margin: 0; }
  .card { border: 1px solid color-mix(in srgb, ${accent} 28%, #d4d4d8); border-radius: 14px; padding: 16px; background: #fff; color: #18181b; }
  :host([data-dark]) .card { background: #101418; color: #e6edf3; border-color: color-mix(in srgb, ${accent} 30%, #27272a); }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .logo { width: 20px; height: 20px; }
  .title { font-weight: 800; letter-spacing: .3px; font-size: 15px; }
  .hint { font-size: 12px; opacity: .65; margin-bottom: 12px; }
  .row { display: flex; gap: 8px; }
  input[type=file] { display: none; }
  button { font: inherit; border: 1px solid color-mix(in srgb, ${accent} 40%, #d4d4d8); background: color-mix(in srgb, ${accent} 10%, #fff); color: color-mix(in srgb, ${accent} 80%, #000); border-radius: 9px; padding: 8px 14px; cursor: pointer; font-weight: 600; font-size: 13px; }
  button:hover { background: color-mix(in srgb, ${accent} 18%, #fff); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: ${accent}; color: #fff; border-color: ${accent}; }
  :host([data-dark]) button { background: color-mix(in srgb, ${accent} 12%, #101418); color: color-mix(in srgb, ${accent} 60%, #fff); border-color: color-mix(in srgb, ${accent} 35%, #27272a); }
  .meta { margin-top: 12px; font-size: 12px; }
  .room { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 10px; border-radius: 10px; background: color-mix(in srgb, ${accent} 7%, transparent); border: 1px dashed color-mix(in srgb, ${accent} 35%, #d4d4d8); }
  .code { font-family: ui-monospace, monospace; font-weight: 800; letter-spacing: 2px; font-size: 16px; }
  .pin { font-family: ui-monospace, monospace; opacity: .8; }
  .bar { margin-top: 12px; height: 6px; border-radius: 999px; background: color-mix(in srgb, ${accent} 12%, #e4e4e7); overflow: hidden; }
  .bar > div { height: 100%; width: 0%; background: ${accent}; border-radius: 999px; transition: width .25s ease; }
  .state { margin-top: 8px; font-size: 12px; opacity: .75; }
  .ok { margin-top: 10px; padding: 10px; border-radius: 10px; background: color-mix(in srgb, ${accent} 12%, transparent); border: 1px solid color-mix(in srgb, ${accent} 40%, transparent); font-size: 13px; font-weight: 600; }
  .err { color: #dc2626; margin-top: 10px; font-size: 13px; }
  a { color: ${accent}; font-weight: 600; text-decoration: none; font-size: 12px; word-break: break-all; }
`

const LOGO = `<svg class="logo" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2c3.5 4.2 7 7.6 7 11.5A7 7 0 0 1 5 13.5C5 9.6 8.5 6.2 12 2Z" fill="currentColor" opacity=".9"/><path d="M9 13.5h6M12 10.5v6" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`

export class FluxDropWidgetElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['accent', 'lang', 'signal-url', 'endpoint']
  }

  private client: FluxdropClient | null = null
  private files: File[] = []
  private shadow: ShadowRoot

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
    this.render('idle')
  }

  private get accent(): string {
    return (this.getAttribute('accent') ?? '#0d9488').trim() || '#0d9488'
  }

  private get strings(): WidgetStrings {
    return STRINGS[(this.getAttribute('lang') ?? 'en') as 'en' | 'ar'] ?? STRINGS.en
  }

  private get signalUrl(): string | undefined {
    return this.getAttribute('signal-url') ?? undefined
  }

  private get endpoint(): string {
    return this.getAttribute('endpoint') ?? window.location.origin
  }

  private get isRTL(): boolean {
    return (this.getAttribute('lang') ?? 'en') === 'ar'
  }

  private fire(name: string, detail?: Record<string, unknown>): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }))
  }

  private render(
    phase: 'idle' | 'room' | 'transferring' | 'done' | 'error',
    info: { roomId?: string; pin?: string | null; joinUrl?: string | null; pct?: number; message?: string; verified?: boolean } = {}
  ): void {
    const s = this.strings
    const dir = this.isRTL ? 'rtl' : 'ltr'
    this.shadow.innerHTML = `
      <style>${CSS(this.accent)}</style>
      <div class="card" dir="${dir}">
        <div class="head">${LOGO}<span class="title">${s.title}</span></div>
        <p class="hint">${s.hint}</p>
        <div class="row">
          <input type="file" id="pick" multiple />
          <button id="choose" part="choose">${s.choose}</button>
          <button id="send" class="primary" part="send" disabled>${s.send}</button>
        </div>
        ${phase === 'room' && info.roomId ? `
          <div class="room" part="room">
            <span class="code">${info.roomId}</span>
            ${info.pin ? `<span class="pin">${s.pin} ${info.pin}</span>` : ''}
            <button id="copy" style="margin-inline-start:auto">${s.copy}</button>
          </div>
          ${info.joinUrl ? `<p class="meta"><a href="${info.joinUrl}" target="_blank" rel="noopener">${info.joinUrl}</a></p>` : ''}
          <p class="state">${s.waiting}</p>
        ` : ''}
        ${phase === 'transferring' ? `
          <div class="bar" part="bar"><div style="width:${Math.round(info.pct ?? 0)}%"></div></div>
          <p class="state">${s.sending}… ${Math.round(info.pct ?? 0)}%</p>
        ` : ''}
        ${phase === 'done' ? `
          <div class="ok">✓ ${info.verified ? s.done : s.failed} — ${s.verified}</div>
          <div class="row" style="margin-top:10px">
            <button id="reset">${s.retry}</button>
          </div>
        ` : ''}
        ${phase === 'error' ? `
          <p class="err">${info.message ?? s.failed}</p>
          <div class="row" style="margin-top:10px">
            <button id="reset">${s.retry}</button>
          </div>
        ` : ''}
      </div>
    `

    const $ = (id: string) => this.shadow.getElementById(id)
    const pick = $('pick') as HTMLInputElement | null
    const chooseBtn = $('choose')
    const sendBtn = $('send') as HTMLButtonElement | null
    if (pick && chooseBtn) {
      chooseBtn.onclick = () => pick.click()
      pick.onchange = () => {
        this.files = Array.from((pick as HTMLInputElement).files ?? [])
        if (sendBtn) sendBtn.disabled = this.files.length === 0
      }
    }
    if (sendBtn) {
      sendBtn.onclick = () => void this.startSend()
    }
    const copyBtn = $('copy')
    if (copyBtn && info.roomId) {
      copyBtn.onclick = () => {
        void navigator.clipboard?.writeText(`${info.roomId}${info.pin ? ` · ${info.pin}` : ''}`)
        copyBtn.textContent = s.copied
        setTimeout(() => { copyBtn.textContent = s.copy }, 1500)
      }
    }
    const resetBtn = $('reset')
    if (resetBtn) {
      resetBtn.onclick = () => {
        this.client?.destroy()
        this.client = null
        this.files = []
        this.render('idle')
      }
    }
  }

  private async startSend(): Promise<void> {
    if (this.files.length === 0) return
    this.client?.destroy()
    this.client = createFluxdropClient({
      alias: 'fluxdrop-widget',
      role: 'sender',
      signalUrl: this.signalUrl,
      endpoint: this.endpoint,
    })
    try {
      const room = await this.client.createRoom()
      const joinUrl = room.joinUrl ?? `${this.endpoint.replace(/\/+$/, '')}/#join=${room.roomId}&pin=${room.pin ?? ''}`
      this.render('room', { roomId: room.roomId, pin: room.pin, joinUrl })
      this.fire('fluxdrop-ready', { roomId: room.roomId, pin: room.pin, joinUrl })

      // The room view stays up while sendFiles waits for a receiver; progress
      // updates re-render into the transferring phase.
      let firstProgress = true
      this.client.on('progress', (p) => {
        const pct = p.totalBytes > 0 ? (p.bytesTransferred / p.totalBytes) * 100 : 0
        if (firstProgress && pct > 0) {
          firstProgress = false
        }
        this.render('transferring', { pct })
        this.fire('fluxdrop-progress', { bytesTransferred: p.bytesTransferred, totalBytes: p.totalBytes })
      })

      const result = await this.client.sendFiles(this.files)
      this.render('done', { verified: result.verified })
      this.fire('fluxdrop-complete', {
        verified: result.verified,
        files: result.manifest.files.map((f) => f.name),
        totalBytes: result.manifest.totalSize,
      })
    } catch (err) {
      this.render('error', { message: String((err as Error)?.message ?? err) })
      this.fire('fluxdrop-error', { message: String((err as Error)?.message ?? err) })
    }
  }

  attributeChangedCallback(): void {
    // Live re-theme without a transfer in flight.
    if (!this.client) this.render('idle')
  }

  disconnectedCallback(): void {
    this.client?.destroy()
    this.client = null
  }
}

// Auto-define: importing the module is the registration.
if (typeof window !== 'undefined' && typeof customElements !== 'undefined') {
  if (!customElements.get('fluxdrop-widget')) {
    customElements.define('fluxdrop-widget', FluxDropWidgetElement)
  }
}
