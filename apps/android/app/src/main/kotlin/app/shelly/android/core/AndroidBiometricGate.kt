package app.shelly.android.core

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.shelly.android.BuildConfig
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

class AndroidBiometricGate(private val activity: FragmentActivity) {
    companion object {
        private const val DEFAULT_FRESH_MILLIS = 5 * 60 * 1000L
        private const val UNLOCK_UNAVAILABLE_MESSAGE =
            "To unlock Shelly, set up a screen lock (PIN, pattern, or password) or biometrics in Settings."
        private val ALLOWED_AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        private var nowMillis: () -> Long = { System.currentTimeMillis() }
        private var lastUnlockMillis: Long = 0
        private var backgroundedMillis: Long = 0

        // Idle window before a re-lock is required, plus whether the gate prompts at all.
        // Driven from settings (auto-lock + biometric lock) via [configure]; kept static so the
        // values survive gate recreation on configuration change.
        private var freshMillis: Long = DEFAULT_FRESH_MILLIS
        private var biometricEnabled: Boolean = true

        fun markBackgrounded() {
            backgroundedMillis = nowMillis()
        }

        private fun recordSuccessfulUnlock() {
            lastUnlockMillis = nowMillis()
            backgroundedMillis = 0
        }

        private fun isFreshNow(): Boolean =
            lastUnlockMillis != 0L && nowMillis() - lastUnlockMillis < freshMillis

        private fun shouldLockOnResumeNow(): Boolean =
            biometricEnabled &&
                (
                    !isFreshNow() ||
                        (backgroundedMillis != 0L && nowMillis() - backgroundedMillis >= freshMillis)
                )

        internal fun resetForTests(clock: () -> Long = { System.currentTimeMillis() }) {
            nowMillis = clock
            lastUnlockMillis = 0
            backgroundedMillis = 0
            freshMillis = DEFAULT_FRESH_MILLIS
            biometricEnabled = true
        }

        internal fun recordSuccessfulUnlockForTests() {
            recordSuccessfulUnlock()
        }

        internal fun isFreshForTests(): Boolean {
            return isFreshNow()
        }

        internal fun shouldLockOnResumeForTests(): Boolean {
            return shouldLockOnResumeNow()
        }

        internal fun debugBypassEnabledForTests(): Boolean {
            return debugBiometricBypassEnabled()
        }

        private fun debugBiometricBypassEnabled(): Boolean =
            BuildConfig.DEBUG && BuildConfig.SHELLY_BIOMETRIC_BYPASS
    }

    val isFresh: Boolean
        get() = isFreshNow()

    val shouldLockOnResume: Boolean
        get() = shouldLockOnResumeNow()

    /** Sync the gate to settings: the re-lock idle window and whether biometrics are required. */
    fun configure(autoLockMillis: Long, biometricEnabled: Boolean) {
        Companion.freshMillis = autoLockMillis
        Companion.biometricEnabled = biometricEnabled
    }

    fun unlockUnavailableMessage(): String? {
        if (debugBiometricBypassEnabled() || !biometricEnabled) {
            return null
        }
        val manager = BiometricManager.from(activity)
        return if (manager.canAuthenticate(ALLOWED_AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS) {
            null
        } else {
            UNLOCK_UNAVAILABLE_MESSAGE
        }
    }

    suspend fun unlock(reason: String): Boolean {
        if (isFresh) return true
        if (debugBiometricBypassEnabled() || !biometricEnabled) {
            recordSuccessfulUnlock()
            return true
        }

        val manager = BiometricManager.from(activity)
        if (manager.canAuthenticate(ALLOWED_AUTHENTICATORS) != BiometricManager.BIOMETRIC_SUCCESS) {
            return false
        }

        return suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        recordSuccessfulUnlock()
                        continuation.resume(true)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        continuation.resume(false)
                    }

                    override fun onAuthenticationFailed() {}
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock Shelly")
                .setSubtitle(reason)
                .setAllowedAuthenticators(ALLOWED_AUTHENTICATORS)
                .build()
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
            prompt.authenticate(info)
        }
    }
}
