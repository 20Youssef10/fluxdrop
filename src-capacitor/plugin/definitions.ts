/**
 * v5-d12/d13: FluxDropShell — typed surface of the FluxDrop Android shell
 * (Capacitor plugin). The PRODUCTION web client does NOT import this file:
 * it talks to the runtime proxy (`window.Capacitor.Plugins.FluxDropShell`)
 * from src/lib/fluxdrop/native-bridge.ts so the web build stays dependency-
 * free. These definitions exist for standalone consumers (and IDE truth).
 */

export interface FluxDropNativeSharedFile {
  name: string
  size: number
  mime: string
  /** Absolute path of the plugin's cache copy — fetch via Capacitor.convertFileSrc. */
  path: string
}

export type FluxDropNativeEvent =
  | { type: 'deep-link'; url: string }
  | { type: 'open-files'; files: FluxDropNativeSharedFile[] }

export interface FluxDropShellPlugin {
  /** Capability matrix for the Settings → Device shell card. */
  getShellInfo(): Promise<{ kind: string; platform: string; capabilities: Record<string, boolean> }>

  /** Start (or update the status text of) the foreground transfer service. */
  startTransferService(options: { title: string; text: string }): Promise<void>

  /** Stop the foreground transfer service (idle again). */
  stopTransferService(): Promise<void>

  /** Keep the screen on while a transfer runs (FLAG_KEEP_SCREEN_ON). */
  keepScreenAwake(options: { enabled: boolean }): Promise<void>

  /** Open an http(s) URL with the OS (ACTION_VIEW). */
  openExternal(options: { url: string }): Promise<void>

  /** Share absolute file paths through the OS share sheet (ACTION_SEND[_MULTIPLE]). */
  shareFiles(options: { paths: string[]; title?: string }): Promise<void>

  /** OS → web events: deep links + share-sheet/file-association opens. */
  addListener(
    eventName: 'fluxdrop:native',
    listenerFunc: (event: FluxDropNativeEvent) => void
  ): Promise<{ remove: () => void }>
  removeAllListeners(): Promise<void>
}
