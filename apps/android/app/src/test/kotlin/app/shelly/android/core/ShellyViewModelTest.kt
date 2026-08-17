package app.shelly.android.core

import android.content.Context
import android.os.Looper
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
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
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import uniffi.shelly_mobile_core.AttachedSession
import uniffi.shelly_mobile_core.ByteStreamSink
import uniffi.shelly_mobile_core.NoHandle
import uniffi.shelly_mobile_core.ShellyException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ShellyViewModelTest {
    private companion object {
        const val TEST_PAIRING_TICKET = "sh1testpairingticket"
        const val TEST_PAIRING_TICKET_2 = "sh1secondtestpairingticket"
        const val TEST_PAIRING_SAS = "84A9-FB21-1FC7-20DF-3B6E"
    }

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication().applicationContext
    }

    @Test
    fun syncFcmTokenDoesNotRegisterWhenPairedButLocked() {
        val repository = FakeRepository(restoredPairing = testPairing())
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.syncFcmToken()
        drainMainLooper()

        assertEquals(emptyList<String>(), repository.registeredFcmTokens)
        assertEquals("queued-token", fcmTokens.pendingToken(context))
    }

    @Test
    fun setUnlockedRegistersQueuedAndCurrentFcmTokensThenClearsQueuedToken() {
        val repository = FakeRepository(restoredPairing = testPairing())
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.setUnlocked(true)
        drainMainLooper()

        assertEquals(listOf("queued-token", "current-token"), repository.registeredFcmTokens)
        assertEquals(listOf("queued-token"), fcmTokens.clearedMatchingTokens)
        assertEquals(listOf(true), fcmTokens.currentTokenAutoInitRequests)
        assertNull(fcmTokens.pendingToken(context))
    }

    @Test
    fun setUnlockedRegistersDuplicateQueuedAndCurrentFcmTokenOnlyOnce() {
        val repository = FakeRepository(restoredPairing = testPairing())
        val fcmTokens = FakeFcmTokenSource(pending = "same-token", current = "same-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.setUnlocked(true)
        drainMainLooper()

        assertEquals(listOf("same-token"), repository.registeredFcmTokens)
        assertEquals(listOf("same-token"), fcmTokens.clearedMatchingTokens)
    }

    @Test
    fun syncFcmTokenCancellationStopsRegistrationWithoutClearingQueuedToken() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onRegisterFcmToken = { token ->
                if (token == "queued-token") {
                    throw CancellationException("fcm sync canceled")
                }
            },
        )
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.setUnlocked(true)
        drainMainLooper()

        assertEquals(emptyList<String>(), repository.registeredFcmTokens)
        assertEquals(emptyList<String>(), fcmTokens.clearedMatchingTokens)
        assertEquals("queued-token", fcmTokens.pendingToken(context))
        assertNull(viewModel.state.value.message)
    }

    @Test
    fun unpairClearsQueuedFcmToken() {
        val repository = FakeRepository(restoredPairing = testPairing())
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = null)
        val viewModel = testViewModel(repository, fcmTokens)
        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.openTerminalSession(testSession(id = "018f0000-0000-7000-8000-0000000000aa"))

        viewModel.unpair()
        drainMainLooper()

        assertEquals(1, fcmTokens.clearAllCalls)
        assertEquals(1, fcmTokens.restorePrivacyDefaultCalls)
        assertEquals(1, fcmTokens.deleteCurrentTokenCalls)
        assertEquals(1, repository.clearCalls)
        assertEquals(1, repository.unpairSelfCalls)
        assertNull(fcmTokens.pendingToken(context))
        assertFalse(viewModel.state.value.restoringPairing)
        assertFalse(viewModel.state.value.paired)
        assertEquals(emptyList<MobileSession>(), viewModel.state.value.sessions)
        assertNull(viewModel.state.value.activeTerminalSessionId)
    }

    @Test
    fun unpairUnregistersPendingAndCurrentFcmTokensBeforeClearingRepository() {
        val operations = mutableListOf<String>()
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onRegisterFcmToken = { throw IllegalStateException("offline during sync") },
            operationLog = operations,
        )
        val fcmTokens = FakeFcmTokenSource(
            pending = "queued-token",
            current = "current-token",
            operationLog = operations,
        )
        val viewModel = testViewModel(repository, fcmTokens)
        viewModel.setUnlocked(true)
        drainMainLooper()

        viewModel.unpair()
        drainMainLooper()

        assertEquals(listOf("queued-token", "current-token"), repository.unregisteredFcmTokens)
        assertEquals(listOf(listOf("queued-token", "current-token")), repository.persistedPushTombstones)
        assertEquals(listOf("queued-token", "current-token"), repository.acknowledgedPushTokens)
        assertEquals(1, fcmTokens.clearAllCalls)
        assertEquals(1, fcmTokens.restorePrivacyDefaultCalls)
        assertEquals(1, fcmTokens.deleteCurrentTokenCalls)
        assertEquals(listOf(true, false), fcmTokens.currentTokenAutoInitRequests)
        assertEquals(1, repository.clearCalls)
        assertEquals(
            listOf(
                "persist-tombstone",
                "unregister:queued-token",
                "ack:queued-token",
                "unregister:current-token",
                "ack:current-token",
                "unpair-self",
                "delete-local-token",
                "restore-privacy-default",
                "clear-pending-token",
                "clear-repository",
            ),
            operations,
        )
        assertNull(fcmTokens.pendingToken(context))
        assertFalse(viewModel.state.value.paired)
    }

    @Test
    fun unpairStillClearsLocalStateWhenFcmUnregisterFails() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onUnregisterFcmToken = { throw IllegalStateException("relay unavailable") },
        )
        val fcmTokens = FakeFcmTokenSource(pending = null, current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)
        viewModel.setUnlocked(true)
        drainMainLooper()

        viewModel.unpair()
        drainMainLooper()

        assertEquals(listOf("current-token"), repository.unregisteredFcmTokens)
        assertEquals(listOf(listOf("current-token")), repository.persistedPushTombstones)
        assertEquals(emptyList<String>(), repository.acknowledgedPushTokens)
        assertEquals(1, fcmTokens.clearAllCalls)
        assertEquals(1, fcmTokens.restorePrivacyDefaultCalls)
        assertEquals(1, fcmTokens.deleteCurrentTokenCalls)
        assertEquals(1, repository.clearCalls)
        assertFalse(viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
    }

    @Test
    fun disablingPushUnregistersTokenDeletesLocalTokenAndRestoresPrivacyDefault() {
        val repository = FakeRepository(restoredPairing = testPairing())
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.setPushEnabled(false)
        drainMainLooper()

        assertEquals(listOf("queued-token", "current-token"), repository.unregisteredFcmTokens)
        assertEquals(listOf("queued-token", "current-token"), repository.acknowledgedPushTokens)
        assertEquals(1, fcmTokens.deleteCurrentTokenCalls)
        assertEquals(1, fcmTokens.restorePrivacyDefaultCalls)
        assertEquals(1, fcmTokens.clearAllCalls)
        assertEquals(listOf(false), fcmTokens.currentTokenAutoInitRequests)
    }

    @Test
    fun disablingPushWhileUnpairedStillDeletesAllLocalTokenState() {
        val repository = FakeRepository(restoredPairing = null)
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.setPushEnabled(false)
        drainMainLooper()

        assertEquals(emptyList<String>(), repository.unregisteredFcmTokens)
        assertEquals(1, fcmTokens.deleteCurrentTokenCalls)
        assertEquals(1, fcmTokens.restorePrivacyDefaultCalls)
        assertEquals(1, fcmTokens.clearAllCalls)
        assertNull(fcmTokens.pendingToken(context))
    }

    @Test
    fun unauthorizedUnregisterAcknowledgesEncryptedTombstoneAsAlreadyRemoved() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onUnregisterFcmToken = { throw ShellyException.Unauthorized("device removed") },
        )
        val fcmTokens = FakeFcmTokenSource(pending = null, current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)
        viewModel.setUnlocked(true)
        drainMainLooper()

        viewModel.unpair()
        drainMainLooper()

        assertEquals(listOf(listOf("current-token")), repository.persistedPushTombstones)
        assertEquals(listOf("current-token"), repository.acknowledgedPushTokens)
        assertEquals(1, repository.clearCalls)
    }

    @Test
    fun lockedPushIntentResolvesAfterUnlockAndSessionRefresh() {
        val session = testSession(id = "018f0000-0000-7000-8000-000000000001")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.handlePushIntent(sha256HexForTest(session.id))
        assertNull(viewModel.state.value.targetSession)

        viewModel.setUnlocked(true)
        drainMainLooper()

        assertEquals(session, viewModel.state.value.targetSession)
    }

    @Test
    fun unlockedPushIntentResolvesAgainstCurrentSessionList() {
        val session = testSession(id = "018f0000-0000-7000-8000-000000000002")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.handlePushIntent(sha256HexForTest(session.id))

        assertEquals(session, viewModel.state.value.targetSession)
    }

    @Test
    fun invalidPushIntentHashDoesNotRouteAfterUnlock() {
        val session = testSession(id = "018f0000-0000-7000-8000-000000000003")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.handlePushIntent("A".repeat(64))
        viewModel.setUnlocked(true)
        drainMainLooper()

        assertNull(viewModel.state.value.targetSession)
    }

    @Test
    fun invalidPushIntentHashClearsPreviouslyPendingRoute() {
        val session = testSession(id = "018f0000-0000-7000-8000-000000000004")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.handlePushIntent(sha256HexForTest(session.id))
        viewModel.handlePushIntent("A".repeat(64))
        viewModel.setUnlocked(true)
        drainMainLooper()

        assertNull(viewModel.state.value.targetSession)
    }

    @Test
    fun setUnlockedStartsSessionSubscriptionAndAppliesUpdates() {
        val first = testSession(id = "018f0000-0000-7000-8000-000000000005")
        val second = testSession(id = "018f0000-0000-7000-8000-000000000006")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(first),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        drainMainLooper()

        assertEquals(1, repository.subscribeCalls)
        assertEquals(listOf(first), viewModel.state.value.sessions)

        repository.emitSessions(listOf(second))

        assertEquals(listOf(second), viewModel.state.value.sessions)
    }

    @Test
    fun activeTerminalSessionPersistsAcrossSessionUpdatesWithSameId() {
        val first = testSession(id = "018f0000-0000-7000-8000-0000000000a1")
        val updated = first.copy(lastLine = "still attached")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(first),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.openTerminalSession(first)
        repository.emitSessions(listOf(updated))

        assertEquals(first.id, viewModel.state.value.activeTerminalSessionId)
        assertEquals(listOf(updated), viewModel.state.value.sessions)
        assertEquals(listOf(updated), viewModel.state.value.terminalTabs)
    }

    @Test
    fun terminalTabsAndActiveSessionRestoreFromSavedStateHandle() {
        val first = testSession(id = "018f0000-0000-7000-8000-0000000000d8")
        val second = testSession(id = "018f0000-0000-7000-8000-0000000000d9")
        val savedState = SavedStateHandle()
        val firstViewModel = testViewModel(
            repository = FakeRepository(restoredPairing = testPairing()),
            savedStateHandle = savedState,
        )
        firstViewModel.openTerminalSession(first)
        firstViewModel.openTerminalSession(second)

        val restoredViewModel = testViewModel(
            repository = FakeRepository(
                restoredPairing = testPairing(),
                sessions = listOf(first, second),
            ),
            savedStateHandle = savedState,
        )
        restoredViewModel.setUnlocked(true)
        drainMainLooper()

        assertEquals(listOf(first, second), restoredViewModel.state.value.terminalTabs)
        assertEquals(second.id, restoredViewModel.state.value.activeTerminalSessionId)
    }

    @Test
    fun openTerminalTabSurvivesSessionListRemovalUntilUserClosesIt() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000a2")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.openTerminalSession(session)
        repository.emitSessions(emptyList())

        assertEquals(session.id, viewModel.state.value.activeTerminalSessionId)
        assertEquals(listOf(session), viewModel.state.value.terminalTabs)
        assertTrue(viewModel.state.value.sessions.isEmpty())
    }

    @Test
    fun openingAndSwitchingTerminalTabsPreservesOrderWithoutDuplicates() {
        val first = testSession(id = "018f0000-0000-7000-8000-0000000000a4").copy(name = "first")
        val second = testSession(id = "018f0000-0000-7000-8000-0000000000a5").copy(name = "second")
        val viewModel = testViewModel(FakeRepository(restoredPairing = testPairing()))

        viewModel.openTerminalSession(first)
        viewModel.openTerminalSession(second)
        viewModel.openTerminalSession(first.copy(lastLine = "updated"))

        assertEquals(listOf(first.id, second.id), viewModel.state.value.terminalTabs.map(MobileSession::id))
        assertEquals("updated", viewModel.state.value.terminalTabs.first().lastLine)
        assertEquals(first.id, viewModel.state.value.activeTerminalSessionId)
    }

    @Test
    fun closingActiveTerminalTabSelectsTheAdjacentTab() {
        val first = testSession(id = "018f0000-0000-7000-8000-0000000000a6")
        val second = testSession(id = "018f0000-0000-7000-8000-0000000000a7")
        val third = testSession(id = "018f0000-0000-7000-8000-0000000000a8")
        val viewModel = testViewModel(FakeRepository(restoredPairing = testPairing()))
        viewModel.openTerminalSession(first)
        viewModel.openTerminalSession(second)
        viewModel.openTerminalSession(third)
        viewModel.openTerminalSession(second)

        viewModel.closeTerminalTab(second.id)

        assertEquals(listOf(first.id, third.id), viewModel.state.value.terminalTabs.map(MobileSession::id))
        assertEquals(third.id, viewModel.state.value.activeTerminalSessionId)

        viewModel.closeTerminalTab(third.id)

        assertEquals(first.id, viewModel.state.value.activeTerminalSessionId)
    }

    @Test
    fun closingInactiveTerminalTabKeepsTheActiveTab() {
        val first = testSession(id = "018f0000-0000-7000-8000-0000000000a9")
        val second = testSession(id = "018f0000-0000-7000-8000-0000000000aa")
        val viewModel = testViewModel(FakeRepository(restoredPairing = testPairing()))
        viewModel.openTerminalSession(first)
        viewModel.openTerminalSession(second)

        viewModel.closeTerminalTab(first.id)

        assertEquals(listOf(second), viewModel.state.value.terminalTabs)
        assertEquals(second.id, viewModel.state.value.activeTerminalSessionId)
    }

    @Test
    fun setLockedClearsTheTerminalWorkspace() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000a3")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.openTerminalSession(session)
        viewModel.setUnlocked(false)

        assertNull(viewModel.state.value.activeTerminalSessionId)
        assertTrue(viewModel.state.value.terminalTabs.isEmpty())
    }

    @Test
    fun createSessionAddsShellSessionAndOpensIt() {
        val created = testSession(id = "018f0000-0000-7000-8000-0000000000c1")
            .copy(name = "work", command = listOf("/bin/zsh"))
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            createResult = created,
        )
        val viewModel = testViewModel(repository)
        viewModel.setUnlocked(true)
        drainMainLooper()

        viewModel.createSession("work")
        drainMainLooper()

        assertEquals(listOf("work"), repository.createdNames)
        assertEquals(created.id, viewModel.state.value.activeTerminalSessionId)
        assertEquals(listOf(created), viewModel.state.value.terminalTabs)
        assertTrue(viewModel.state.value.sessions.any { it.id == created.id })
        assertNull(viewModel.state.value.message)
    }

    @Test
    fun killSessionRemovesSessionAndClosesActiveTerminal() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000c2")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)
        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.openTerminalSession(session)

        viewModel.killSession(session.id)
        drainMainLooper()

        assertEquals(listOf(session.id), repository.killedSessionIds)
        assertNull(viewModel.state.value.activeTerminalSessionId)
        assertFalse(viewModel.state.value.sessions.any { it.id == session.id })
    }

    @Test
    fun killSessionKeepsSessionVisibleUntilDaemonConfirmsRemoval() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000c3")
        val confirmation = CompletableDeferred<Unit>()
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
            killConfirmation = confirmation,
        )
        val viewModel = testViewModel(repository)
        viewModel.setUnlocked(true)
        drainMainLooper()

        viewModel.killSession(session.id)
        drainMainLooper()

        assertEquals(listOf(session.id), repository.killedSessionIds)
        assertTrue(viewModel.state.value.sessions.any { it.id == session.id })

        confirmation.complete(Unit)
        waitForState { viewModel.state.value.sessions.none { it.id == session.id } }
    }

    @Test
    fun killSessionFailureLeavesAuthoritativeSessionVisible() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000c4")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
            killFailure = RuntimeException("daemon did not confirm termination"),
        )
        val viewModel = testViewModel(repository)
        viewModel.setUnlocked(true)
        drainMainLooper()

        viewModel.killSession(session.id)
        drainMainLooper()

        assertTrue(viewModel.state.value.sessions.any { it.id == session.id })
        assertEquals("CLOSE", viewModel.state.value.message?.title)
    }

    @Test
    fun sessionSubscriptionDisconnectRetriesWithoutUserVisibleAlert() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000f0")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
            subscriptionFailures = ArrayDeque<Throwable>().apply {
                add(RuntimeException("transport error: connection lost"))
            },
        )
        val viewModel = testViewModel(
            repository = repository,
            sessionSubscriptionRetryDelayMillis = 0L,
        )

        viewModel.setUnlocked(true)
        drainMainLooper()

        waitForState { repository.subscribeCalls >= 2 }
        assertNull(viewModel.state.value.message)
        assertEquals(listOf(session), viewModel.state.value.sessions)
    }

    @Test
    fun sessionSubscriptionCleanEndRetriesWithoutUserVisibleAlert() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000f1")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
            subscriptionCleanReturnsBeforeHold = 1,
        )
        val viewModel = testViewModel(
            repository = repository,
            sessionSubscriptionRetryDelayMillis = 0L,
        )

        viewModel.setUnlocked(true)
        drainMainLooper()

        waitForState { repository.subscribeCalls >= 2 }
        assertNull(viewModel.state.value.message)
        assertEquals(listOf(session), viewModel.state.value.sessions)
    }

    @Test
    fun unauthorizedSessionSubscriptionClearsPairingAndRoutesToRevokedPairingState() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            subscriptionFailures = ArrayDeque<Throwable>().apply {
                add(ShellyException.Unauthorized("device revoked"))
            },
        )
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.setUnlocked(true)
        drainMainLooper()
        waitForState { viewModel.state.value.pairingRevoked }

        assertFalse(viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertTrue(viewModel.state.value.pairingRevoked)
        assertEquals(
            "This phone is no longer paired with your computer.",
            viewModel.state.value.pairingError?.message,
        )
        assertNull(repository.savedPairing)
        assertEquals(1, repository.clearCalls)
        assertEquals(1, fcmTokens.deleteCurrentTokenCalls)
        assertEquals(1, fcmTokens.clearAllCalls)
    }

    @Test
    fun sessionRetryBackoffDoublesPerAttemptAndCaps() {
        assertEquals(750L, sessionRetryBackoffMillis(attempt = 1, baseMillis = 750L, capMillis = 30_000L))
        assertEquals(1_500L, sessionRetryBackoffMillis(attempt = 2, baseMillis = 750L, capMillis = 30_000L))
        assertEquals(3_000L, sessionRetryBackoffMillis(attempt = 3, baseMillis = 750L, capMillis = 30_000L))
        assertEquals(6_000L, sessionRetryBackoffMillis(attempt = 4, baseMillis = 750L, capMillis = 30_000L))
        assertEquals(30_000L, sessionRetryBackoffMillis(attempt = 99, baseMillis = 750L, capMillis = 30_000L))
        assertEquals(0L, sessionRetryBackoffMillis(attempt = 5, baseMillis = 0L, capMillis = 30_000L))
    }

    @Test
    fun sessionSubscriptionDropEntersReconnectingAndHoldsLastSessions() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000d1")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
            subscriptionFailures = ArrayDeque<Throwable>().apply {
                add(RuntimeException("transport error: connection lost"))
            },
            emitOnSubscribe = false,
        )
        val viewModel = testViewModel(
            repository = repository,
            sessionSubscriptionRetryDelayMillis = 0L,
            now = { 1_000_000L },
        )

        viewModel.setUnlocked(true)
        drainMainLooper()

        waitForState { viewModel.state.value.connectionState is ConnectionState.Reconnecting }
        val reconnecting = viewModel.state.value.connectionState as ConnectionState.Reconnecting
        assertEquals(1, reconnecting.attempt)
        assertEquals(1_000_000L, reconnecting.droppedAtMillis)
        assertEquals(1_000_000L, reconnecting.nextRetryAtMillis)
        assertEquals(listOf(session), viewModel.state.value.sessions)
        assertNull(viewModel.state.value.message)
    }

    @Test
    fun sustainedSessionSubscriptionDropBecomesUnreachable() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            subscriptionFailures = ArrayDeque<Throwable>().apply {
                add(RuntimeException("transport error: connection lost"))
            },
            emitOnSubscribe = false,
        )
        val viewModel = testViewModel(
            repository = repository,
            sessionSubscriptionRetryDelayMillis = 0L,
            unreachableAfterMillis = 0L,
            unreachableRetryIntervalMillis = 15_000L,
            now = { 2_000_000L },
        )

        viewModel.setUnlocked(true)
        drainMainLooper()

        waitForState { viewModel.state.value.connectionState is ConnectionState.Unreachable }
        val unreachable = viewModel.state.value.connectionState as ConnectionState.Unreachable
        assertEquals(1, unreachable.attempt)
        assertEquals(2_000_000L, unreachable.droppedAtMillis)
        assertEquals(15_000L, unreachable.retryIntervalMillis)
        assertEquals(2_015_000L, unreachable.nextRetryAtMillis)

        viewModel.setUnlocked(false)
        drainMainLooper()
    }

    @Test
    fun sessionSubscriptionRecoveryReturnsToConnected() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000d3")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
            subscriptionFailures = ArrayDeque<Throwable>().apply {
                add(RuntimeException("transport error: connection lost"))
            },
        )
        val viewModel = testViewModel(
            repository = repository,
            sessionSubscriptionRetryDelayMillis = 0L,
        )

        viewModel.setUnlocked(true)
        drainMainLooper()

        waitForState {
            repository.subscribeCalls >= 2 &&
                viewModel.state.value.connectionState == ConnectionState.Connected
        }
        assertEquals(ConnectionState.Connected, viewModel.state.value.connectionState)
        assertEquals(listOf(session), viewModel.state.value.sessions)
        assertNull(viewModel.state.value.message)
    }

    @Test
    fun retryConnectionNowShortensReconnectWait() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            subscriptionAlwaysFails = true,
        )
        // A 30s base backoff means the next retry only fires within the test window if
        // retryConnectionNow() interrupts the wait.
        val viewModel = testViewModel(
            repository = repository,
            sessionSubscriptionRetryDelayMillis = 30_000L,
        )

        viewModel.setUnlocked(true)
        drainMainLooper()

        waitForState { viewModel.state.value.connectionState is ConnectionState.Reconnecting }
        assertEquals(1, repository.subscribeCalls)

        viewModel.retryConnectionNow()
        drainMainLooper()

        waitForState { repository.subscribeCalls >= 2 }
        assertTrue(repository.subscribeCalls >= 2)

        viewModel.setUnlocked(false)
        drainMainLooper()
    }

    @Test
    fun setLockedStopsSessionSubscriptionUpdates() {
        val first = testSession(id = "018f0000-0000-7000-8000-000000000009")
        val second = testSession(id = "018f0000-0000-7000-8000-00000000000a")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(first),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.setUnlocked(false)
        repository.emitSessions(listOf(second))

        assertEquals(1, repository.subscribeCalls)
        assertEquals(listOf(first), viewModel.state.value.sessions)
    }

    @Test
    fun backgroundGraceClosesTerminalStopsSubscriptionAndForegroundRestartsIt() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000b0")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(
            repository = repository,
            backgroundDetachGraceMillis = 0L,
        )

        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.openTerminalSession(session)
        assertEquals(1, repository.subscribeCalls)

        viewModel.onAppBackgrounded()
        drainMainLooper()

        assertNull(viewModel.state.value.activeTerminalSessionId)
        assertEquals(1, repository.subscribeCalls)

        viewModel.onAppForegrounded()
        drainMainLooper()

        waitForState { repository.subscribeCalls == 2 }
        assertEquals(listOf(session), viewModel.state.value.sessions)
    }

    @Test
    fun foregroundBeforeBackgroundGraceKeepsTerminalAndSubscription() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000b1")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        drainMainLooper()
        viewModel.openTerminalSession(session)

        viewModel.onAppBackgrounded()
        viewModel.onAppForegrounded()
        drainMainLooper()

        assertEquals(session.id, viewModel.state.value.activeTerminalSessionId)
        assertEquals(1, repository.subscribeCalls)
    }

    @Test
    fun pendingPushIntentResolvesFromLaterSessionSubscriptionUpdate() {
        val session = testSession(id = "018f0000-0000-7000-8000-000000000007")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = emptyList(),
        )
        val viewModel = testViewModel(repository)

        viewModel.handlePushIntent(sha256HexForTest(session.id))
        viewModel.setUnlocked(true)
        drainMainLooper()
        assertNull(viewModel.state.value.targetSession)

        repository.emitSessions(listOf(session))

        assertEquals(session, viewModel.state.value.targetSession)
    }

    @Test
    fun pairWhileUnlockedLoadsSessionsStartsSubscriptionAndSyncsFcmToken() {
        val session = testSession(id = "018f0000-0000-7000-8000-000000000008")
        val pairing = testPairing()
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = pairing,
            sessions = listOf(session),
        )
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.setUnlocked(true)
        viewModel.pair(TEST_PAIRING_TICKET)
        drainMainLooper()

        assertEquals(TEST_PAIRING_TICKET, repository.pairedPayload)
        assertEquals(TEST_PAIRING_SAS, viewModel.state.value.pendingPairingSas)
        assertNull(repository.savedPairing)

        confirmPendingPairing(viewModel)

        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(pairing, viewModel.state.value.pairedDaemon)
        assertEquals(listOf(session), viewModel.state.value.sessions)
        assertEquals(1, repository.subscribeCalls)
        assertEquals(listOf("queued-token", "current-token"), repository.registeredFcmTokens)
    }

    @Test
    fun pairWithCodeWhileUnlockedPairsAndLoadsSessions() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000e0")
        val pairing = testPairing()
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = pairing,
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        viewModel.pairWithCode("AB12C34")
        drainMainLooper()

        assertEquals("AB12C34", repository.pairedCode)
        assertEquals(emptyList<String>(), repository.pairedPayloads)
        confirmPendingPairing(viewModel)
        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(pairing, viewModel.state.value.pairedDaemon)
        assertEquals(listOf(session), viewModel.state.value.sessions)
        assertEquals(1, repository.subscribeCalls)
    }

    @Test
    fun pairWhileUnlockedKeepsLoadedSessionsAfterInitialEmptySubscriptionUpdate() {
        val session = testSession(id = "018f0000-0000-7000-8000-000000000009")
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = testPairing(),
            sessions = listOf(session),
            initialSubscriptionSessions = emptyList(),
        )
        val viewModel = testViewModel(repository)

        viewModel.setUnlocked(true)
        viewModel.pair(TEST_PAIRING_TICKET)
        drainMainLooper()
        confirmPendingPairing(viewModel)

        assertEquals(listOf(session), viewModel.state.value.sessions)
        assertEquals(1, repository.subscribeCalls)
    }

    @Test
    fun pairWhileLockedDoesNotLoadSessionsStartSubscriptionOrSyncFcmToken() {
        val session = testSession(id = "018f0000-0000-7000-8000-00000000000b")
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = testPairing(),
            sessions = listOf(session),
        )
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.pair(TEST_PAIRING_TICKET)
        drainMainLooper()
        confirmPendingPairing(viewModel)

        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(emptyList<MobileSession>(), viewModel.state.value.sessions)
        assertEquals(0, repository.subscribeCalls)
        assertEquals(emptyList<String>(), repository.registeredFcmTokens)
    }

    @Test
    fun cancelPendingPairingRejectsAttemptWithoutPersisting() {
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = testPairing(),
        )
        val viewModel = testViewModel(repository)

        viewModel.pair(TEST_PAIRING_TICKET)
        waitForState { viewModel.state.value.pendingPairingSas == TEST_PAIRING_SAS }

        viewModel.cancelPairing()
        drainMainLooper()

        assertEquals(1, repository.cancelledPairings)
        assertNull(repository.savedPairing)
        assertNull(viewModel.state.value.pendingPairingSas)
        assertFalse(viewModel.state.value.paired)
    }

    @Test
    fun versionMismatchPairingErrorPromptsForAnUpdate() {
        val message = pairingErrorMessage(ShellyException.VersionMismatch("protocol v5 required"))

        assertTrue(message.message.contains("Update Shelly"))
    }

    @Test
    fun pairCancellationDoesNotShowUserVisibleAlert() {
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = testPairing(),
            onPair = {
                throw CancellationException("pair canceled")
            },
        )
        val viewModel = testViewModel(repository)

        viewModel.pair(TEST_PAIRING_TICKET)
        drainMainLooper()

        assertFalse(viewModel.state.value.loading)
        assertFalse(viewModel.state.value.paired)
        assertNull(viewModel.state.value.message)
        assertNull(repository.savedPairing)
    }

    @Test
    fun pairFailureUsesStableMessageWithoutLeakingTransportDetails() {
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = testPairing(),
            onPair = {
                throw IllegalStateException("node id 12D3 path /Users/example/private")
            },
        )
        val viewModel = testViewModel(repository)

        viewModel.pairWithCode("AB12C34")
        drainMainLooper()

        assertFalse(viewModel.state.value.loading)
        assertFalse(viewModel.state.value.paired)
        assertNull(viewModel.state.value.message)
        assertEquals(
            "Pairing stopped because Android reported an unexpected error.",
            viewModel.state.value.pairingError?.message,
        )
        assertEquals(
            "Run `shelly pair` again and try a fresh code.",
            viewModel.state.value.pairingError?.detail,
        )
    }

    @Test
    fun expiredPairingCodeUsesPairingErrorWithoutGlobalAlert() {
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = testPairing(),
            onPair = {
                throw ShellyException.NotFound("pairing code not found, expired, or already used")
            },
        )
        val viewModel = testViewModel(repository)

        viewModel.pairWithCode("AB12C34")
        drainMainLooper()

        assertFalse(viewModel.state.value.loading)
        assertFalse(viewModel.state.value.paired)
        assertNull(viewModel.state.value.message)
        assertEquals(
            "That pairing code expired or was already used.",
            viewModel.state.value.pairingError?.message,
        )
        assertEquals(
            "Run `shelly pair` on your computer for a fresh code.",
            viewModel.state.value.pairingError?.detail,
        )
    }

    @Test
    fun duplicatePairWhileFirstPairIsInFlightIsIgnored() {
        val pairStarted = CountDownLatch(1)
        val releasePair = CountDownLatch(1)
        val repository = FakeRepository(
            restoredPairing = null,
            pairResult = testPairing(),
            onPair = {
                pairStarted.countDown()
                assertTrue(releasePair.await(2, TimeUnit.SECONDS))
            },
        )
        val repositoryDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        try {
            val viewModel = ShellyViewModel(
                context,
                repository,
                FakeFcmTokenSource(pending = null, current = null),
                restoreDispatcher = Dispatchers.Unconfined,
                repositoryDispatcher = repositoryDispatcher,
            )
            drainMainLooper()
            viewModel.setUnlocked(true)

            viewModel.pair(TEST_PAIRING_TICKET)
            drainMainLooper()
            assertTrue(pairStarted.await(1, TimeUnit.SECONDS))
            assertTrue(viewModel.state.value.loading)

            viewModel.pair(TEST_PAIRING_TICKET_2)
            drainMainLooper()
            assertEquals(listOf(TEST_PAIRING_TICKET), repository.pairedPayloads)

            releasePair.countDown()
            waitForState { viewModel.state.value.pendingPairingSas == TEST_PAIRING_SAS }
            viewModel.confirmPairing()
            waitForState { viewModel.state.value.paired && !viewModel.state.value.loading }

            assertEquals(listOf(TEST_PAIRING_TICKET), repository.pairedPayloads)
        } finally {
            repositoryDispatcher.close()
        }
    }

    @Test
    fun constructorDoesNotBlockOnSavedPairingRestore() {
        val restoreStarted = CountDownLatch(1)
        val restoreRelease = CountDownLatch(1)
        val restoreFinished = CountDownLatch(1)
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onRestore = {
                restoreStarted.countDown()
                assertTrue(restoreRelease.await(2, TimeUnit.SECONDS))
                restoreFinished.countDown()
            },
        )

        val viewModel = ShellyViewModel(
            context,
            repository,
            FakeFcmTokenSource(pending = null, current = null),
        )

        assertFalse(viewModel.state.value.paired)
        assertTrue(viewModel.state.value.restoringPairing)
        assertTrue(restoreStarted.await(1, TimeUnit.SECONDS))

        restoreRelease.countDown()
        assertTrue(restoreFinished.await(1, TimeUnit.SECONDS))
        waitForState { viewModel.state.value.paired }

        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(testPairing(), viewModel.state.value.pairedDaemon)
    }

    @Test
    fun savedPairingRestoreFailureUsesStableMessageWithoutLeakingStorageDetails() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onRestore = {
                throw IllegalStateException("keystore path /data/user/0/app.shelly.android")
            },
        )
        val viewModel = testViewModel(repository)

        assertFalse(viewModel.state.value.restoringPairing)
        assertNull(viewModel.state.value.message)
        assertEquals(
            "Shelly could not read the saved pairing on this phone.",
            viewModel.state.value.pairingError?.message,
        )
        assertEquals(
            "Pair again from your computer if your sessions do not appear.",
            viewModel.state.value.pairingError?.detail,
        )
    }

    @Test
    fun refreshSessionsRunsRepositoryWorkOffMainThread() {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val session = testSession(id = "018f0000-0000-7000-8000-00000000000c")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
            onListSessions = {
                assertFalse(Looper.getMainLooper().isCurrentThread)
                started.countDown()
                assertTrue(release.await(2, TimeUnit.SECONDS))
            },
        )
        val repositoryDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        try {
            val viewModel = ShellyViewModel(
                context,
                repository,
                FakeFcmTokenSource(pending = null, current = null),
                restoreDispatcher = Dispatchers.Unconfined,
                repositoryDispatcher = repositoryDispatcher,
            )
            drainMainLooper()

            viewModel.refreshSessions()
            drainMainLooper()

            assertTrue(started.await(1, TimeUnit.SECONDS))
            assertTrue(viewModel.state.value.loading)
            release.countDown()
            waitForState { viewModel.state.value.sessions == listOf(session) && !viewModel.state.value.loading }
        } finally {
            repositoryDispatcher.close()
        }
    }

    @Test
    fun refreshSessionsCancellationDoesNotShowUserVisibleAlert() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onListSessions = {
                throw CancellationException("refresh canceled")
            },
        )
        val viewModel = testViewModel(repository)

        viewModel.refreshSessions()
        drainMainLooper()

        assertFalse(viewModel.state.value.loading)
        assertNull(viewModel.state.value.message)
        assertEquals(emptyList<MobileSession>(), viewModel.state.value.sessions)
    }

    @Test
    fun refreshSessionsFailureUsesStableMessageWithoutLeakingDaemonDetails() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onListSessions = {
                throw IllegalStateException("daemon node id 12D3 path /tmp/private.sock")
            },
        )
        val viewModel = testViewModel(repository)

        viewModel.refreshSessions()
        drainMainLooper()

        assertFalse(viewModel.state.value.loading)
        assertEquals("SESSION REFRESH FAILED", viewModel.state.value.message?.kicker)
        assertEquals("SYNC", viewModel.state.value.message?.title)
        assertEquals(
            "Shelly could not refresh sessions because Android reported an unexpected error. Try again; if it continues, run `shelly doctor` on your computer.",
            viewModel.state.value.message?.body,
        )
    }

    @Test
    fun terminalAttachAndLagReattachRunRepositoryWorkOffMainThread() = runBlocking {
        val initialAttachStarted = CountDownLatch(1)
        val reattachStarted = CountDownLatch(1)
        val attached = FakeAttachedSession(lastSeenSeq = 77UL)
        val reattached = FakeAttachedSession(lastSeenSeq = 77UL)
        val attachedSeqs = mutableListOf<ULong?>()
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            attachedSessions = ArrayDeque(listOf(attached, reattached)),
            onAttach = { seq ->
                assertFalse(Looper.getMainLooper().isCurrentThread)
                attachedSeqs += seq
                if (seq == null) {
                    initialAttachStarted.countDown()
                } else {
                    reattachStarted.countDown()
                }
            },
        )
        val repositoryDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        try {
            val viewModel = ShellyViewModel(
                context,
                repository,
                FakeFcmTokenSource(pending = null, current = null),
                restoreDispatcher = Dispatchers.Unconfined,
                repositoryDispatcher = repositoryDispatcher,
            )
            drainMainLooper()

            val controller = viewModel.createTerminalController(
                testSession(id = "018f0000-0000-7000-8000-00000000000d"),
                inputGate = { true },
            )
            assertTrue(initialAttachStarted.await(1, TimeUnit.SECONDS))

            controller.onLag(1UL)

            assertTrue(reattachStarted.await(1, TimeUnit.SECONDS))
            assertEquals(listOf(null, 77UL), attachedSeqs)
        } finally {
            repositoryDispatcher.close()
        }
    }

    @Test
    fun clearingViewModelDetachesLiveControllersBeforeDestroyingRepositoryClient() = runBlocking {
        val operations = mutableListOf<String>()
        val attached = FakeAttachedSession(lastSeenSeq = 88UL, operationLog = operations)
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            attachedSessions = ArrayDeque(listOf(attached)),
            operationLog = operations,
        )
        val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val store = ViewModelStore()
        val owner = object : ViewModelStoreOwner {
            override val viewModelStore: ViewModelStore = store
        }
        val factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = ShellyViewModel(
                context,
                repository,
                FakeFcmTokenSource(pending = null, current = null),
                restoreDispatcher = Dispatchers.Unconfined,
                repositoryDispatcher = Dispatchers.Unconfined,
                cleanupScope = cleanupScope,
            ) as T
        }
        val viewModel = ViewModelProvider(owner, factory)[ShellyViewModel::class.java]
        viewModel.createTerminalController(
            testSession(id = "018f0000-0000-7000-8000-00000000000e"),
            inputGate = { true },
        )

        store.clear()

        assertEquals(1, attached.detachCalls)
        assertEquals(1, attached.destroyCalls)
        assertEquals(1, repository.destroyCalls)
        assertEquals(listOf("detach-attachment", "destroy-attachment", "destroy-repository"), operations)
    }

    @Test
    fun pairCancelsPendingSavedPairingRestoreResultAndKeepsFreshRepositoryState() {
        val restoreStarted = CountDownLatch(1)
        val restoreRelease = CountDownLatch(1)
        val stalePairing = testPairing(daemonNodeId = "stale-daemon")
        val freshPairing = testPairing(daemonNodeId = "fresh-daemon")
        val repository = FakeRepository(
            restoredPairing = stalePairing,
            pairResult = freshPairing,
            onRestore = {
                restoreStarted.countDown()
                assertTrue(restoreRelease.await(2, TimeUnit.SECONDS))
            },
        )
        val viewModel = ShellyViewModel(
            context,
            repository,
            FakeFcmTokenSource(pending = null, current = null),
        )

        assertTrue(restoreStarted.await(1, TimeUnit.SECONDS))

        viewModel.pair(TEST_PAIRING_TICKET)
        drainMainLooper()
        waitForState { viewModel.state.value.pendingPairingSas == TEST_PAIRING_SAS }
        viewModel.confirmPairing()
        waitForState { viewModel.state.value.pairedDaemon == freshPairing }

        restoreRelease.countDown()
        waitForState { repository.savedPairing == freshPairing }
        drainMainLooper()

        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(freshPairing, viewModel.state.value.pairedDaemon)
        assertEquals(freshPairing, repository.savedPairing)
    }

    @Test
    fun pairAfterUnpairWithSlowUnregisterPersistsNewPairing() {
        val unregisterStarted = CountDownLatch(1)
        val releaseUnregister = CountDownLatch(1)
        val freshPairing = testPairing(daemonNodeId = "fresh-daemon")
        val repository = FakeRepository(
            restoredPairing = testPairing(daemonNodeId = "stale-daemon"),
            pairResult = freshPairing,
            onUnregisterFcmToken = {
                unregisterStarted.countDown()
                assertTrue(releaseUnregister.await(2, TimeUnit.SECONDS))
            },
        )
        val repositoryDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        try {
            val viewModel = ShellyViewModel(
                context,
                repository,
                FakeFcmTokenSource(pending = null, current = "current-token"),
                restoreDispatcher = Dispatchers.Unconfined,
                repositoryDispatcher = repositoryDispatcher,
            )
            drainMainLooper()
            viewModel.setUnlocked(true)
            waitForState { !viewModel.state.value.loading }

            viewModel.unpair()
            drainMainLooper()
            assertTrue(unregisterStarted.await(1, TimeUnit.SECONDS))

            viewModel.pair(TEST_PAIRING_TICKET)
            drainMainLooper()
            assertEquals(emptyList<String>(), repository.pairedPayloads)

            releaseUnregister.countDown()
            waitForState { viewModel.state.value.pendingPairingSas == TEST_PAIRING_SAS }
            viewModel.confirmPairing()
            waitForState { viewModel.state.value.paired && !viewModel.state.value.loading }

            assertEquals(listOf(TEST_PAIRING_TICKET), repository.pairedPayloads)
            assertEquals(1, repository.clearCalls)
            assertEquals(freshPairing, repository.savedPairing)
            assertEquals(freshPairing, viewModel.state.value.pairedDaemon)
        } finally {
            repositoryDispatcher.close()
        }
    }

    private fun drainMainLooper() {
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun confirmPendingPairing(viewModel: ShellyViewModel) {
        waitForState { viewModel.state.value.pendingPairingSas == TEST_PAIRING_SAS }
        viewModel.confirmPairing()
        waitForState { viewModel.state.value.paired && !viewModel.state.value.loading }
    }

    private fun waitForState(predicate: () -> Boolean) {
        repeat(100) {
            drainMainLooper()
            if (predicate()) {
                return
            }
            Thread.sleep(10)
        }
        assertTrue(predicate())
    }

    private fun testViewModel(
        repository: FakeRepository,
        fcmTokens: FakeFcmTokenSource = FakeFcmTokenSource(pending = null, current = null),
        savedStateHandle: SavedStateHandle = SavedStateHandle(),
        sessionSubscriptionRetryDelayMillis: Long = 750L,
        backgroundDetachGraceMillis: Long = 5 * 60 * 1000L,
        maxRetryDelayMillis: Long = 30_000L,
        unreachableAfterMillis: Long = 60_000L,
        unreachableRetryIntervalMillis: Long = 15_000L,
        now: () -> Long = { System.currentTimeMillis() },
    ): ShellyViewModel {
        return ShellyViewModel(
            context,
            repository,
            fcmTokens,
            savedStateHandle = savedStateHandle,
            restoreDispatcher = Dispatchers.Unconfined,
            repositoryDispatcher = Dispatchers.Unconfined,
            sessionSubscriptionRetryDelayMillis = sessionSubscriptionRetryDelayMillis,
            backgroundDetachGraceMillis = backgroundDetachGraceMillis,
            maxRetryDelayMillis = maxRetryDelayMillis,
            unreachableAfterMillis = unreachableAfterMillis,
            unreachableRetryIntervalMillis = unreachableRetryIntervalMillis,
            now = now,
        ).also {
            drainMainLooper()
        }
    }

    private fun testPairing(daemonNodeId: String = "daemon-node") = PairedDaemonRecord(
        daemonNodeId = daemonNodeId,
        relayUrl = "https://relay.example",
        addrs = emptyList(),
        deviceNodeId = "device-node",
        deviceSecretKey = "device-secret".encodeToByteArray(),
        pairedAtMillis = 1L,
        daemonVersion = "1.0.0",
        hostName = "Test Mac",
        protocolVersion = 3,
    )

    private fun testSession(id: String) = MobileSession(
        id = id,
        name = "bash",
        command = listOf("bash"),
        cwd = "/tmp",
        createdAt = 1UL,
        lastActivity = 2UL,
        state = AgentState.AwaitingInput,
        lastLine = null,
        model = null,
    )

    private fun sha256HexForTest(value: String): String {
        return MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private class FakeFcmTokenSource(
        private var pending: String?,
        private val current: String?,
        private val operationLog: MutableList<String>? = null,
    ) : FcmTokenSource {
        val clearedMatchingTokens = mutableListOf<String>()
        val currentTokenAutoInitRequests = mutableListOf<Boolean>()
        var clearAllCalls = 0
            private set
        var restorePrivacyDefaultCalls = 0
            private set
        var deleteCurrentTokenCalls = 0
            private set

        override fun pendingToken(context: Context): String? = pending

        override suspend fun currentToken(context: Context, enableAutoInit: Boolean): String? {
            currentTokenAutoInitRequests += enableAutoInit
            return current
        }

        override fun restorePrivacyDefault(context: Context) {
            operationLog?.add("restore-privacy-default")
            restorePrivacyDefaultCalls += 1
        }

        override suspend fun deleteCurrentToken(context: Context) {
            operationLog?.add("delete-local-token")
            deleteCurrentTokenCalls += 1
        }

        override fun clearPendingToken(context: Context, token: String) {
            if (pending == token) {
                clearedMatchingTokens += token
                pending = null
            }
        }

        override fun clearPendingToken(context: Context) {
            operationLog?.add("clear-pending-token")
            clearAllCalls += 1
            pending = null
        }
    }

    private class FakeRepository(
        private val restoredPairing: PairedDaemonRecord?,
        private val pairResult: PairedDaemonRecord? = restoredPairing,
        private val sessions: List<MobileSession> = emptyList(),
        private val initialSubscriptionSessions: List<MobileSession>? = sessions,
        private val attachedSessions: ArrayDeque<AttachedSession> = ArrayDeque(),
        private val subscriptionFailures: ArrayDeque<Throwable> = ArrayDeque(),
        private var subscriptionCleanReturnsBeforeHold: Int = 0,
        private val subscriptionAlwaysFails: Boolean = false,
        private val emitOnSubscribe: Boolean = true,
        private val onRestore: (() -> Unit)? = null,
        private val onPair: ((String) -> Unit)? = null,
        private val onListSessions: (() -> Unit)? = null,
        private val onAttach: ((ULong?) -> Unit)? = null,
        private val onRegisterFcmToken: ((String) -> Unit)? = null,
        private val onUnregisterFcmToken: ((String) -> Unit)? = null,
        private val createResult: MobileSession? = null,
        private val onKill: ((String) -> Unit)? = null,
        private val killConfirmation: CompletableDeferred<Unit>? = null,
        private val killFailure: Throwable? = null,
        private val operationLog: MutableList<String>? = null,
    ) : ShellyRepositoryClient {
        override var savedPairing: PairedDaemonRecord? = null
            private set
        val registeredFcmTokens = mutableListOf<String>()
        val unregisteredFcmTokens = mutableListOf<String>()
        val persistedPushTombstones = mutableListOf<List<String>>()
        val acknowledgedPushTokens = mutableListOf<String>()
        val createdNames = mutableListOf<String?>()
        val killedSessionIds = mutableListOf<String>()
        val pairedPayloads = mutableListOf<String>()
        var pairedPayload: String? = null
            private set
        val pairedCodes = mutableListOf<String>()
        var pairedCode: String? = null
            private set
        var clearCalls = 0
            private set
        var subscribeCalls = 0
            private set
        var retryPendingPushUnregisterCalls = 0
            private set
        var destroyCalls = 0
            private set
        var cancelledPairings = 0
            private set
        private var subscriptionSink: ((List<MobileSession>) -> Unit)? = null

        override fun restore(): Boolean {
            onRestore?.invoke()
            if (savedPairing == null) {
                savedPairing = restoredPairing
            }
            return restoredPairing != null
        }

        override suspend fun pair(qrPayload: String): PendingPairingClient {
            pairedPayloads += qrPayload
            pairedPayload = qrPayload
            onPair?.invoke(qrPayload)
            return fakePendingPairing()
        }

        override suspend fun pairWithCode(code: String): PendingPairingClient {
            pairedCodes += code
            pairedCode = code
            onPair?.invoke(code)
            return fakePendingPairing()
        }

        private fun fakePendingPairing(): PendingPairingClient = object : PendingPairingClient {
            override val sas: String = TEST_PAIRING_SAS

            override suspend fun confirm() {
                savedPairing = pairResult
            }

            override suspend fun cancel() {
                cancelledPairings += 1
            }
        }

        override suspend fun listSessions(): List<MobileSession> {
            onListSessions?.invoke()
            return sessions
        }

        override suspend fun liveDaemonVersion(): String? = savedPairing?.daemonVersion

        override suspend fun liveDaemonHostName(): String? = savedPairing?.hostName

        override suspend fun createSession(name: String?): MobileSession {
            createdNames += name
            return createResult ?: MobileSession(
                id = "created-${createdNames.size}",
                name = name ?: "new",
                command = listOf("/bin/zsh"),
                cwd = "/home",
                createdAt = 9UL,
                lastActivity = 9UL,
                state = AgentState.Idle,
                lastLine = null,
                model = null,
            )
        }

        override suspend fun killSession(sessionId: String) {
            killedSessionIds += sessionId
            onKill?.invoke(sessionId)
            killConfirmation?.await()
            killFailure?.let { throw it }
        }

        override suspend fun subscribeSessions(onUpdate: (List<MobileSession>) -> Unit) {
            subscribeCalls += 1
            if (subscriptionAlwaysFails) {
                throw RuntimeException("transport error: connection lost")
            }
            subscriptionFailures.removeFirstOrNull()?.let { throw it }
            subscriptionSink = onUpdate
            if (emitOnSubscribe) {
                initialSubscriptionSessions?.let(onUpdate)
            }
            if (subscriptionCleanReturnsBeforeHold > 0) {
                subscriptionCleanReturnsBeforeHold -= 1
                return
            }
            CompletableDeferred<Unit>().await()
        }

        fun emitSessions(sessions: List<MobileSession>) {
            subscriptionSink?.invoke(sessions)
        }

        override suspend fun attach(sessionId: String, lastSeenSeq: ULong?): AttachedSession {
            onAttach?.invoke(lastSeenSeq)
            return attachedSessions.removeFirstOrNull() ?: error("attach should not be called")
        }

        override fun recordLastSeenSeq(sessionId: String, seq: ULong) = Unit

        override suspend fun registerFcmToken(token: String) {
            onRegisterFcmToken?.invoke(token)
            registeredFcmTokens += token
        }

        override suspend fun unregisterFcmToken(token: String) {
            operationLog?.add("unregister:$token")
            unregisteredFcmTokens += token
            onUnregisterFcmToken?.invoke(token)
        }

        var unpairSelfCalls = 0
            private set

        override suspend fun unpairSelf() {
            operationLog?.add("unpair-self")
            unpairSelfCalls += 1
        }

        override fun persistPushUnregisterTombstone(tokens: List<String>) {
            operationLog?.add("persist-tombstone")
            persistedPushTombstones += tokens
        }

        override fun acknowledgePushTokenUnregistered(token: String) {
            operationLog?.add("ack:$token")
            acknowledgedPushTokens += token
        }

        override suspend fun retryPendingPushUnregister() {
            retryPendingPushUnregisterCalls += 1
        }

        override fun clear() {
            operationLog?.add("clear-repository")
            clearCalls += 1
            savedPairing = null
        }

        override fun clearRevokedPairing() {
            clear()
        }

        override fun destroy() {
            operationLog?.add("destroy-repository")
            destroyCalls += 1
        }
    }

    private class FakeAttachedSession(
        private val lastSeenSeq: ULong,
        private val operationLog: MutableList<String>? = null,
    ) : AttachedSession(NoHandle) {
        var detachCalls = 0
            private set
        var destroyCalls = 0
            private set

        override suspend fun detach() {
            operationLog?.add("detach-attachment")
            detachCalls += 1
        }

        override fun destroy() {
            operationLog?.add("destroy-attachment")
            destroyCalls += 1
        }

        override fun lastSeenSeq(): ULong = lastSeenSeq

        override suspend fun resize(cols: UShort, rows: UShort) = Unit

        override suspend fun sendInput(bytes: ByteArray) = Unit

        override suspend fun subscribe(sink: ByteStreamSink) = Unit
    }
}
