# FluxDrop mobile shells (Capacitor) — feature 7.1 / v5-d12+d13

> **Status: SHIPPED for Android (v5-d12/d13).** [`src-capacitor/plugin`](../src-capacitor/) is a complete Capacitor plugin: FluxDropShell (foreground transfer service with a partial wake lock — transfers survive a locked screen — share-sheet in/out, `fluxdrop://` intent deep links, keep-screen-awake). Build walkthrough: [`src-capacitor/README.md`](../src-capacitor/README.md). The web side talks through [`src/lib/fluxdrop/native-bridge.ts`](../src/lib/fluxdrop/native-bridge.ts) (browser-verifiable via `?shellSim=capacitor`). This guide remains the background/design doc.

FluxDrop's mobile story is deliberately boring: the app is already an installable PWA (Web Share Target, offline shell, service worker at `public/sw.js`). Capacitor wraps that same web codebase into store-distributable APKs/IPAs and gives it the two things a PWA can't do — **OS share-sheet entry everywhere** and **keep-awake/background notifications during transfer**.

---

## 1. Prerequisites

| Tool | Why | Notes |
|---|---|---|
| Node 20+ / bun | runs the Capacitor CLI | the repo's dev server is `next dev -p 3000` |
| Android Studio (Ladybug+) + JDK 17 | Android shell | SDK Platform 34+, Android SDK Build-Tools |
| Xcode 15+ (macOS only) | iOS shell | plus an Apple Developer account to sign/install |
| A hosted FluxDrop instance | recommended target | see [Hosting strategy](#3-hosting-strategy-pragmatic) — self-host via the one-command kit (`docker compose up`), or any deployment where the signaling gateway (port 3003) is reachable |

> Nothing in this repo's web build changes. The Next.js client, service worker and manifest stay exactly as they are.

## 2. Install Capacitor

```bash
# from the repo root — decide where you want the native projects to live.
# Nothing is installed in this scaffold; when you start:
npm install @capacitor/core
npm install -D @capacitor/cli
npm install @capacitor/android @capacitor/ios
```

**You do NOT need `npx cap init`.** The interactive init writes a `capacitor.config.ts` — the repo already ships one (appId `com.fluxdrop.app`, appName `FluxDrop`, `webDir: 'public'`, `server.androidScheme: 'https'`). Go straight to adding platforms:

```bash
npx cap add android   # generates android/ — add it to git
npx cap add ios       # generates ios/    — add it to git
npx cap sync          # copies webDir assets + plugins into the native projects
```

`androidScheme: 'https'` matters: FluxDrop depends on secure-context APIs (`crypto.subtle` for SHA-256/PAKE, `CompressionStream` for wire gzip, OPFS/IndexedDB for chunk storage, WebRTC itself), and it makes the local WebView origin secure on Android.

## 3. Hosting strategy (pragmatic)

Two ways to point the shell at web content, and only one of them we recommend for real builds:

### Option A — hosted instance via `server.url` (recommended, zero build changes)

Uncomment `server.url` in [`capacitor.config.ts`](../capacitor.config.ts):

```ts
server: {
  androidScheme: 'https',
  url: 'https://fluxdrop.example.com',   // your deployed instance
}
```

The native app becomes a thin frame over the **hosted** web client:

- ✅ zero changes to the Next.js build — the app always runs what you deployed
- ✅ signaling gateway, TURN credentials and protocol upgrades ship server-side, no app-review lag
- ✅ the PWA's own updates (service worker) reach the "app" immediately
- ⚠️ needs the network on first launch (consider a native splash + the existing `offline.html` fallback)
- ⚠️ Apple App Review: thin wrappers around a website can hit guideline 4.2 (minimum functionality) — the native value you add in §5–6 (share sheet, keep-awake, background notifications) is what justifies the shell. Be ready to demonstrate those in review notes.
- 🔐 only point at instances you control (the app's transport security inherits the URL's TLS) and keep `androidScheme: 'https'` for anything loaded locally

### Option B — bundled assets (`webDir`)

`npx cap sync` copies `public/` into the native project and serves it from `https://localhost`. That directory is the PWA shell (manifest, icons, `sw.js`, `offline.html`) — **not** a built Next.js app. Making bundling real would require a static export (`output: 'export'`) and absolute signaling/TURN URLs, which is a web-build change owned by the web-build agent — out of scope for this scaffold. If you go this route later, set `webDir` to the export output instead.

## 4. Share-sheet integration

### What already works (PWA path, no Capacitor)

The PWA manifest (`public/manifest.json`) declares a `share_target`:

```json
"share_target": {
  "action": "/share-target",
  "method": "POST",
  "enctype": "multipart/form-data",
  "params": { "files": [{ "name": "files", "accept": ["*/*"] }] }
}
```

The service worker (`public/sw.js`) receives the POST, stashes the files in IndexedDB under a one-time token and redirects to `/?shared=<token>`; the client-side handoff is `src/lib/fluxdrop/share-target.ts`. **When FluxDrop is installed as a PWA/WebAPK (Chrome on Android), the OS share sheet already lists it.** That path needs nothing from this scaffold.

### What the Capacitor APK needs (native path)

A Capacitor app is *not* a WebAPK, so Android won't offer it as a share target from the manifest alone. Add an intent filter to `android/app/src/main/AndroidManifest.xml` (after `npx cap add android`):

```xml
<intent-filter>
  <action android:name="android.intent.action.SEND" />
  <action android:name="android.intent.action.SEND_MULTIPLE" />
  <category android:name="android.intent.category.DEFAULT" />
  <data android:mimeType="*/*" />
</intent-filter>
```

Then either:

- keep `launchMode="singleTask"` and read the share extras in `onNewIntent` → forward them into the WebView (a small plugin or an existing community share-intent plugin), or
- use `@babel/plugin`-free simple approach: launch with the shared files staged where the web app can consume them — the existing `share-target.ts` flow can be driven by passing files through a JS bridge.

iOS has no system-wide share *target* for regular apps (that's an App Extension — a separate target with its own memory limits, ~120 MB, which is hostile to large files). The pragmatic iOS answer is the share **sheet inside** the app (`navigator.share` — already the PWA's export path) plus the Files-app "Open in FluxDrop" route via Document Types / LSSupportsOpeningDocumentsInPlace if you want it later.

## 5. Keep-awake + background transfer

Suggested plugin set (none installed yet):

| Need | Plugin | Notes |
|---|---|---|
| Keep the screen on during transfer | `@capacitor-community/keep-awake` (`KeepAwake.keepAwake()` / `.allowSleep()`) | pair with the client's `TRANSFERRING` state; restore `allowSleep()` on `COMPLETE/CANCELLED/FAILED` |
| Short finishing tasks when backgrounded | `@capacitor/background-task` (official) | gives ~30s after backgrounding — enough to auto-pause cleanly (the client already auto-pauses on lifecycle freeze, feature 7.3) and persist resume state |
| Long-running transfers while backgrounded (Android) | Foreground Service — e.g. `@capawesome/capacitor-android-foreground-service` or a small custom plugin | persistent notification + a wakelock is the only reliable Android pattern; pair with the WebRTC connection staying alive in the WebView |
| OS notifications on completion | `@capacitor/local-notifications` | fire on the `complete` event; notifications need user-visible value to survive review |

The honest architecture note: WebRTC runs in the WebView, so any "background transfer" plugin only works while the WebView process lives. On Android that's a foreground service keeping the app alive; on iOS see below.

## 6. Honest limitations

- **iOS background WebRTC is effectively unavailable.** When a WKWebView app is backgrounded, its JS suspends and DataChannel traffic stops — there is no supported API to keep it running (no silent audio trick is reliable or review-safe). The design answer is already in the product: auto-pause on background, persist resume bitmaps (24 h records, `RESUME_RECORD_TTL_MS`), resume on foreground. The iOS shell should present backgrounding as *pause*, not failure — a local notification ("Transfer paused — return to FluxDrop") is the right UX.
- **iOS memory pressure:** received chunks stream to OPFS precisely to stay RAM-bounded, but the share-sheet App Extension path (if ever built) has a hard ~120 MB limit — keep large files out of extensions.
- **Review risk (Apple 4.2):** a pure `server.url` wrapper with no native value-add can be rejected. The plugins in §5 are the functionality story.
- **Updates lag:** bundled assets (Option B) only change with app releases; the hosted strategy (Option A) sidesteps this entirely.
- **Camera/QR:** joining by QR scan works from the other device's browser — no plugin needed; if you want in-app scanning add `@capacitor-community/barcode-scanner` later.

## 7. Suggested order of work

1. Host an instance (or run the dev server + signaling locally with LAN access).
2. `npm i @capacitor/core && npm i -D @capacitor/cli @capacitor/android` → `npx cap add android`.
3. Set `server.url` to the instance → `npx cap sync android` → open in Android Studio → run.
4. Verify a desktop↔phone transfer through the shell (pairing → PAKE SAS → transfer → checksum).
5. Add the share intent filter (§4) and `keep-awake` (§5), then notifications.
6. iOS pass with pause-on-background UX (§6) — no background-transfer promises.

---

Related: [Desktop shell (Tauri)](./desktop-shell.md) · [JS SDK](./sdk.md) · [Protocol spec](./protocol-spec.md)
