package app.shelly.android.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ShellyFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        FcmTokenRegistrar.queueToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        when (message.data[ShellyPushNotifications.DATA_EVENT_TYPE]) {
            ShellyPushNotifications.EVENT_AWAITING_INPUT ->
                ShellyPushNotifications.showAwaitingInput(applicationContext, message.data)
            // The daemon emits these on session crash and long-build completion; the per-type
            // Notifications settings gate whether each is shown.
            ShellyPushNotifications.EVENT_SESSION_CRASHED ->
                ShellyPushNotifications.showSessionCrashed(applicationContext, message.data)
            ShellyPushNotifications.EVENT_BUILD_FINISHED ->
                ShellyPushNotifications.showBuildFinished(applicationContext, message.data)
        }
    }
}
