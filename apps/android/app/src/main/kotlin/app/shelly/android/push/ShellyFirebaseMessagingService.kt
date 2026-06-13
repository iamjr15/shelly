package app.shelly.android.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class ShellyFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        FcmTokenRegistrar.queueToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data[ShellyPushNotifications.DATA_EVENT_TYPE] == "awaiting_input") {
            ShellyPushNotifications.showAwaitingInput(applicationContext, message.data)
        }
    }
}
