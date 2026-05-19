package app.fieldwork.android.push

import android.content.Context
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class FcmTokenRegistrarTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication().applicationContext
        context.tokenPrefsForTests().edit().clear().commit()
    }

    @After
    fun tearDown() {
        context.tokenPrefsForTests().edit().clear().commit()
    }

    @Test
    fun queueTokenStoresTrimmedPendingToken() {
        FcmTokenRegistrar.queueToken(context, "  refreshed-token  ")

        assertEquals("refreshed-token", FcmTokenRegistrar.pendingToken(context))
    }

    @Test
    fun blankTokenIsIgnored() {
        FcmTokenRegistrar.queueToken(context, " ")

        assertNull(FcmTokenRegistrar.pendingToken(context))
    }

    @Test
    fun clearPendingTokenRemovesOnlyMatchingToken() {
        FcmTokenRegistrar.queueToken(context, "first-token")

        FcmTokenRegistrar.clearPendingToken(context, "other-token")
        assertEquals("first-token", FcmTokenRegistrar.pendingToken(context))

        FcmTokenRegistrar.clearPendingToken(context, "first-token")
        assertNull(FcmTokenRegistrar.pendingToken(context))
    }

    @Test
    fun clearPendingTokenWithoutValueRemovesAnyQueuedToken() {
        FcmTokenRegistrar.queueToken(context, "first-token")

        FcmTokenRegistrar.clearPendingToken(context)

        assertNull(FcmTokenRegistrar.pendingToken(context))
    }

    private fun Context.tokenPrefsForTests() =
        applicationContext.getSharedPreferences("fieldwork_push_tokens", Context.MODE_PRIVATE)
}
