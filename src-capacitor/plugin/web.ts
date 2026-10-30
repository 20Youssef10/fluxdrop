import type { FluxDropShellPlugin, FluxDropNativeEvent } from './definitions'

/**
 * Web fallback: there is no native shell, so every capability degrades to a
 * quiet no-op (the real web build never registers this — it doesn't even load
 * the plugin — this exists so standalone imports stay total).
 */
export class FluxDropShellWeb implements FluxDropShellPlugin {
  async getShellInfo(): Promise<{ kind: string; platform: string; capabilities: Record<string, boolean> }> {
    return {
      kind: 'web',
      platform: 'web',
      capabilities: {
        tray: false,
        autostart: false,
        deepLinks: false,
        shareTarget: false,
        shareOut: false,
        foregroundService: false,
        keepScreenAwake: false,
        openExternal: false,
        readFileChunk: false,
      },
    }
  }

  async startTransferService(_options: { title: string; text: string }): Promise<void> {
    /* no native shell */
  }

  async stopTransferService(): Promise<void> {
    /* no native shell */
  }

  async keepScreenAwake(_options: { enabled: boolean }): Promise<void> {
    /* no native shell */
  }

  async openExternal(options: { url: string }): Promise<void> {
    window.open(options.url, '_blank', 'noopener')
  }

  async shareFiles(_options: { paths: string[]; title?: string }): Promise<void> {
    /* no native shell */
  }

  async addListener(
    _eventName: 'fluxdrop:native',
    _listenerFunc: (event: FluxDropNativeEvent) => void
  ): Promise<{ remove: () => void }> {
    return { remove: () => undefined }
  }

  async removeAllListeners(): Promise<void> {
    /* no native shell */
  }
}
