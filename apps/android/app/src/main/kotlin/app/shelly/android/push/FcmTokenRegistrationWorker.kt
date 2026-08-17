package app.shelly.android.push

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import app.shelly.android.core.ShellyRepository
import app.shelly.android.core.debugLog
import kotlinx.coroutines.CancellationException
import uniffi.shelly_mobile_core.ShellyException

/** Registers FCM rotations without waiting for the app to be foregrounded or biometrically open. */
class FcmTokenRegistrationWorker(
    appContext: Context,
    workerParameters: WorkerParameters,
) : CoroutineWorker(appContext, workerParameters) {
    override suspend fun doWork(): Result {
        val token = inputData.getString(INPUT_TOKEN)?.trim().orEmpty()
        if (token.isEmpty()) {
            return Result.failure()
        }
        val repository = ShellyRepository(applicationContext)
        return try {
            repository.retryPendingPushUnregister()
            if (!repository.restore()) {
                // Keep FcmTokenRegistrar's pending copy. A later pairing/foreground sync owns it.
                Result.success()
            } else {
                repository.registerFcmToken(token)
                FcmTokenRegistrar.clearPendingToken(applicationContext, token)
                Result.success()
            }
        } catch (error: ShellyException.Unauthorized) {
            debugLog("FCM rotation found revoked pairing", error, LOG_TAG)
            repository.clearRevokedPairing()
            Result.success()
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            debugLog("FCM rotation registration deferred", error, LOG_TAG)
            Result.retry()
        } finally {
            repository.destroy()
        }
    }

    companion object {
        private const val INPUT_TOKEN = "fcm_token"
        private const val UNIQUE_WORK_NAME = "register-rotated-fcm-token"
        private const val LOG_TAG = "ShellyFcmWorker"

        fun enqueue(context: Context, token: String) {
            val normalized = token.trim()
            if (normalized.isEmpty()) {
                return
            }
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                request(normalized),
            )
        }

        internal fun request(token: String): OneTimeWorkRequest =
            OneTimeWorkRequestBuilder<FcmTokenRegistrationWorker>()
                .setInputData(Data.Builder().putString(INPUT_TOKEN, token).build())
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()
    }
}
