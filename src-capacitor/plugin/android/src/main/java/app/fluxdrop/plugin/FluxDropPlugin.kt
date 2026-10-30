package app.fluxdrop.plugin

import android.content.Intent
import android.net.Uri
import android.view.WindowManager
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * v5-d12/d13: the FluxDrop ANDROID SHELL bridge (Capacitor plugin).
 *
 * Web-side surface (called through window.Capacitor.Plugins.FluxDropShell —
 * see src/lib/fluxdrop/native-bridge.ts):
 *   • startTransferService / stopTransferService — ForegroundTransferService
 *     (partial wake lock + dataSync notification) driven by the transfer
 *     lifecycle, so transfers survive a locked screen.
 *   • keepScreenAwake — FLAG_KEEP_SCREEN_ON on the activity.
 *   • openExternal / shareFiles — ACTION_VIEW / ACTION_SEND(MULTIPLE) via a
 *     FileProvider.
 *   • getShellInfo — capability matrix for the Settings → Device card.
 *
 * OS → web events (notifyListeners "fluxdrop:native", retained so a cold
 * start replays them once the webview attaches):
 *   { type: "deep-link",  url: "fluxdrop://join?room=X&pin=Y" }
 *   { type: "open-files", files: [{ name, size, mime, path }] }
 * from the share sheet (ACTION_SEND / SEND_MULTIPLE), fluxdrop:// intent
 * filters, and ACTION_VIEW file opens. Shared content is COPIED into the
 * plugin's cache dir; the web side fetches those paths with
 * Capacitor.convertFileSrc.
 */
@CapacitorPlugin(name = "FluxDropShell")
class FluxDropPlugin : Plugin() {

    // ------------------------------------------------------------------
    // Web bridge surface
    // ------------------------------------------------------------------

    @PluginMethod
    fun getShellInfo(call: PluginCall) {
        val caps = JSObject()
        caps.put("tray", false)
        caps.put("autostart", false)
        caps.put("deepLinks", true)
        caps.put("shareTarget", true)
        caps.put("shareOut", true)
        caps.put("foregroundService", true)
        caps.put("keepScreenAwake", true)
        caps.put("openExternal", true)
        caps.put("readFileChunk", false)
        val info = JSObject()
        info.put("kind", "capacitor")
        info.put("platform", "android")
        info.put("capabilities", caps)
        call.resolve(info)
    }

    @PluginMethod
    fun startTransferService(call: PluginCall) {
        val text = call.getString("text") ?: "Transfer in progress"
        val ctx = context ?: return call.reject("no context")
        ForegroundTransferService.start(ctx, text)
        call.resolve()
    }

    @PluginMethod
    fun stopTransferService(call: PluginCall) {
        val ctx = context ?: return call.reject("no context")
        ForegroundTransferService.stop(ctx)
        call.resolve()
    }

    @PluginMethod
    fun keepScreenAwake(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        val act = activity
        if (act == null) {
            call.resolve()
            return
        }
        act.runOnUiThread {
            if (enabled) {
                it.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                it.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun openExternal(call: PluginCall) {
        val url = call.getString("url")
        // http(s) only — never a file:// or arbitrary scheme launcher.
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            return call.reject("only http(s) urls are opened externally")
        }
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            (activity ?: context).startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("open failed", e)
        }
    }

    @PluginMethod
    fun shareFiles(call: PluginCall) {
        val paths = call.getArray("paths")
        if (paths == null || paths.length() == 0) {
            return call.reject("paths required")
        }
        val title = call.getString("title") ?: "FluxDrop"
        try {
            val uris = ArrayList<Uri>()
            for (i in 0 until paths.length()) {
                val f = File(paths.getString(i))
                uris.add(
                    FileProvider.getUriForFile(
                        context,
                        context.packageName + ".fluxdrop.fileprovider",
                        f
                    )
                )
            }
            val intent = if (uris.size == 1) {
                Intent(Intent.ACTION_SEND).apply {
                    type = intentTypeFor(uris[0])
                    putExtra(Intent.EXTRA_STREAM, uris[0])
                }
            } else {
                Intent(Intent.ACTION_SEND_MULTIPLE).apply {
                    type = "*/*"
                    putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                }
            }
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            (activity ?: context).startActivity(
                Intent.createChooser(intent, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            call.resolve()
        } catch (e: Exception) {
            call.reject("share failed", e)
        }
    }

    // ------------------------------------------------------------------
    // OS → web events (share sheet, deep links, file opens)
    // ------------------------------------------------------------------

    override fun load() {
        super.load()
        sweepStaleShares()
        // Cold start: the launch intent (share sheet / deep link) is still
        // attached to the activity — route it exactly like onNewIntent would.
        // notifyListeners(..., retain = true) replays to the webview once it
        // attaches its listeners.
        bridge.activity?.intent?.let { handleShellIntent(it) }
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        handleShellIntent(intent)
    }

    private fun handleShellIntent(intent: Intent?) {
        if (intent == null) return
        try {
            when (intent.action) {
                Intent.ACTION_SEND -> handleSend(intent)
                Intent.ACTION_SEND_MULTIPLE -> handleSendMultiple(intent)
                Intent.ACTION_VIEW -> handleView(intent)
            }
        } catch (_: Exception) {
            // Never crash the shell over a malformed share.
        }
    }

    private fun handleSend(intent: Intent) {
        @Suppress("DEPRECATION")
        val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        if (uri != null) {
            stashShared(uri)?.let { file ->
                notifyListeners(NATIVE_EVENT, openFilesEvent(listOf(file)), true)
            }
            return
        }
        // Text-only share: materialize it as a .txt so it flows through the
        // exact same sender-queue path as shared files.
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        if (!text.isNullOrBlank()) {
            stashText(text)?.let { file ->
                notifyListeners(NATIVE_EVENT, openFilesEvent(listOf(file)), true)
            }
        }
    }

    private fun handleSendMultiple(intent: Intent) {
        @Suppress("DEPRECATION")
        val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: return
        val files = uris.mapNotNull { stashShared(it) }
        if (files.isNotEmpty()) {
            notifyListeners(NATIVE_EVENT, openFilesEvent(files), true)
        }
    }

    private fun handleView(intent: Intent) {
        val data = intent.data ?: return
        if (data.scheme == "fluxdrop") {
            val payload = JSObject()
            payload.put("type", "deep-link")
            payload.put("url", data.toString())
            notifyListeners(NATIVE_EVENT, payload, true)
        } else {
            // File association open (ACTION_VIEW of content:// / file://).
            stashShared(data)?.let { file ->
                notifyListeners(NATIVE_EVENT, openFilesEvent(listOf(file)), true)
            }
        }
    }

    // ------------------------------------------------------------------
    // Shared-content stashing (cache copies the WebView can fetch)
    // ------------------------------------------------------------------

    private fun shareDir(): File = File(context.cacheDir, SHARE_DIR).apply { mkdirs() }

    private fun sweepStaleShares() {
        try {
            val cutoff = System.currentTimeMillis() - STALE_MS
            shareDir().listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
        } catch (_: Exception) { /* best effort */ }
    }

    /** Copy a content URI into the plugin cache so the WebView can File-ify it. */
    private fun stashShared(uri: Uri): JSObject? {
        return try {
            val name = queryDisplayName(uri)
            val target = File(shareDir(), "${System.currentTimeMillis()}-$name")
            context.contentResolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { input.copyTo(it) }
            } ?: return null
            fileEntry(
                name,
                target.length(),
                try { context.contentResolver.getType(uri) } catch (_: Exception) { null }
                    ?: guessMime(name),
                target.absolutePath
            )
        } catch (_: Exception) {
            null
        }
    }

    private fun stashText(text: String): JSObject? {
        return try {
            val name = "fluxdrop-note-${System.currentTimeMillis()}.txt"
            val target = File(shareDir(), name)
            target.writeText(text)
            fileEntry(name, target.length(), "text/plain", target.absolutePath)
        } catch (_: Exception) {
            null
        }
    }

    private fun queryDisplayName(uri: Uri): String {
        try {
            context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx >= 0 && cursor.moveToFirst()) {
                    cursor.getString(idx)?.let { return it }
                }
            }
        } catch (_: Exception) { /* fall through */ }
        return uri.lastPathSegment ?: "shared-file"
    }

    private fun fileEntry(name: String, size: Long, mime: String, path: String): JSObject {
        val o = JSObject()
        o.put("name", name)
        o.put("size", size)
        o.put("mime", mime)
        o.put("path", path)
        return o
    }

    private fun openFilesEvent(files: List<JSObject>): JSObject {
        val arr = JSArray()
        files.forEach { arr.put(it) }
        val payload = JSObject()
        payload.put("type", "open-files")
        payload.put("files", arr)
        return payload
    }

    private fun intentTypeFor(uri: Uri): String =
        try { context.contentResolver.getType(uri) ?: "*/*" } catch (_: Exception) { "*/*" }

    private fun guessMime(name: String): String {
        return when (name.substringAfterLast('.', "").lowercase()) {
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "mp4" -> "video/mp4"
            "webm" -> "video/webm"
            "mov" -> "video/quicktime"
            "pdf" -> "application/pdf"
            "txt" -> "text/plain"
            "zip" -> "application/zip"
            else -> "application/octet-stream"
        }
    }

    companion object {
        /** Must match the event name in src/lib/fluxdrop/native-bridge.ts. */
        const val NATIVE_EVENT = "fluxdrop:native"
        private const val SHARE_DIR = "fluxdrop-shared"
        private const val STALE_MS = 24L * 60 * 60 * 1000
    }
}
