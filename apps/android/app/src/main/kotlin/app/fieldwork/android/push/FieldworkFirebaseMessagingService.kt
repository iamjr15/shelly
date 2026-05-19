package app.fieldwork.android.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FieldworkFirebaseMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        FcmTokenRegistrar.queueToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data[FieldworkPushNotifications.DATA_EVENT_TYPE] == "awaiting_input") {
            FieldworkPushNotifications.showAwaitingInput(applicationContext, message.data)
        }
    }
}
