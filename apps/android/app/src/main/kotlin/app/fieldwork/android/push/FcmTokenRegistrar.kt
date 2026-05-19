package app.fieldwork.android.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

object FcmTokenRegistrar {
    private const val preferencesName = "fieldwork_push_tokens"
    private const val pendingFcmTokenKey = "pending_fcm_token"

    fun queueToken(context: Context, token: String) {
        val normalized = token.trim()
        if (normalized.isEmpty()) {
            return
        }
        context.pushTokenPreferences().edit()
            .putString(pendingFcmTokenKey, normalized)
            .apply()
    }

    fun pendingToken(context: Context): String? {
        return context.pushTokenPreferences()
            .getString(pendingFcmTokenKey, null)
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
    }

    fun clearPendingToken(context: Context, token: String) {
        if (pendingToken(context) != token) {
            return
        }
        context.pushTokenPreferences().edit()
            .remove(pendingFcmTokenKey)
            .apply()
    }

    fun clearPendingToken(context: Context) {
        context.pushTokenPreferences().edit()
            .remove(pendingFcmTokenKey)
            .apply()
    }

    suspend fun currentToken(context: Context): String? {
        val appContext = context.applicationContext
        if (FirebaseApp.getApps(appContext).isEmpty()) {
            return null
        }

        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = true

        return suspendCancellableCoroutine { continuation ->
            val task = messaging.token
            task.addOnCompleteListener { completed ->
                if (!continuation.isActive) {
                    return@addOnCompleteListener
                }
                continuation.resume(if (completed.isSuccessful) completed.result else null)
            }
        }
    }

    private fun Context.pushTokenPreferences() =
        applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
}
