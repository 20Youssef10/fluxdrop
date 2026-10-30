# FluxDrop Desktop Shell (Tauri 2) — v5-d12/d13

A real, buildable Tauri 2 project — not a scaffold anymore. It wraps the
FluxDrop web app and adds everything a browser tab can't do for itself:

| Shell feature | How |
|---|---|
| **Tray + live status** | Rust-built tray (`fluxdrop-main`): *Show FluxDrop*, a disabled status item, *Quit*. The web side mirrors transfer state onto it (`flux_set_tray_status`) — "Sending files…", "Verifying checksums…", "Transfer complete". |
| **Close → hide to tray** | `CloseRequested` is prevented and the window hides. The process — and any live transfer pipeline — survives the window being closed (v5-d13). *Quit* on the tray is the real exit. |
| **Autostart** | `tauri-plugin-autostart`, exposed to the web via `flux_set_autostart` / `flux_autostart_enabled`. Autostart launches with `--hidden` (straight to tray). |
| **`fluxdrop://` deep links** | `tauri-plugin-deep-link` (scheme: `fluxdrop`). `fluxdrop://join?room=X&pin=Y` arms the receiver; `…/claim?…` arms a kiosk send; `…/open` just focuses. Runtime registration on Windows/Linux; macOS needs the scheme in Info.plist (below). |
| **File associations** | "Open with FluxDrop" for common image/video/document types + `.fluxdrop` room-link files. Handed paths land in a **read allowlist**; the web side pulls their bytes chunk-wise through `flux_read_file_chunk` (4 MiB max per chunk, 64 MiB per file, allowlisted paths ONLY — the webview can never use the bridge as a generic disk reader). |
| **`.fluxdrop` room-link files** | Tiny text files whose content is a `fluxdrop://…` URL — unwrapped by the shell and routed as a deep link. |
| **Single instance** | A second launch focuses the running instance and forwards its argv (deep link / associated files) instead of starting over. |
| **Unified event channel** | Everything native → web rides ONE Tauri event, `fluxdrop://native`, with payloads `{type:"deep-link",url}` / `{type:"open-files",files:[{path,name,size}]}`. The web contract lives in `src/lib/fluxdrop/native-bridge.ts`. |

## Prerequisites

- Rust 1.77.2+ (https://rustup.rs)
- Platform webview deps: Linux `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev` · Windows: WebView2 (preinstalled on 10/11) · macOS: Xcode CLT
- Bun + the web app deps (`bun install` at repo root)

## Run / build

```bash
bun install                 # repo root (web app deps)
cargo tauri dev             # or: bunx @tauri-apps/cli dev
cargo tauri build           # bundles for your OS (targets: "all")
```

`beforeDevCommand` runs `bun run dev` (Next.js on :3000) and the window loads
`devUrl`. For **production**, the web app is a Next.js server — point the main
window at your deployed instance (`app.windows[0].url`) or keep the bundled
static shell in `frontendDist` for the PWA-only subset. See
`docs/desktop-shell.md` → "Hosting strategy" for the trade-offs.

## Deep links on macOS

Runtime `register_all()` covers Windows (registry) and Linux (desktop file).
macOS requires the scheme at **build** time — append to the bundle's
`Info.plist` (or `bundle.macOS.infoPlist` in tauri.conf.json):

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key><string>com.fluxdrop.app</string>
    <key>CFBundleURLSchemes</key><array><string>fluxdrop</string></array>
  </dict>
</array>
```

## Icons

`src-tauri/icons/` is committed (PNG 32/128/256/512, `icon.ico`,
`icon.icns`, plus the `icon.svg` source). Regenerate the whole set with:

```bash
bun scripts/gen-shell-icons.mjs          # committed formats
bunx @tauri-apps/cli icon src-tauri/icons/icon.svg   # full platform set
```

## Trust notes (read before hosting remotely)

- `flux_read_file_chunk` only serves paths **the OS handed to FluxDrop**
  (allowlisted at argv/second-instance time). Pointing the window at a
  remote instance still means that page can only read files the user
  explicitly opened with the app — but if you don't need file associations
  in that deployment, delete the command from `lib.rs` + `invoke_handler`.
- `flux_open_external` accepts http(s) URLs only.
- `withGlobalTauri` is on because the web bridge uses `window.__TAURI__`
  (core.invoke + event.listen) without any npm dependency — keep it on.
