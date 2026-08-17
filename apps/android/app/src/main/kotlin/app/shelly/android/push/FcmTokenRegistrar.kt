package app.shelly.android.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

object FcmTokenRegistrar {
    private const val preferencesName = "shelly_push_tokens"
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

    suspend fun currentToken(context: Context, enableAutoInit: Boolean = false): String? {
        val messaging = messagingOrNull(context) ?: return null
        if (enableAutoInit) {
            messaging.isAutoInitEnabled = true
        }

        return withTimeoutOrNull(TOKEN_OPERATION_TIMEOUT_MILLIS) {
            suspendCancellableCoroutine { continuation ->
                val task = messaging.token
                task.addOnCompleteListener { completed ->
                    if (!continuation.isActive) {
                        return@addOnCompleteListener
                    }
                    continuation.resume(if (completed.isSuccessful) completed.result else null)
                }
            }
        }
    }

    fun restorePrivacyDefault(context: Context) {
        messagingOrNull(context)?.isAutoInitEnabled = false
    }

    suspend fun deleteCurrentToken(context: Context) {
        val messaging = messagingOrNull(context) ?: return
        withTimeoutOrNull(TOKEN_OPERATION_TIMEOUT_MILLIS) {
            suspendCancellableCoroutine { continuation ->
                val task = messaging.deleteToken()
                task.addOnCompleteListener {
                    if (continuation.isActive) {
                        continuation.resume(Unit)
                    }
                }
            }
        }
    }

    internal fun warm(context: Context) {
        context.pushTokenPreferences().all
    }

    private fun messagingOrNull(context: Context): FirebaseMessaging? {
        val appContext = context.applicationContext
        if (FirebaseApp.getApps(appContext).isEmpty()) {
            return null
        }
        return FirebaseMessaging.getInstance()
    }

    private fun Context.pushTokenPreferences() =
        applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

    private const val TOKEN_OPERATION_TIMEOUT_MILLIS = 5_000L
}
