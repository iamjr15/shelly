package app.fieldwork.android.push

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class FieldworkPushNotificationsTest {
    @Test
    fun sessionHashAcceptsLowercaseSha256Hex() {
        assertTrue(FieldworkPushNotifications.isSessionIdHash("a".repeat(64)))
        assertTrue(FieldworkPushNotifications.isSessionIdHash("0123456789abcdef".repeat(4)))
    }

    @Test
    fun sessionHashRejectsUppercaseAndNonHexValues() {
        assertFalse(FieldworkPushNotifications.isSessionIdHash("A".repeat(64)))
        assertFalse(FieldworkPushNotifications.isSessionIdHash("g".repeat(64)))
        assertFalse(FieldworkPushNotifications.isSessionIdHash("a".repeat(63)))
        assertFalse(FieldworkPushNotifications.isSessionIdHash("a".repeat(65)))
    }

    @Test
    fun tapSessionHashParserTrimsButDoesNotLowercase() {
        val lowercase = "0123456789abcdef".repeat(4)

        assertEquals(lowercase, FieldworkPushNotifications.sessionIdHashValue("  $lowercase  "))
        assertNull(FieldworkPushNotifications.sessionIdHashValue("  ${"A".repeat(64)}  "))
        assertNull(FieldworkPushNotifications.sessionIdHashValue(null))
    }

    @Test
    fun awaitingInputNotificationUsesFixedGenericCopy() {
        val context = RuntimeEnvironment.getApplication().applicationContext
        val hash = "0123456789abcdef".repeat(4)

        FieldworkPushNotifications.showAwaitingInput(
            context,
            mapOf(
                FieldworkPushNotifications.DATA_EVENT_TYPE to "awaiting_input",
                FieldworkPushNotifications.EXTRA_SESSION_ID_HASH to hash,
                "last_line" to "secret terminal output",
                "command" to "claude",
            ),
        )

        val notification = postedNotifications(context).single()
        assertEquals("Fieldwork", notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(
            "A session is waiting for you.",
            notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString(),
        )
        assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    }

    @Test
    fun awaitingInputNotificationRejectsInvalidEventOrHash() {
        val context = RuntimeEnvironment.getApplication().applicationContext

        FieldworkPushNotifications.showAwaitingInput(
            context,
            mapOf(
                FieldworkPushNotifications.DATA_EVENT_TYPE to "working",
                FieldworkPushNotifications.EXTRA_SESSION_ID_HASH to "0123456789abcdef".repeat(4),
            ),
        )
        FieldworkPushNotifications.showAwaitingInput(
            context,
            mapOf(
                FieldworkPushNotifications.DATA_EVENT_TYPE to "awaiting_input",
                FieldworkPushNotifications.EXTRA_SESSION_ID_HASH to "A".repeat(64),
            ),
        )

        assertTrue(postedNotifications(context).isEmpty())
    }

    private fun postedNotifications(context: Context): List<Notification> {
        val manager = context.getSystemService(NotificationManager::class.java)
        return shadowOf(manager).allNotifications
    }
}
