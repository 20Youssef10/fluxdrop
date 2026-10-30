package app.fluxdrop.plugin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * v5-d13: keeps an ACTIVE TRANSFER alive when the screen locks.
 *
 * The web build auto-pauses on hidden/frozen (background tabs get throttled
 * or killed) — inside the Android shell this service flips that around:
 * a `dataSync` foreground service holds a PARTIAL wake lock, so the WebView
 * process (and the WebRTC DataChannel pipeline inside it) keeps running at
 * full speed with the screen off. Started/stopped from the web side by the
 * transfer lifecycle (src/lib/fluxdrop/use-native-resilience.ts through
 * FluxDropPlugin.startTransferService / stopTransferService).
 *
 * Re-calling [start] with a new status text updates the notification in
 * place (it re-delivers onStartCommand) — the tray line mirrors transfer
 * state: "Sending files…", "Verifying checksums…", "Transfer complete".
 */
class ForegroundTransferService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Transfer in progress"
        enterForeground(text)
        holdWakeLock()
        // NOT sticky: the service is bound to a live transfer session, not to
        // the OS. If the process dies, resume records (IndexedDB) carry it.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun enterForeground(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34+: a dataSync FGS MUST declare its type at startForeground.
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(text: String): Notification {
        // Prefer the app's launcher icon; fall back to the system download
        // glyph (this is a library — it owns no drawables of its own).
        val icon = applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.stat_sys_download
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(icon)
            .setContentTitle("FluxDrop")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Transfers",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Active transfer progress and status"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun holdWakeLock() {
        if (wakeLock?.isHeld == true) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fluxdrop:transfer").apply {
            setReferenceCounted(false)
            // Bounded (never orphans the device); each status refresh renews it.
            acquire(WAKE_TIMEOUT_MS)
        }
    }

    companion object {
        const val CHANNEL_ID = "fluxdrop_transfers"
        const val NOTIFICATION_ID = 0x465558 // "FUX"
        const val EXTRA_TEXT = "text"
        private const val WAKE_TIMEOUT_MS = 2L * 60 * 60 * 1000 // 2 h

        /** Start (or update — same entry point) the transfer service. */
        @JvmStatic
        fun start(context: Context, text: String) {
            val intent = Intent(context, ForegroundTransferService::class.java)
                .putExtra(EXTRA_TEXT, text)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (_: Exception) {
                // e.g. app in background without being in the foreground-start
                // window — the transfer still runs; next lifecycle call retries.
            }
        }

        @JvmStatic
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, ForegroundTransferService::class.java))
            } catch (_: Exception) { /* already gone */ }
        }
    }
}
