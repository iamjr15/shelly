package app.shelly.android.push

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.result.ActivityResultLauncher
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.shelly.android.MainActivity
import app.shelly.android.R
import app.shelly.android.ui.ShellyUiPreferences
import java.util.Calendar

object ShellyPushNotifications {
    const val CHANNEL_ID_AGENT_STATE = "shelly-agent-state"
    const val ACTION_OPEN_SESSION = "SHELLY_OPEN_SESSION"
    const val EXTRA_SESSION_ID_HASH = "session_id_hash"
    const val DATA_EVENT_TYPE = "event_type"

    // Values of the [DATA_EVENT_TYPE] payload key the FCM service routes on.
    const val EVENT_AWAITING_INPUT = "awaiting_input"
    const val EVENT_SESSION_CRASHED = "session_crashed"
    const val EVENT_BUILD_FINISHED = "build_finished"

    private val defaultHourOfDay: () -> Int = { Calendar.getInstance().get(Calendar.HOUR_OF_DAY) }

    /** Local hour-of-day (0–23) used to evaluate quiet hours; overridable for tests. */
    internal var currentHourOfDay: () -> Int = defaultHourOfDay

    internal fun resetClockForTests() {
        currentHourOfDay = defaultHourOfDay
    }

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val channel = NotificationChannel(
            CHANNEL_ID_AGENT_STATE,
            context.getString(R.string.notification_channel_agent_state),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.notification_channel_agent_state_description)
            lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    fun requestPermissionIfNeeded(
        activity: Activity,
        launcher: ActivityResultLauncher<String>,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    fun showAwaitingInput(context: Context, data: Map<String, String>) {
        if (data[DATA_EVENT_TYPE] != EVENT_AWAITING_INPUT) {
            return
        }
        val prefs = ShellyUiPreferences(context)
        if (suppressed(prefs, typeEnabled = prefs.readNotifyAwaitingInput())) {
            return
        }
        postSessionNotification(
            context,
            data,
            title = context.getString(R.string.notification_awaiting_input_title),
            body = context.getString(R.string.notification_awaiting_input_body),
        )
    }

    fun showSessionCrashed(context: Context, data: Map<String, String>) {
        if (data[DATA_EVENT_TYPE] != EVENT_SESSION_CRASHED) {
            return
        }
        val prefs = ShellyUiPreferences(context)
        if (suppressed(prefs, typeEnabled = prefs.readNotifySessionCrashed())) {
            return
        }
        postSessionNotification(
            context,
            data,
            title = context.getString(R.string.notification_session_crashed_title),
            body = context.getString(R.string.notification_session_crashed_body),
        )
    }

    fun showBuildFinished(context: Context, data: Map<String, String>) {
        if (data[DATA_EVENT_TYPE] != EVENT_BUILD_FINISHED) {
            return
        }
        val prefs = ShellyUiPreferences(context)
        if (suppressed(prefs, typeEnabled = prefs.readNotifyBuildFinished())) {
            return
        }
        postSessionNotification(
            context,
            data,
            title = context.getString(R.string.notification_build_finished_title),
            body = context.getString(R.string.notification_build_finished_body),
        )
    }

    fun sessionIdHash(intent: Intent?): String? {
        return sessionIdHashValue(intent?.getStringExtra(EXTRA_SESSION_ID_HASH))
    }

    internal fun sessionIdHashValue(value: String?): String? {
        val hash = value?.trim() ?: return null
        return hash.takeIf(::isSessionIdHash)
    }

    // Quiet hours + the push master switch gate every type; the per-type switch gates its own.
    private fun suppressed(prefs: ShellyUiPreferences, typeEnabled: Boolean): Boolean {
        if (!prefs.readPushEnabled()) {
            return true
        }
        if (!typeEnabled) {
            return true
        }
        return prefs.readQuietHours().contains(currentHourOfDay())
    }

    // Shared builder for the session-scoped notifications: same channel, privacy, and tap target;
    // only the title/body differ per event type. Generic copy keeps terminal contents off the
    // lock screen.
    private fun postSessionNotification(
        context: Context,
        data: Map<String, String>,
        title: String,
        body: String,
    ) {
        if (!canPostNotifications(context)) {
            return
        }
        ensureChannels(context)
        val sessionIdHash = data[EXTRA_SESSION_ID_HASH]?.takeIf(::isSessionIdHash) ?: return
        val intent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN_SESSION
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_SESSION_ID_HASH, sessionIdHash)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            notificationId(sessionIdHash),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_AGENT_STATE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(context).notify(notificationId(sessionIdHash), notification)
    }

    private fun canPostNotifications(context: Context): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun notificationId(sessionIdHash: String): Int {
        return sessionIdHash.hashCode()
    }

    internal fun isSessionIdHash(value: String): Boolean {
        return value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }
    }
}
