package app.fieldwork.android.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import uniffi.fieldwork_mobile_core.AgentStateFfi
import uniffi.fieldwork_mobile_core.AttachedSession
import uniffi.fieldwork_mobile_core.ByteStreamSink
import uniffi.fieldwork_mobile_core.NoHandle

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class TerminalControllerTest {
    @Test
    fun lockedInputDoesNotReachAttachedSession() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val attached = FakeAttachedSession(lastSeenSeq = 7UL)
        val controller = TerminalController(
            session = testSession(),
            attachedSession = attached,
            scope = scope,
            inputGate = { false },
            reattach = { error("reattach should not be called") },
            recordLastSeenSeq = {},
            recordTelemetryExperience = {},
            terminalWriterForTests = {},
        )

        controller.sendInput(byteArrayOf('x'.code.toByte()))

        assertEquals("Locked", controller.state.value.status)
        assertNull(attached.lastInput)
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
            attachedSession = oldAttachment,
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
            attachedSession = oldAttachment,
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
    fun outputAfterAwaitingInputResponseRecordsTelemetryExperienceAfterTenLines() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var telemetryExperienceCount = 0
        val attached = FakeAttachedSession(lastSeenSeq = 9UL)
        val controller = TerminalController(
            session = testSession(state = AgentState.Idle),
            attachedSession = attached,
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
        private val onSubscribe: (() -> Unit)? = null,
    ) : AttachedSession(NoHandle) {
        var detachCalls = 0
            private set
        var destroyCalls = 0
            private set
        var subscribeCalls = 0
            private set
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

        override suspend fun resize(cols: UShort, rows: UShort) = Unit

        override suspend fun sendInput(bytes: ByteArray) {
            lastInput = bytes
        }

        override suspend fun subscribe(sink: ByteStreamSink) {
            subscribeCalls += 1
            onSubscribe?.invoke()
            subscribeFailure?.let { throw it }
        }
    }
}
