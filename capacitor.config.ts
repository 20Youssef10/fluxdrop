// Capacitor configuration for the FluxDrop mobile shell (feature 7.1 / v5-d12).
//
// This file ALREADY satisfies `npx cap init` — no interactive init is needed;
// after installing the CLI + platform packages you can run `npx cap add android`
// / `npx cap add ios` directly. Full walkthrough: src-capacitor/README.md
// (the FluxDropShell plugin lives in src-capacitor/plugin — install it with
// `bun add file:./src-capacitor/plugin`, then `bunx cap sync android`).
//
// Strategy in one line: the web codebase stays canonical — the native shell
// points at the SAME PWA assets (`webDir: 'public'`) or, the pragmatic
// default for real builds, at a HOSTED instance via `server.url` (uncomment
// below) so the app always runs the deployed web client with zero build
// changes. See docs/mobile-shell.md → "Hosting strategy".

// Minimal structural mirror of @capacitor/cli's `CapitorConfig` for the
// fields this config uses — declared locally (NOT imported) so the root
// project keeps typechecking without @capacitor/cli installed: no
// dependencies are added to the root package.json for this scaffold, and
// Next.js type-checks every .ts file in the tsconfig include.
// Once you install the CLI (docs/mobile-shell.md §2), feel free to swap
// this interface for:  import type { CapacitorConfig } from '@capacitor/cli'
interface CapacitorConfig {
  appId: string
  appName: string
  /** Directory (relative to repo root) with the web assets to bundle. */
  webDir: string
  server?: {
    /** Scheme used to serve local assets inside the WebView. */
    androidScheme?: string
    /** Hosted-instance strategy: load this URL instead of local assets. */
    url?: string
  }
}

const config: CapacitorConfig = {
  appId: 'com.fluxdrop.app',
  appName: 'FluxDrop',
  // The PWA's static shell (manifest, icons, sw.js, offline fallback).
  // Capacitor requires a webDir even when server.url points elsewhere.
  webDir: 'public',
  server: {
    // Serve local assets from https://localhost inside the WebView (required
    // for secure-context APIs FluxDrop depends on: crypto.subtle,
    // CompressionStream, IndexedDB/OPFS, WebRTC).
    androidScheme: 'https',
    // PRAGMATIC HOSTING STRATEGY — point the shell at a deployed FluxDrop
    // instance instead of bundling assets. Uncomment and set your instance:
    //
    //   url: 'https://fluxdrop.example.com',
    //
    // Zero build changes needed; the shell becomes a thin native frame over
    // the hosted PWA (share-sheet/keep-awake plugins still bridge through).
    // Caveats in docs/mobile-shell.md → "Hosting strategy".
  },
}

export default config
