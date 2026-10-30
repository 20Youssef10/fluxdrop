// v5-d12/d13: the FluxDrop DESKTOP SHELL (Tauri 2).
//
// What this shell owns (everything the browser tab can't do for itself):
//   • Tray icon with a live status line + Show/Quit menu (close → hide to
//     tray, so the transfer pipeline survives the window being closed).
//   • `fluxdrop://` deep links  → unified native events to the web side.
//   • File associations ("Open with FluxDrop") → argv paths are remembered
//     in a READ ALLOWLIST and forwarded to the web side, which pulls their
//     bytes chunk-by-chunk through `flux_read_file_chunk`. The webview can
//     only ever read files the OS explicitly handed us — never arbitrary
//     disk locations.
//   • `.fluxdrop` room-link files (tiny text files containing a
//     fluxdrop:// URL) are read here and routed as deep links.
//   • Autostart (hidden to tray, `--hidden`) via the autostart plugin.
//   • Single instance: a second launch focuses this one and forwards its
//     argv (deep link or associated files) instead of starting over.
//   • v5-d13: background resilience — the desktop process keeps running
//     when the screen locks or the window is hidden; the web side mirrors
//     transfer state onto the tray line via `flux_set_tray_status`.
//
// Event contract with the web side (src/lib/fluxdrop/native-bridge.ts):
//   Rust → web, event name `fluxdrop://native`, payload one of
//     { "type": "deep-link",  "url": "fluxdrop://join?room=X&pin=Y" }
//     { "type": "open-files", "files": [{ "path": "...", "name": "...", "size": n }] }

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::AutoLaunchExt;
use tauri_plugin_opener::OpenerExt;

/// Unified native→web event channel (the web bridge listens for exactly this).
const NATIVE_EVENT: &str = "fluxdrop://native";
const TRAY_ID: &str = "fluxdrop-main";

/// Handle to the tray's (disabled) status menu item, kept updatable from
/// web commands. MenuItem is a cheap cloneable handle.
struct TrayState {
    status: Mutex<MenuItem<tauri::Wry>>,
}

/// v5-d12 read allowlist: absolute paths the OS handed to FluxDrop (launch
/// argv, second-instance argv, file associations). `flux_read_file_chunk`
/// refuses anything outside this set — the webview can never use the bridge
/// as a generic disk reader.
struct OpenPaths(Mutex<HashSet<PathBuf>>);

impl OpenPaths {
    fn remember(&self, path: &PathBuf) {
        self.0.lock().unwrap().insert(path.clone());
    }
    fn permits(&self, path: &PathBuf) -> bool {
        self.0.lock().unwrap().contains(path)
    }
}

fn emit_native(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit(NATIVE_EVENT, payload);
}

// ---------------------------------------------------------------------------
// Commands (invoked by the web side through window.__TAURI__.core.invoke)

#[tauri::command]
fn flux_shell_info() -> serde_json::Value {
    serde_json::json!({
        "kind": "tauri",
        "platform": std::env::consts::OS,
        "capabilities": {
            "tray": true,
            "autostart": true,
            "deepLinks": true,
            "shareTarget": true,
            "shareOut": false,
            "foregroundService": false,
            "keepScreenAwake": true,
            "openExternal": true,
            "readFileChunk": true,
        },
    })
}

#[tauri::command]
fn flux_set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    autolaunch.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn flux_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// v5-d13: mirror transfer state onto the tray (status menu item + tooltip).
#[tauri::command]
fn flux_set_tray_status(app: AppHandle, state: tauri::State<TrayState>, text: String) -> Result<(), String> {
    let short: String = text.chars().take(48).collect();
    state
        .status
        .lock()
        .map_err(|e| e.to_string())?
        .set_text(short)
        .map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("FluxDrop — {short}")));
    }
    Ok(())
}

#[tauri::command]
fn flux_open_external(app: AppHandle, url: String) -> Result<(), String> {
    // http(s) only — this must never become a file:// / scheme launcher.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs are opened externally".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Chunked read of an OS-handed file for the web side. Allowlisted paths
/// only (see OpenPaths), 4 MiB max per chunk, reads past EOF clamp to the
/// file's remaining bytes; a fully-out-of-range offset returns empty.
#[tauri::command]
fn flux_read_file_chunk(
    app: AppHandle,
    path: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    const MAX_CHUNK: u64 = 4 * 1024 * 1024;

    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("open {path}: {e}"))?;
    if !app.state::<OpenPaths>().permits(&canonical) {
        return Err("path was not opened with FluxDrop".into());
    }

    let mut file = File::open(&canonical).map_err(|e| format!("open {path}: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if offset >= len {
        return Ok(Response::new(Vec::new()));
    }
    let to_read = length.min(MAX_CHUNK).min(len - offset);
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; to_read as usize];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(Response::new(buf))
}

// ---------------------------------------------------------------------------
// Launch plumbing

/// Route argv-style strings:
///   • `--flags` (incl. our own `--hidden`) are skipped.
///   • `fluxdrop://…` URLs become deep-link events.
///   • existing FILES are remembered in the read allowlist and forwarded as
///     an open-files event. `.fluxdrop` room-link files are unwrapped here:
///     their (≤ 4 KiB) text content is the actual fluxdrop:// URL.
fn handle_launch_args(app: &AppHandle, args: impl Iterator<Item = String>) {
    let mut files: Vec<serde_json::Value> = Vec::new();
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        if arg.starts_with("fluxdrop://") {
            emit_native(app, serde_json::json!({ "type": "deep-link", "url": arg }));
            continue;
        }
        let path = PathBuf::from(&arg);
        let meta = match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };

        // .fluxdrop room-link file → read the URL inside and route as a link.
        let is_link_file = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("fluxdrop"))
            .unwrap_or(false);
        if is_link_file && meta.len() <= 4096 {
            let mut content = String::new();
            if File::open(&path)
                .and_then(|mut f| f.read_to_string(&mut content))
                .is_ok()
            {
                let trimmed = content.trim().to_string();
                if trimmed.starts_with("fluxdrop://") {
                    emit_native(
                        app,
                        serde_json::json!({ "type": "deep-link", "url": trimmed }),
                    );
                    continue;
                }
            }
        }

        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        app.state::<OpenPaths>().remember(&canonical);
        files.push(serde_json::json!({
            "path": path.to_string_lossy(),
            "name": path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
            "size": meta.len(),
        }));
    }
    if !files.is_empty() {
        emit_native(app, serde_json::json!({ "type": "open-files", "files": files }));
    }
}

// ---------------------------------------------------------------------------
// Entry

pub fn run() {
    tauri::Builder::default()
        // MUST be registered first: a second launch focuses this instance and
        // forwards its argv (deep link / associated files) instead of racing.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            handle_launch_args(app, argv.into_iter().skip(1));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            flux_shell_info,
            flux_set_autostart,
            flux_autostart_enabled,
            flux_set_tray_status,
            flux_open_external,
            flux_read_file_chunk,
        ])
        .setup(|app| {
            // The read allowlist must exist before any launch args route through it.
            app.manage(OpenPaths(Mutex::new(HashSet::new())));

            // ---- Tray: Show / status / Quit --------------------------------
            let show = MenuItem::with_id(app, "show", "Show FluxDrop", true, None::<&str>)?;
            let status = MenuItem::with_id(app, "status", "Idle", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit FluxDrop", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &sep, &status, &quit])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("FluxDrop — Idle")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            app.manage(TrayState {
                status: Mutex::new(status),
            });

            // ---- Deep links: fluxdrop:// → unified native event -------------
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    emit_native(
                        &handle,
                        serde_json::json!({ "type": "deep-link", "url": url.to_string() }),
                    );
                }
            });
            // Runtime scheme registration (Windows registry / Linux desktop
            // file). macOS needs the scheme in Info.plist at build time —
            // see src-tauri/README.md → "Deep links on macOS".
            let _ = app.deep_link().register_all();

            // ---- Launch args: --hidden (autostart) + file associations ------
            let args: Vec<String> = std::env::args().skip(1).collect();
            let hidden = args.iter().any(|a| a == "--hidden");
            handle_launch_args(app.handle(), args.into_iter());
            if hidden {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // v5-d13: close → hide to tray. The process (and any live transfer
            // pipeline) stays alive; "Quit" on the tray is the real exit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running FluxDrop desktop shell");
}
