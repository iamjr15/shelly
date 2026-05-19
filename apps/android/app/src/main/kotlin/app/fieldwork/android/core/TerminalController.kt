package app.fieldwork.android.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.connectbot.terminal.TerminalDimensions
import org.connectbot.terminal.TerminalEmulator
import org.connectbot.terminal.TerminalEmulatorFactory
import uniffi.fieldwork_mobile_core.AgentStateFfi
import uniffi.fieldwork_mobile_core.AttachedSession
import uniffi.fieldwork_mobile_core.ByteStreamSink

data class TerminalUiState(
    val status: String = "Attached",
    val agentState: AgentState = AgentState.Idle,
    val exitedCode: Int? = null,
)

class TerminalController(
    val session: MobileSession,
    private var attachedSession: AttachedSession,
    private val scope: CoroutineScope,
    private val inputGate: suspend () -> Boolean,
    private val reattach: suspend (ULong?) -> AttachedSession,
    private val recordLastSeenSeq: (ULong) -> Unit,
    private val recordTelemetryExperience: () -> Unit,
    private val terminalWriterForTests: ((ByteArray) -> Unit)? = null,
) : ByteStreamSink {
    private val _state = MutableStateFlow(TerminalUiState(agentState = session.state))
    val state: StateFlow<TerminalUiState> = _state.asStateFlow()
    private var subscribeJob: Job? = null
    private var awaitingInputObserved = false
    private var inputSentAfterAwaiting = false
    private var outputLinesAfterResponse = 0
    private var telemetryExperienceRecorded = false
    @Volatile
    private var detached = false

    val modifierManager = FieldworkModifierManager()

    val emulator: TerminalEmulator = TerminalEmulatorFactory.create(
        initialRows = 24,
        initialCols = 80,
        onKeyboardInput = { bytes ->
            scope.launch { sendInput(bytes) }
        },
        onResize = { dimensions: TerminalDimensions ->
            scope.launch {
                attachedSession.resize(
                    cols = dimensions.columns.toUShort(),
                    rows = dimensions.rows.toUShort(),
                )
            }
        },
    )
    private val terminalWriter: (ByteArray) -> Unit = terminalWriterForTests ?: { bytes ->
        emulator.writeInput(bytes)
    }

    fun start() {
        detached = false
        launchSubscribe(cancelExisting = true)
    }

    private fun launchSubscribe(cancelExisting: Boolean) {
        if (cancelExisting) {
            subscribeJob?.cancel()
        }
        subscribeJob = scope.launch(Dispatchers.IO) {
            try {
                attachedSession.subscribe(this@TerminalController)
            } catch (error: Throwable) {
                if (error is CancellationException) {
                    throw error
                }
                recoverAttachment("Reconnecting")
            }
        }
    }

    suspend fun sendInput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        if (!inputGate()) {
            _state.value = _state.value.copy(status = "Locked")
            return
        }
        attachedSession.sendInput(bytes)
        if (awaitingInputObserved || _state.value.agentState == AgentState.AwaitingInput) {
            inputSentAfterAwaiting = true
            outputLinesAfterResponse = 0
        }
        modifierManager.clearTransients()
    }

    fun sendAccessory(bytes: ByteArray) {
        scope.launch {
            sendInput(bytes)
        }
    }

    fun detach() {
        detached = true
        subscribeJob?.cancel()
        recordCurrentSeq()
        scope.launch {
            runCatching { attachedSession.detach() }
            attachedSession.destroy()
        }
    }

    override fun onInitialBytes(bytes: ByteArray) {
        recordCurrentSeq()
        terminalWriter(bytes)
    }

    override fun onOutput(bytes: ByteArray) {
        recordCurrentSeq()
        trackTelemetryExperienceOutput(bytes)
        terminalWriter(bytes)
    }

    override fun onAgentState(state: AgentStateFfi) {
        val agentState = state.toAgentState()
        if (agentState == AgentState.AwaitingInput) {
            awaitingInputObserved = true
        }
        _state.value = _state.value.copy(agentState = agentState)
    }

    override fun onLag(skippedBytes: ULong) {
        recordCurrentSeq()
        _state.value = _state.value.copy(status = "Resyncing after $skippedBytes updates")
        scope.launch {
            val lastSeenSeq = attachedSession.lastSeenSeq()
            recoverAttachment("Resyncing after $skippedBytes updates", lastSeenSeq)
        }
    }

    override fun onSessionExited(code: Int) {
        recordCurrentSeq()
        _state.value = _state.value.copy(status = "Exited $code", exitedCode = code)
    }

    private fun recordCurrentSeq() {
        recordLastSeenSeq(attachedSession.lastSeenSeq())
    }

    private suspend fun recoverAttachment(reason: String, knownLastSeenSeq: ULong? = null) {
        if (detached) {
            return
        }
        val lastSeenSeq = knownLastSeenSeq ?: attachedSession.lastSeenSeq()
        recordLastSeenSeq(lastSeenSeq)
        runCatching { attachedSession.detach() }
        attachedSession.destroy()

        var attempt = 0
        while (!detached) {
            val status = when {
                attempt == 0 -> reason
                else -> "Reconnecting (${attempt + 1})"
            }
            _state.value = _state.value.copy(status = status)
            runCatching {
                attachedSession = reattach(lastSeenSeq)
            }.onSuccess {
                if (!detached) {
                    _state.value = _state.value.copy(status = "Attached")
                    launchSubscribe(cancelExisting = false)
                }
                return
            }.onFailure { error ->
                _state.value = _state.value.copy(status = error.message ?: error.toString())
            }
            attempt += 1
            delay(reconnectDelayMillis(attempt))
        }
    }

    private fun reconnectDelayMillis(attempt: Int): Long {
        return minOf(5_000L, 250L * (1L shl minOf(attempt, 4)))
    }

    private fun trackTelemetryExperienceOutput(bytes: ByteArray) {
        if (!inputSentAfterAwaiting || telemetryExperienceRecorded) {
            return
        }
        outputLinesAfterResponse += bytes.count { it == '\n'.code.toByte() }
        if (outputLinesAfterResponse >= 10) {
            telemetryExperienceRecorded = true
            recordTelemetryExperience()
        }
    }
}

private fun AgentStateFfi.toAgentState(): AgentState = when (this) {
    AgentStateFfi.AWAITING_INPUT -> AgentState.AwaitingInput
    AgentStateFfi.WORKING -> AgentState.Working
    AgentStateFfi.CRASHED -> AgentState.Crashed
    AgentStateFfi.IDLE -> AgentState.Idle
}
