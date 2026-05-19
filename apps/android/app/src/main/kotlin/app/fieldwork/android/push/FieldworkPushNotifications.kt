package app.fieldwork.android.push

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
import app.fieldwork.android.MainActivity
import app.fieldwork.android.R

object FieldworkPushNotifications {
    const val CHANNEL_ID_AGENT_STATE = "fieldwork-agent-state"
    const val ACTION_OPEN_SESSION = "FIELDWORK_OPEN_SESSION"
    const val EXTRA_SESSION_ID_HASH = "session_id_hash"
    const val DATA_EVENT_TYPE = "event_type"

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
        if (!canPostNotifications(context)) {
            return
        }
        ensureChannels(context)
        if (data[DATA_EVENT_TYPE] != "awaiting_input") {
            return
        }
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
            .setContentTitle(context.getString(R.string.notification_awaiting_input_title))
            .setContentText(context.getString(R.string.notification_awaiting_input_body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        NotificationManagerCompat.from(context).notify(notificationId(sessionIdHash), notification)
    }

    fun sessionIdHash(intent: Intent?): String? {
        return sessionIdHashValue(intent?.getStringExtra(EXTRA_SESSION_ID_HASH))
    }

    internal fun sessionIdHashValue(value: String?): String? {
        val hash = value?.trim() ?: return null
        return hash.takeIf(::isSessionIdHash)
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
