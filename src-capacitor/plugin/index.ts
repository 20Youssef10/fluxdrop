import { registerPlugin } from '@capacitor/core'
import type { FluxDropShellPlugin } from './definitions'

/**
 * Standalone registration (bundled consumers). NOTE: the FluxDrop web app
 * itself does NOT import this — it probes window.Capacitor at runtime
 * (src/lib/fluxdrop/native-bridge.ts) to keep the web build dependency-free.
 */
const FluxDropShell = registerPlugin<FluxDropShellPlugin>('FluxDropShell', {
  web: () => import('./web').then((m) => m.FluxDropShellWeb),
})

export * from './definitions'
export { FluxDropShell }
