package app.shelly.android.core

import android.content.Context
import android.os.Looper
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ShellyViewModelTest {
    private companion object {
        const val TEST_PAIRING_TICKET = "sh1testpairingticket"
        const val TEST_PAIRING_TICKET_2 = "sh1secondtestpairingticket"
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
        assertEquals(1, repository.clearCalls)
        assertNull(fcmTokens.pendingToken(context))
        assertFalse(viewModel.state.value.restoringPairing)
        assertFalse(viewModel.state.value.paired)
        assertEquals(emptyList<MobileSession>(), viewModel.state.value.sessions)
        assertNull(viewModel.state.value.activeTerminalSessionId)
    }

    @Test
    fun unpairUnregistersPendingAndCurrentFcmTokensBeforeClearingRepository() {
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            onRegisterFcmToken = { throw IllegalStateException("offline during sync") },
        )
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = "current-token")
        val viewModel = testViewModel(repository, fcmTokens)
        viewModel.setUnlocked(true)
        drainMainLooper()

        viewModel.unpair()
        drainMainLooper()

        assertEquals(listOf("queued-token", "current-token"), repository.unregisteredFcmTokens)
        assertEquals(1, fcmTokens.clearAllCalls)
        assertEquals(1, repository.clearCalls)
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
        assertEquals(1, fcmTokens.clearAllCalls)
        assertEquals(1, repository.clearCalls)
        assertFalse(viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
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
    }

    @Test
    fun activeTerminalSessionClearsWhenSessionDisappears() {
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

        assertNull(viewModel.state.value.activeTerminalSessionId)
    }

    @Test
    fun setLockedClearsActiveTerminalSession() {
        val session = testSession(id = "018f0000-0000-7000-8000-0000000000a3")
        val repository = FakeRepository(
            restoredPairing = testPairing(),
            sessions = listOf(session),
        )
        val viewModel = testViewModel(repository)

        viewModel.openTerminalSession(session)
        viewModel.setUnlocked(false)

        assertNull(viewModel.state.value.activeTerminalSessionId)
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
        viewModel.pairWithCode("AB12C")
        drainMainLooper()

        assertEquals("AB12C", repository.pairedCode)
        assertEquals(emptyList<String>(), repository.pairedPayloads)
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

        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(emptyList<MobileSession>(), viewModel.state.value.sessions)
        assertEquals(0, repository.subscribeCalls)
        assertEquals(emptyList<String>(), repository.registeredFcmTokens)
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

        viewModel.pairWithCode("AB12C")
        drainMainLooper()

        assertFalse(viewModel.state.value.loading)
        assertFalse(viewModel.state.value.paired)
        assertEquals("Pairing failed", viewModel.state.value.message)
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
        assertEquals("Saved pairing unavailable", viewModel.state.value.message)
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
        assertEquals("Sessions unavailable", viewModel.state.value.message)
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
        sessionSubscriptionRetryDelayMillis: Long = 750L,
        backgroundDetachGraceMillis: Long = 5 * 60 * 1000L,
    ): ShellyViewModel {
        return ShellyViewModel(
            context,
            repository,
            fcmTokens,
            restoreDispatcher = Dispatchers.Unconfined,
            repositoryDispatcher = Dispatchers.Unconfined,
            sessionSubscriptionRetryDelayMillis = sessionSubscriptionRetryDelayMillis,
            backgroundDetachGraceMillis = backgroundDetachGraceMillis,
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
    ) : FcmTokenSource {
        val clearedMatchingTokens = mutableListOf<String>()
        var clearAllCalls = 0
            private set

        override fun pendingToken(context: Context): String? = pending

        override suspend fun currentToken(context: Context): String? = current

        override fun clearPendingToken(context: Context, token: String) {
            if (pending == token) {
                clearedMatchingTokens += token
                pending = null
            }
        }

        override fun clearPendingToken(context: Context) {
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
        private val onRestore: (() -> Unit)? = null,
        private val onPair: ((String) -> Unit)? = null,
        private val onListSessions: (() -> Unit)? = null,
        private val onAttach: ((ULong?) -> Unit)? = null,
        private val onRegisterFcmToken: ((String) -> Unit)? = null,
        private val onUnregisterFcmToken: ((String) -> Unit)? = null,
    ) : ShellyRepositoryClient {
        override var savedPairing: PairedDaemonRecord? = null
            private set
        val registeredFcmTokens = mutableListOf<String>()
        val unregisteredFcmTokens = mutableListOf<String>()
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
        private var subscriptionSink: ((List<MobileSession>) -> Unit)? = null

        override fun restore(): Boolean {
            onRestore?.invoke()
            if (savedPairing == null) {
                savedPairing = restoredPairing
            }
            return restoredPairing != null
        }

        override suspend fun pair(qrPayload: String) {
            pairedPayloads += qrPayload
            pairedPayload = qrPayload
            onPair?.invoke(qrPayload)
            savedPairing = pairResult
        }

        override suspend fun pairWithCode(code: String) {
            pairedCodes += code
            pairedCode = code
            onPair?.invoke(code)
            savedPairing = pairResult
        }

        override suspend fun listSessions(): List<MobileSession> {
            onListSessions?.invoke()
            return sessions
        }

        override suspend fun subscribeSessions(onUpdate: (List<MobileSession>) -> Unit) {
            subscribeCalls += 1
            subscriptionFailures.removeFirstOrNull()?.let { throw it }
            subscriptionSink = onUpdate
            initialSubscriptionSessions?.let(onUpdate)
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
            unregisteredFcmTokens += token
            onUnregisterFcmToken?.invoke(token)
        }

        override fun clear() {
            clearCalls += 1
            savedPairing = null
        }
    }

    private class FakeAttachedSession(
        private val lastSeenSeq: ULong,
    ) : AttachedSession(NoHandle) {
        override suspend fun detach() = Unit

        override fun destroy() = Unit

        override fun initialSeq(): ULong = lastSeenSeq

        override fun lastSeenSeq(): ULong = lastSeenSeq

        override suspend fun resize(cols: UShort, rows: UShort) = Unit

        override suspend fun sendInput(bytes: ByteArray) = Unit

        override suspend fun subscribe(sink: ByteStreamSink) = Unit
    }
}
