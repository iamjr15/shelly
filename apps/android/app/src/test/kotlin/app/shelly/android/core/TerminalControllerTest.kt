package app.shelly.android.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import uniffi.shelly_mobile_core.AgentStateFfi
import uniffi.shelly_mobile_core.AttachedSession
import uniffi.shelly_mobile_core.ByteStreamSink
import uniffi.shelly_mobile_core.ShellyException
import uniffi.shelly_mobile_core.NoHandle

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class TerminalControllerTest {
    @Test
    fun lockedInputDoesNotReachAttachedSession() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 7UL)
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { false },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.modifierManager.toggleCtrl()
        controller.modifierManager.toggleAlt()
        controller.sendInput(byteArrayOf('x'.code.toByte()))

        assertEquals("Locked", controller.state.value.status)
        assertNull(attached.lastInput)
        assertEquals(false, controller.modifierManager.ctrl)
        assertEquals(false, controller.modifierManager.alt)
        scope.cancel()
    }

    @Test
    fun accessoryInputUsesSameBiometricGateAsKeyboardInput() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val lockedAttachment = FakeAttachedSession(lastSeenSeq = 8UL)
        val lockedController = TerminalController(
            session = testSession(),
            initialAttachedSession = lockedAttachment,
            scope = scope,
            inputGate = { false },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        lockedController.modifierManager.toggleCtrl()
        lockedController.sendAccessory(byteArrayOf(0x03))

        assertEquals("Locked", lockedController.state.value.status)
        assertNull(lockedAttachment.lastInput)
        assertEquals(false, lockedController.modifierManager.ctrl)

        val unlockedAttachment = FakeAttachedSession(lastSeenSeq = 9UL)
        val unlockedController = TerminalController(
            session = testSession(),
            initialAttachedSession = unlockedAttachment,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        unlockedController.sendAccessory(byteArrayOf(0x04))

        assertArrayEquals(byteArrayOf(0x04), unlockedAttachment.lastInput)
        scope.cancel()
    }

    @Test
    fun lagReattachesFromLatestLastSeenSeq() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val oldAttachment = FakeAttachedSession(lastSeenSeq = 42UL)
        val newSubscribed = CompletableDeferred<Unit>()
        val newAttachment = FakeAttachedSession(
            lastSeenSeq = 42UL,
            onSubscribe = { newSubscribed.complete(Unit) },
        )
        val reattachedFrom = CompletableDeferred<ULong?>()
        val recordedOffsets = mutableListOf<ULong>()
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = oldAttachment,
            scope = scope,
            inputGate = { true },
            reattach = { lastSeenSeq ->
                reattachedFrom.complete(lastSeenSeq)
                newAttachment
            },
            recordLastSeenSeq = { recordedOffsets += it },
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.onLag(3UL)

        assertEquals(42UL, withTimeout(1_000) { reattachedFrom.await() })
        withTimeout(1_000) { newSubscribed.await() }
        assertEquals(listOf(42UL, 42UL), recordedOffsets)
        assertEquals(1, oldAttachment.detachCalls)
        assertEquals(1, oldAttachment.destroyCalls)
        assertEquals("Attached", controller.state.value.status)
        assertEquals(1, newAttachment.subscribeCalls)
        scope.cancel()
    }

    @Test
    fun streamErrorReattachesFromLatestLastSeenSeq() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val oldAttachment = FakeAttachedSession(
            lastSeenSeq = 64UL,
            subscribeFailure = IllegalStateException("stream closed"),
        )
        val newSubscribed = CompletableDeferred<Unit>()
        val newAttachment = FakeAttachedSession(
            lastSeenSeq = 64UL,
            onSubscribe = { newSubscribed.complete(Unit) },
        )
        val reattachedFrom = CompletableDeferred<ULong?>()
        val recordedOffsets = mutableListOf<ULong>()
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = oldAttachment,
            scope = scope,
            inputGate = { true },
            reattach = { lastSeenSeq ->
                reattachedFrom.complete(lastSeenSeq)
                newAttachment
            },
            recordLastSeenSeq = { recordedOffsets += it },
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.start()

        assertEquals(64UL, withTimeout(1_000) { reattachedFrom.await() })
        withTimeout(1_000) { newSubscribed.await() }
        assertEquals(listOf(64UL), recordedOffsets)
        assertEquals(1, oldAttachment.detachCalls)
        assertEquals(1, oldAttachment.destroyCalls)
        assertEquals("Attached", controller.state.value.status)
        assertEquals(1, oldAttachment.subscribeCalls)
        assertEquals(1, newAttachment.subscribeCalls)
        scope.cancel()
    }

    @Test
    fun failedReattachUsesStableStatusWithoutLeakingTransportDetails() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 66UL)
        val reattachAttempted = CompletableDeferred<Unit>()
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = {
                reattachAttempted.complete(Unit)
                throw IllegalStateException("node id 12D3 path /Users/example/private")
            },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.onLag(1UL)
        withTimeout(1_000) { reattachAttempted.await() }

        assertEquals("Connection lost", controller.state.value.status)
        scope.cancel()
    }

    @Test
    fun reattachCancellationKeepsReconnectStatusAndDoesNotConvertToErrorMessage() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 65UL)
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { throw CancellationException("reattach canceled") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.onLag(1UL)

        assertEquals("Resyncing after 1 updates", controller.state.value.status)
        assertEquals(1, attached.detachCalls)
        assertEquals(1, attached.destroyCalls)
        scope.cancel()
    }

    @Test
    fun outputAfterAwaitingInputResponseRecordsTelemetryExperienceAfterTenLines() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var telemetryExperienceCount = 0
        val attached = FakeAttachedSession(lastSeenSeq = 9UL)
        val controller = TerminalController(
            session = testSession(state = AgentState.Idle),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = { telemetryExperienceCount += 1 },
            terminalWriterForTests = {},
        )

        controller.onAgentState(AgentStateFfi.AWAITING_INPUT)
        controller.sendInput(byteArrayOf('y'.code.toByte()))
        controller.onOutput("1\n2\n3\n4\n5\n6\n7\n8\n9\n".encodeToByteArray())
        controller.onOutput("10\n11\n".encodeToByteArray())

        assertArrayEquals(byteArrayOf('y'.code.toByte()), attached.lastInput)
        assertEquals(1, telemetryExperienceCount)
        scope.cancel()
    }

    @Test
    fun sendInputErrorUpdatesStatusWithoutRecordingResponseTelemetry() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var telemetryExperienceCount = 0
        val attached = FakeAttachedSession(
            lastSeenSeq = 15UL,
            sendInputFailure = ShellyException.NotFound("session not found"),
        )
        val controller = TerminalController(
            session = testSession(state = AgentState.AwaitingInput),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = { telemetryExperienceCount += 1 },
            terminalWriterForTests = {},
        )

        controller.modifierManager.toggleCtrl()
        controller.modifierManager.toggleAlt()
        controller.sendInput(byteArrayOf('x'.code.toByte()))
        controller.onOutput("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n".encodeToByteArray())

        assertEquals("Session ended", controller.state.value.status)
        assertNull(attached.lastInput)
        assertEquals(false, controller.modifierManager.ctrl)
        assertEquals(false, controller.modifierManager.alt)
        assertEquals(0, telemetryExperienceCount)
        scope.cancel()
    }

    @Test
    fun sendInputTransportErrorReattachesFromLatestLastSeenSeq() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(
            lastSeenSeq = 17UL,
            sendInputFailure = ShellyException.Transport("node id 12D3 path /Users/example/private"),
        )
        val newSubscribed = CompletableDeferred<Unit>()
        val reattached = FakeAttachedSession(
            lastSeenSeq = 17UL,
            onSubscribe = { newSubscribed.complete(Unit) },
        )
        val reattachedFrom = CompletableDeferred<ULong?>()
        val controller = TerminalController(
            session = testSession(state = AgentState.AwaitingInput),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { lastSeenSeq ->
                reattachedFrom.complete(lastSeenSeq)
                reattached
            },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.sendInput(byteArrayOf('x'.code.toByte()))

        assertEquals(17UL, withTimeout(1_000) { reattachedFrom.await() })
        withTimeout(1_000) { newSubscribed.await() }
        assertEquals("Attached", controller.state.value.status)
        assertNull(attached.lastInput)
        assertEquals(1, attached.detachCalls)
        assertEquals(1, attached.destroyCalls)
        assertEquals(1, reattached.subscribeCalls)
        scope.cancel()
    }

    @Test
    fun staleSubscribeFailureDoesNotDestroyFreshAttachment() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val oldSubscribeStarted = CompletableDeferred<Unit>()
        val releaseOldSubscribe = CompletableDeferred<Unit>()
        val oldSubscribeFailed = CompletableDeferred<Unit>()
        val oldAttachment = FakeAttachedSession(
            lastSeenSeq = 21UL,
            sendInputFailure = ShellyException.Transport("connection lost"),
            onSubscribe = {
                oldSubscribeStarted.complete(Unit)
                releaseOldSubscribe.await()
                oldSubscribeFailed.complete(Unit)
                throw IllegalStateException("stream closed")
            },
        )
        val newSubscribed = CompletableDeferred<Unit>()
        val newAttachment = FakeAttachedSession(
            lastSeenSeq = 21UL,
            onSubscribe = { newSubscribed.complete(Unit) },
        )
        var reattachCalls = 0
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = oldAttachment,
            scope = scope,
            inputGate = { true },
            reattach = {
                reattachCalls += 1
                newAttachment
            },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.start()
        withTimeout(1_000) { oldSubscribeStarted.await() }

        controller.sendInput(byteArrayOf('x'.code.toByte()))
        withTimeout(1_000) { newSubscribed.await() }

        releaseOldSubscribe.complete(Unit)
        withTimeout(1_000) { oldSubscribeFailed.await() }
        delay(200)

        assertEquals(1, reattachCalls)
        assertEquals(1, oldAttachment.detachCalls)
        assertEquals(1, oldAttachment.destroyCalls)
        assertEquals(0, newAttachment.destroyCalls)
        assertEquals(1, newAttachment.subscribeCalls)
        assertEquals("Attached", controller.state.value.status)
        scope.cancel()
    }

    @Test
    fun terminalResizePropagatesPositiveRendererDimensionsToAttachedSession() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 10UL)
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.requestResize(rows = 40, columns = 120)

        assertEquals(listOf(120.toUShort() to 40.toUShort()), attached.resizeCalls)
        scope.cancel()
    }

    @Test
    fun terminalResizeErrorUpdatesStatusWithoutCrashingScope() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(
            lastSeenSeq = 16UL,
            resizeFailure = ShellyException.NotFound("session not found"),
        )
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.requestResize(rows = 40, columns = 120)

        assertEquals("Session ended", controller.state.value.status)
        assertEquals(emptyList<Pair<UShort, UShort>>(), attached.resizeCalls)
        scope.cancel()
    }

    @Test
    fun terminalResizeTransportErrorReattachesFromLatestLastSeenSeq() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(
            lastSeenSeq = 18UL,
            resizeFailure = ShellyException.Transport("node id 12D3 path /Users/example/private"),
        )
        val newSubscribed = CompletableDeferred<Unit>()
        val reattached = FakeAttachedSession(
            lastSeenSeq = 18UL,
            onSubscribe = { newSubscribed.complete(Unit) },
        )
        val reattachedFrom = CompletableDeferred<ULong?>()
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { lastSeenSeq ->
                reattachedFrom.complete(lastSeenSeq)
                reattached
            },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.requestResize(rows = 40, columns = 120)

        assertEquals(18UL, withTimeout(1_000) { reattachedFrom.await() })
        withTimeout(1_000) { newSubscribed.await() }
        assertEquals("Attached", controller.state.value.status)
        assertEquals(emptyList<Pair<UShort, UShort>>(), attached.resizeCalls)
        assertEquals(1, attached.detachCalls)
        assertEquals(1, attached.destroyCalls)
        assertEquals(1, reattached.subscribeCalls)
        scope.cancel()
    }

    @Test
    fun terminalResizeIgnoresInvalidDimensionsAndDetachedController() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 11UL)
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.requestResize(rows = 0, columns = 120)
        controller.requestResize(rows = 40, columns = 0)
        controller.detach()
        controller.requestResize(rows = 40, columns = 120)

        assertEquals(emptyList<Pair<UShort, UShort>>(), attached.resizeCalls)
        scope.cancel()
    }

    @Test
    fun terminalDetachIsIdempotent() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 12UL)
        val recordedOffsets = mutableListOf<ULong>()
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = { recordedOffsets += it },
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.detach()
        controller.detach()

        assertEquals(listOf(12UL), recordedOffsets)
        assertEquals(1, attached.detachCalls)
        assertEquals(1, attached.destroyCalls)
        scope.cancel()
    }

    @Test
    fun detachedControllerIgnoresStaleInputAndStreamCallbacks() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 13UL)
        val recordedOffsets = mutableListOf<ULong>()
        val terminalWrites = mutableListOf<ByteArray>()
        var inputGateCalls = 0
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = {
                inputGateCalls += 1
                true
            },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = { recordedOffsets += it },
            recordTelemetryExperience = {},
            terminalWriterForTests = { terminalWrites += it },
        )

        controller.detach()
        controller.sendInput(byteArrayOf('z'.code.toByte()))
        controller.onInitialBytes("initial".encodeToByteArray())
        controller.onOutput("late\n".encodeToByteArray())
        controller.onAgentState(AgentStateFfi.AWAITING_INPUT)
        controller.onLag(2UL)
        controller.onSessionExited(0)

        assertEquals(listOf(13UL), recordedOffsets)
        assertEquals(0, inputGateCalls)
        assertNull(attached.lastInput)
        assertEquals(emptyList<ByteArray>(), terminalWrites)
        assertEquals("Attached", controller.state.value.status)
        assertEquals(AgentState.Idle, controller.state.value.agentState)
        assertNull(controller.state.value.exitedCode)
        assertEquals(1, attached.detachCalls)
        assertEquals(1, attached.destroyCalls)
        scope.cancel()
    }

    @Test
    fun detachedControllerDoesNotRestartDestroyedAttachment() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val subscribed = CompletableDeferred<Unit>()
        val attached = FakeAttachedSession(
            lastSeenSeq = 14UL,
            onSubscribe = { subscribed.complete(Unit) },
        )
        val controller = TerminalController(
            session = testSession(),
            initialAttachedSession = attached,
            scope = scope,
            inputGate = { true },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.start()
        withTimeout(1_000) { subscribed.await() }
        controller.detach()
        controller.start()

        assertEquals(1, attached.subscribeCalls)
        assertEquals(1, attached.detachCalls)
        assertEquals(1, attached.destroyCalls)
        scope.cancel()
    }

    private fun testSession(state: AgentState = AgentState.Idle): MobileSession = MobileSession(
        id = "018f0000-0000-7000-8000-000000000001",
        name = "bash",
        command = listOf("bash"),
        cwd = "/tmp",
        createdAt = 1UL,
        lastActivity = 2UL,
        state = state,
        lastLine = null,
        model = null,
    )

    private class FakeAttachedSession(
        private var lastSeenSeq: ULong,
        private val subscribeFailure: Throwable? = null,
        private val sendInputFailure: Throwable? = null,
        private val resizeFailure: Throwable? = null,
        private val onSubscribe: (suspend () -> Unit)? = null,
    ) : AttachedSession(NoHandle) {
        var detachCalls = 0
            private set
        var destroyCalls = 0
            private set
        var subscribeCalls = 0
            private set
        val resizeCalls = mutableListOf<Pair<UShort, UShort>>()
        var lastInput: ByteArray? = null
            private set

        override suspend fun detach() {
            detachCalls += 1
        }

        override fun destroy() {
            destroyCalls += 1
        }

        override fun initialSeq(): ULong = lastSeenSeq

        override fun lastSeenSeq(): ULong = lastSeenSeq

        override suspend fun resize(cols: UShort, rows: UShort) {
            resizeFailure?.let { throw it }
            resizeCalls += cols to rows
        }

        override suspend fun sendInput(bytes: ByteArray) {
            sendInputFailure?.let { throw it }
            lastInput = bytes
        }

        override suspend fun subscribe(sink: ByteStreamSink) {
            subscribeCalls += 1
            onSubscribe?.invoke()
            subscribeFailure?.let { throw it }
        }
    }
}
