# FluxDrop desktop shell (Tauri) — feature 7.2

> **Status: scaffold.** [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json) + this guide are the deliverable; the Rust sources are intentionally absent (no Rust toolchain in the producing sandbox — [`src-tauri/README.md`](../src-tauri/README.md) explains how `npm create tauri-app` fills them in). The web codebase stays canonical.

Tauri wraps the existing web app in a native desktop frame (WebView2 on Windows, WebKit on macOS/Linux) at a fraction of an Electron bundle, and gives FluxDrop the two desktop-native affordances from FEATURES.md 7.2: a **system-tray "quick drop" target** and **native save dialogs**.

---

## 1. What the shipped config gives you

```jsonc
// src-tauri/tauri.conf.json (Tauri 2)
{
  "productName": "FluxDrop",
  "identifier": "com.fluxdrop.app",
  "build": {
    "beforeDevCommand": "bun run dev",          // starts `next dev -p 3000`
    "devUrl": "http://localhost:3000",          // window loads the dev server
    "frontendDist": "../public"                  // see note below
  },
  "app": {
    "windows": [{ "title": "FluxDrop", "width": 1100, "height": 780, "dragDropEnabled": false }]
  }
}
```

- **`devUrl http://localhost:3000`** — zero-friction dev loop: run `cargo tauri dev` from the repo root and the 1100×780 window shows the real app.
- **`frontendDist: "../public"`** — a placeholder that satisfies Tauri's required field. It points at the PWA shell, *not* a built Next.js app; see the hosting strategy below before relying on it for builds.
- **`dragDropEnabled: false`** — critical: FluxDrop's page uses HTML5 drag-and-drop (`full-page-drop-zone.tsx`). Tauri's native drop handler would swallow those events, so it's off for the main window and only enabled for the quick-drop window (§3).

## 2. Hosting strategy — same as mobile

Identical reasoning to [`docs/mobile-shell.md`](./mobile-shell.md) §3, with none of the review risk:

- **Dev** → `devUrl: http://localhost:3000` (shipped config).
- **Ship (recommended)** → point the window at a **hosted instance**: remove `devUrl`, set the window's `url` to `https://fluxdrop.example.com`. The binary becomes a thin, fast, always-in-the-tray frame over the deployed web client — updates ship server-side, signaling/TURN config never bakes into releases.
- **Ship (offline)** → requires a static export (`output: 'export'`) of the Next.js client plus absolute signaling/TURN URLs. That's a web-build change owned elsewhere; `frontendDist` would then point at the export directory. Until then, treat bundled mode as not available.

Caveats that come with the webview: whichever engine the host OS provides (WebView2 / WebKit) is the engine you get — test OPFS chunk storage and `crypto.subtle` on all three before promising parity. With the hosted strategy the app's own CSP governs; the shell adds none (`csp: null`).

## 3. System-tray "quick drop"

Concept: FluxDrop lives in the tray; dropping files on it (or "Quick Drop…" in the tray menu) opens a small always-on-top window that sends **without bringing the full app front-and-center**.

Implementation sketch (after generating the Rust side — see `src-tauri/README.md`):

1. **Tray** — Tauri 2's tray API (`tray-icon` crate feature in `Cargo.toml`; `TrayIconBuilder` in `lib.rs`). Menu: `Quick Drop…`, `Open FluxDrop`, `Pause all`, `Quit`. Icon states can mirror the app's connection state.
2. **Quick-drop window** — a second WebviewWindow (`label: "quickdrop"`, ~420×320, `alwaysOnTop: true`, `decorations: false`, **`dragDropEnabled: true`**). Native drops land in Rust (file *paths*, not bytes); forward them to the window's JS through an event, or read them with a `#[tauri::command]`.
3. **Sending** — reuse the app itself: the quick-drop page loads the same hosted instance with a query flag (e.g. `?quickdrop=1`), queues the files into the sender flow, and targets the **last paired room** (trusted-peer scopes from v1.3 make re-sends consent-free) or prompts with the room picker when no target is remembered. All transfer logic — manifest, chunking, PAKE, resume — stays in the web app; the shell only feeds it file handles.
4. **Consent** — the existing consent dialog / SAS verify flow must stay in the loop for new targets; quick drop is a convenience for *repeat, already-trusted* destinations.

Tray drops are macOS/Windows territory; Linux tray drop targets are WM-dependent — offer the menu item everywhere and native drop-target where it works.

## 4. Native save dialogs

The web client saves received files via the browser's download machinery (File System Access API where available, anchor fallback otherwise). Inside the shell, [`tauri-plugin-dialog`](https://v2.tauri.app/plugin/dialog/) is strictly nicer:

```bash
cargo add tauri-plugin-dialog          # Rust side
npm i @tauri-apps/plugin-dialog        # if invoked from JS
```

```jsonc
// capabilities/default.json
{ "permissions": ["core:default", "dialog:default", "dialog:allow-save"] }
```

```ts
import { save } from '@tauri-apps/plugin-dialog'
const target = await save({
  defaultPath: manifest.files[0].name,   // multi-file: default to a folder picker
  // then stream chunks to disk via @tauri-apps/plugin-fs with the dialog path
})
```

Pair it with `tauri-plugin-fs` (`fs:default` + scoped write permission to the chosen path) so multi-file transfers can pre-allocate and stream to a chosen folder — mirroring the OPFS streaming pipeline but landing in a user-visible location. The web app's existing save flow remains the fallback (detect `window.__TAURI_INTERNALS__` to branch).

## 5. Optional: OS share menus / deep links

`tauri-plugin-deep-link` registers a `fluxdrop://` scheme: room invites can become `fluxdrop://join?room=XXXX&pin=YYYY` links that focus the shell and deep-link into the join flow, and macOS Services / Windows "Share with" integration can build on the same entry point. This is the "optional" clause of 7.2 — nice, not required.

## 6. Suggested order of work

1. Generate the Rust side per `src-tauri/README.md`, keep the shipped `tauri.conf.json`.
2. `cargo tauri dev` against the local dev server; verify a desktop↔desktop transfer (pairing → PAKE SAS → transfer → checksum).
3. Add `tauri-plugin-dialog` + `fs` for native saves; branch on Tauri presence in the web client.
4. Tray + quick-drop window (always-on-top, native drop capture, `?quickdrop=1` UI variant).
5. Switch the window to the hosted instance; set up `tauri-plugin-updater` when you ship build artifacts.

---

Related: [Mobile shell (Capacitor)](./mobile-shell.md) · [JS SDK](./sdk.md) · [Protocol spec](./protocol-spec.md)
