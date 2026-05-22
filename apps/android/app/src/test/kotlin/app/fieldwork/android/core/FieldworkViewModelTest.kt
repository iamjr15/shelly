package app.fieldwork.android.core

import android.content.Context
import android.os.Looper
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
import uniffi.fieldwork_mobile_core.AttachedSession
import uniffi.fieldwork_mobile_core.ByteStreamSink
import uniffi.fieldwork_mobile_core.NoHandle

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class FieldworkViewModelTest {
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
    fun unpairClearsQueuedFcmToken() {
        val repository = FakeRepository(restoredPairing = testPairing())
        val fcmTokens = FakeFcmTokenSource(pending = "queued-token", current = null)
        val viewModel = testViewModel(repository, fcmTokens)

        viewModel.unpair()

        assertEquals(1, fcmTokens.clearAllCalls)
        assertEquals(1, repository.clearCalls)
        assertNull(fcmTokens.pendingToken(context))
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
        viewModel.pair("fieldwork-pair:v1:payload")
        drainMainLooper()

        assertEquals("fieldwork-pair:v1:payload", repository.pairedPayload)
        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(pairing, viewModel.state.value.pairedDaemon)
        assertEquals(listOf(session), viewModel.state.value.sessions)
        assertEquals(1, repository.subscribeCalls)
        assertEquals(listOf("queued-token", "current-token"), repository.registeredFcmTokens)
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
        viewModel.pair("fieldwork-pair:v1:payload")
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

        viewModel.pair("fieldwork-pair:v1:payload")
        drainMainLooper()

        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(emptyList<MobileSession>(), viewModel.state.value.sessions)
        assertEquals(0, repository.subscribeCalls)
        assertEquals(emptyList<String>(), repository.registeredFcmTokens)
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

        val viewModel = FieldworkViewModel(
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
            val viewModel = FieldworkViewModel(
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
            val viewModel = FieldworkViewModel(
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
    fun pairCancelsPendingSavedPairingRestoreResult() {
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
        val viewModel = FieldworkViewModel(
            context,
            repository,
            FakeFcmTokenSource(pending = null, current = null),
        )

        assertTrue(restoreStarted.await(1, TimeUnit.SECONDS))

        viewModel.pair("fieldwork-pair:v1:fresh")
        drainMainLooper()
        waitForState { viewModel.state.value.pairedDaemon == freshPairing }

        restoreRelease.countDown()
        waitForState { repository.savedPairing == stalePairing }
        drainMainLooper()

        assertEquals(true, viewModel.state.value.paired)
        assertFalse(viewModel.state.value.restoringPairing)
        assertEquals(freshPairing, viewModel.state.value.pairedDaemon)
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
    ): FieldworkViewModel {
        return FieldworkViewModel(
            context,
            repository,
            fcmTokens,
            restoreDispatcher = Dispatchers.Unconfined,
            repositoryDispatcher = Dispatchers.Unconfined,
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
        private val onRestore: (() -> Unit)? = null,
        private val onListSessions: (() -> Unit)? = null,
        private val onAttach: ((ULong?) -> Unit)? = null,
    ) : FieldworkRepositoryClient {
        override var savedPairing: PairedDaemonRecord? = null
            private set
        val registeredFcmTokens = mutableListOf<String>()
        var pairedPayload: String? = null
            private set
        var clearCalls = 0
            private set
        var subscribeCalls = 0
            private set
        private var subscriptionSink: ((List<MobileSession>) -> Unit)? = null

        override fun restore(): Boolean {
            onRestore?.invoke()
            savedPairing = restoredPairing
            return restoredPairing != null
        }

        override suspend fun pair(qrPayload: String) {
            pairedPayload = qrPayload
            savedPairing = pairResult
        }

        override suspend fun listSessions(): List<MobileSession> {
            onListSessions?.invoke()
            return sessions
        }

        override suspend fun subscribeSessions(onUpdate: (List<MobileSession>) -> Unit) {
            subscribeCalls += 1
            subscriptionSink = onUpdate
            initialSubscriptionSessions?.let(onUpdate)
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
            registeredFcmTokens += token
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
