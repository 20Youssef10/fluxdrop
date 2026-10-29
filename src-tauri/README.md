# FluxDrop desktop shell (Tauri) — `src-tauri/`

> **Status: config + docs only (scaffold).** The Rust toolchain is not available in the sandbox where this scaffold was produced, so this directory intentionally contains **no Rust sources** — `tauri.conf.json` plus this README are the deliverable. Concept + integration guide: [`../docs/desktop-shell.md`](../docs/desktop-shell.md).

## What's here

| File | Purpose |
|---|---|
| `tauri.conf.json` | Tauri 2 config: productName `FluxDrop`, identifier `com.fluxdrop.app`, 1100×780 main window, `devUrl http://localhost:3000` (the Next.js dev server), `frontendDist: "../public"` |
| this README | how to generate the missing Rust side and wire it up |

### Config notes (JSON can't carry comments)

- **`devUrl: http://localhost:3000`** — during `cargo tauri dev` the window loads the repo's Next.js dev server (`bun run dev` via `beforeDevCommand`). Remove `beforeDevCommand`/`devUrl` and set the window's `url` to your hosted instance for the production hosted-URL strategy (see `../docs/desktop-shell.md`).
- **`frontendDist: "../public"`** — Tauri requires a directory even when a dev/remote URL is used. `../public` is the PWA shell (icons, manifest, `sw.js`, `offline.html`); it keeps `tauri build` structurally happy but is **not** a built Next.js app. Bundling a real offline client would require a static export (`output: 'export'`) — a web-build decision outside this scaffold's scope; until then the hosted-URL strategy is the path.
- **`dragDropEnabled: false`** — FluxDrop's web UI implements HTML5 drag-and-drop drop zones (`src/components/fluxdrop/full-page-drop-zone.tsx`). Tauri's *native* drag-drop handler would swallow those events before the page sees them, so it is disabled on the main window. The tray "quick drop" window (see docs) is where the native handler gets *enabled*, because that window forwards dropped file paths to Rust.
- **`security.csp: null`** — the hosted FluxDrop instance ships its own CSP; the shell adds none.

## Generating the Rust side

`npm create tauri-app` scaffolds exactly the files missing here (choose the **Vanilla / TypeScript** template — the web content is the existing Next.js app or a hosted URL, not a new frontend):

```text
src-tauri/
├── Cargo.toml          # tauri = { version = "2", features = ["tray-icon"] } once you add the tray
├── build.rs            # tauri-build
├── icons/              # default.png + platform formats (or generate from public/icons via `cargo tauri icon ../public/icons/icon-512.png`)
├── capabilities/
│   └── default.json    # permissions — add "dialog:default" (+ "dialog:allow-save") when you add the save-dialog plugin
├── src/
│   ├── main.rs         # fn main() { fluxdrop_lib::run() }
│   └── lib.rs          # #[cfg_attr(mobile, tauri::mobile_entry_point)] pub fn run() { tauri::Builder... }
└── tauri.conf.json     # ← keep THIS file (replace the generated one)
```

To integrate:

1. Run `npm create tauri-app@latest fluxdrop-tmp -- --template vanilla-ts` somewhere scratch.
2. Copy `src/`, `Cargo.toml`, `build.rs`, `.gitignore` and `capabilities/` from the generated `fluxdrop-tmp/src-tauri/` into this directory — **keep the `tauri.conf.json` that is already here**.
3. Generate icons from the app's own: `cargo tauri icon ../public/icons/icon-512.png`.
4. From the **repo root** (Tauri expects to run from there; the `src-tauri` dir is picked up by convention):

```bash
bun run dev &            # or rely on beforeDevCommand
cargo tauri dev          # window opens on http://localhost:3000

cargo tauri build         # bundles installers (bundle.targets: "all")
```

If you prefer not to install the Rust CLI globally: `npm i -D @tauri-apps/cli` and run `npx tauri dev` / `npx tauri build` instead.

## Adding the desktop features (pointers)

Each of these needs matching `capabilities/default.json` permission entries — the walkthrough lives in [`../docs/desktop-shell.md`](../docs/desktop-shell.md):

- **System tray "quick drop"** — Tauri 2 tray API (`tray-icon` crate feature) + a small always-on-top window that collects native drops.
- **Native save dialogs** — [`tauri-plugin-dialog`](https://v2.tauri.app/plugin/dialog/) (`dialog:default`, `dialog:allow-save`) instead of the browser's File System Access API.
- **Deep links / OS share menus** — `tauri-plugin-deep-link` with a `fluxdrop://` scheme.
- **Auto-update** — `tauri-plugin-updater` once there are signed artifacts to ship.
