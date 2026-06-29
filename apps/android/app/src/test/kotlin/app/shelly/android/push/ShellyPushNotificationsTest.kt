package app.shelly.android.push

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class ShellyPushNotificationsTest {
    // Pin the quiet-hours clock to midday so the default 10pm–8am window never suppresses
    // notifications regardless of the wall-clock time the suite runs at.
    @Before
    fun setUp() {
        ShellyPushNotifications.currentHourOfDay = { 12 }
    }

    @After
    fun tearDown() {
        ShellyPushNotifications.resetClockForTests()
    }

    @Test
    fun sessionHashAcceptsLowercaseSha256Hex() {
        assertTrue(ShellyPushNotifications.isSessionIdHash("a".repeat(64)))
        assertTrue(ShellyPushNotifications.isSessionIdHash("0123456789abcdef".repeat(4)))
    }

    @Test
    fun sessionHashRejectsUppercaseAndNonHexValues() {
        assertFalse(ShellyPushNotifications.isSessionIdHash("A".repeat(64)))
        assertFalse(ShellyPushNotifications.isSessionIdHash("g".repeat(64)))
        assertFalse(ShellyPushNotifications.isSessionIdHash("a".repeat(63)))
        assertFalse(ShellyPushNotifications.isSessionIdHash("a".repeat(65)))
    }

    @Test
    fun tapSessionHashParserTrimsButDoesNotLowercase() {
        val lowercase = "0123456789abcdef".repeat(4)

        assertEquals(lowercase, ShellyPushNotifications.sessionIdHashValue("  $lowercase  "))
        assertNull(ShellyPushNotifications.sessionIdHashValue("  ${"A".repeat(64)}  "))
        assertNull(ShellyPushNotifications.sessionIdHashValue(null))
    }

    @Test
    fun awaitingInputNotificationUsesFixedGenericCopy() {
        val context = RuntimeEnvironment.getApplication().applicationContext
        val hash = "0123456789abcdef".repeat(4)

        ShellyPushNotifications.showAwaitingInput(
            context,
            mapOf(
                ShellyPushNotifications.DATA_EVENT_TYPE to "awaiting_input",
                ShellyPushNotifications.EXTRA_SESSION_ID_HASH to hash,
                "last_line" to "secret terminal output",
                "command" to "claude",
            ),
        )

        val notification = postedNotifications(context).single()
        assertEquals("Shelly", notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(
            "A session is waiting for you.",
            notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString(),
        )
        assertEquals(Notification.VISIBILITY_PRIVATE, notification.visibility)
    }

    @Test
    fun awaitingInputNotificationRejectsInvalidEventOrHash() {
        val context = RuntimeEnvironment.getApplication().applicationContext

        ShellyPushNotifications.showAwaitingInput(
            context,
            mapOf(
                ShellyPushNotifications.DATA_EVENT_TYPE to "working",
                ShellyPushNotifications.EXTRA_SESSION_ID_HASH to "0123456789abcdef".repeat(4),
            ),
        )
        ShellyPushNotifications.showAwaitingInput(
            context,
            mapOf(
                ShellyPushNotifications.DATA_EVENT_TYPE to "awaiting_input",
                ShellyPushNotifications.EXTRA_SESSION_ID_HASH to "A".repeat(64),
            ),
        )

        assertTrue(postedNotifications(context).isEmpty())
    }

    private fun postedNotifications(context: Context): List<Notification> {
        val manager = context.getSystemService(NotificationManager::class.java)
        return shadowOf(manager).allNotifications
    }
}
