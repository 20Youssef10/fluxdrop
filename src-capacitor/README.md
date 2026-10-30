# FluxDrop Android Shell (Capacitor) — v5-d12/d13

The mobile shell assets: a real Capacitor plugin (`@fluxdrop/capacitor-plugin`)
that owns everything the WebView can't do for itself, plus the app-side
manifest snippets that wire the OS to it.

| Shell feature | How |
|---|---|
| **Foreground transfer service** (v5-d13) | `ForegroundTransferService` — a `dataSync` FGS with a PARTIAL wake lock, started/stopped by the web side's transfer lifecycle (`use-native-resilience.ts` → `startTransferService`/`stopTransferService`). The notification doubles as the live status line ("Sending files…", "Verifying checksums…"). **Transfers survive a locked screen.** |
| **Share sheet IN** | `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intent filters → the plugin copies the streams into its cache and emits `fluxdrop:native {type:"open-files"}` — the web sender queue arms exactly like the Web Share Target flow. Text-only shares materialize as `.txt` files. |
| **Share sheet OUT** | `shareFiles({paths})` — `ACTION_SEND` with FileProvider URIs. |
| **`fluxdrop://` deep links** | `VIEW` intent filter → `fluxdrop:native {type:"deep-link", url}` → the same arming paths as web hash links. |
| **Keep screen awake** | `keepScreenAwake({enabled})` — `FLAG_KEEP_SCREEN_ON` on the activity (opt-in pref; the FGS keeps the transfer alive regardless). |
| **Cold-start replay** | `notifyListeners(..., retain = true)` — a share that LAUNCHED the app replays once the webview attaches its listener. |

## Build walkthrough

```bash
# repo root — web app deps
bun install

# capacitor CLI + android platform (once)
bun add -D @capacitor/cli && bunx cap add android

# install the local shell plugin
bun add file:./src-capacitor/plugin

# sync plugins + web assets into android/
bunx cap sync android

# wire the intent filters (deep link + share target)
#   → copy the blocks from src-capacitor/android-app-manifest-snippets.xml
#     into android/app/src/main/AndroidManifest.xml inside <activity .MainActivity>

# build / run
bunx cap open android      # Android Studio → Run
```

Notes:

- **Hosting**: `capacitor.config.ts` (repo root) defaults to
  `webDir: public` + `androidScheme: 'https'` (secure-context for
  crypto.subtle / OPFS / WebRTC). For the hosted-instance strategy,
  uncomment `server.url` — the plugin bridge still works; see
  `docs/mobile-shell.md` → "Hosting strategy".
- **Permissions**: FGS/WAKE_LOCK/POST_NOTIFICATIONS arrive via the plugin's
  manifest merge. On Android 13+ grant notification permission once (the web
  app's existing notification prompt covers it) — the service runs either
  way, the status notification is just hidden without it.
- **The web app never imports `@capacitor/core`**: it talks to
  `window.Capacitor.Plugins.FluxDropShell` at runtime
  (`src/lib/fluxdrop/native-bridge.ts`), so the browser build stays
  dependency-free. `plugin/index.ts` exists for standalone consumers.
- **iOS**: not covered by this plugin (see `docs/mobile-shell.md` for the
  honest limits — background execution on iOS is a different contract).

## Event contract

Both directions converge on ONE event, `fluxdrop:native`:

```jsonc
// OS → web (plugin notifyListeners, retained)
{ "type": "deep-link",  "url": "fluxdrop://join?room=AB12CD&pin=123456" }
{ "type": "open-files", "files": [{ "name": "cat.jpg", "size": 8192, "mime": "image/jpeg", "path": "/data/.../fluxdrop-shared/…-cat.jpg" }] }
```

```jsonc
// web → OS (plugin methods, called by the bridge)
startTransferService({ title: "FluxDrop", text: "Receiving files…" })
stopTransferService()
keepScreenAwake({ enabled: true })
openExternal({ url: "https://…" })
shareFiles({ paths: ["/data/…/cat.jpg"], title: "FluxDrop" })
```
