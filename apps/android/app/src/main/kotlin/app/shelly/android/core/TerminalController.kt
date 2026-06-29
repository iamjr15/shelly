package app.shelly.android.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.connectbot.terminal.TerminalDimensions
import org.connectbot.terminal.TerminalEmulator
import org.connectbot.terminal.TerminalEmulatorFactory
import uniffi.shelly_mobile_core.AgentStateFfi
import uniffi.shelly_mobile_core.AttachedSession
import uniffi.shelly_mobile_core.ByteStreamSink
import uniffi.shelly_mobile_core.ShellyException
import java.util.concurrent.atomic.AtomicBoolean

data class TerminalUiState(
    val status: String = "Attached",
    val agentState: AgentState = AgentState.Idle,
    val exitedCode: Int? = null,
)

class TerminalController(
    val session: MobileSession,
    initialAttachedSession: AttachedSession,
    private val scope: CoroutineScope,
    private val inputGate: suspend () -> Boolean,
    private val reattach: suspend (ULong?) -> AttachedSession,
    private val recordLastSeenSeq: (ULong) -> Unit,
    private val recordTelemetryExperience: () -> Unit,
    private val terminalWriterForTests: ((ByteArray) -> Unit)? = null,
) : ByteStreamSink {
    private val _state = MutableStateFlow(TerminalUiState(agentState = session.state))
    val state: StateFlow<TerminalUiState> = _state.asStateFlow()

    @Volatile
    private var attachedSession: AttachedSession = initialAttachedSession
    private var subscribeJob: Job? = null
    private var awaitingInputObserved = false
    private var inputSentAfterAwaiting = false
    private var outputLinesAfterResponse = 0
    private var telemetryExperienceRecorded = false
    private val detached = AtomicBoolean(false)
    private val recoveryMutex = Mutex()

    val modifierManager = ShellyModifierManager()

    val emulator: TerminalEmulator = TerminalEmulatorFactory.create(
        initialRows = 24,
        initialCols = 80,
        onKeyboardInput = { bytes ->
            scope.launch { sendInput(bytes) }
        },
        onResize = { dimensions: TerminalDimensions ->
            requestResize(rows = dimensions.rows, columns = dimensions.columns)
        },
    )
    private val terminalWriter: (ByteArray) -> Unit = terminalWriterForTests ?: { bytes ->
        emulator.writeInput(bytes)
    }

    fun start() {
        if (detached.get()) return
        launchSubscribe(cancelExisting = true)
    }

    private fun launchSubscribe(cancelExisting: Boolean) {
        if (cancelExisting) {
            subscribeJob?.cancel()
        }
        val current = attachedSession
        subscribeJob = scope.launch(Dispatchers.IO) {
            try {
                current.subscribe(this@TerminalController)
            } catch (error: Throwable) {
                if (error is CancellationException) {
                    throw error
                }
                recoverAttachment(current, "Reconnecting")
            }
        }
    }

    suspend fun sendInput(bytes: ByteArray) {
        if (detached.get()) return
        if (bytes.isEmpty()) return
        if (!inputGate()) {
            _state.update { it.copy(status = "Locked") }
            modifierManager.clearTransients()
            return
        }
        val current = attachedSession
        try {
            current.sendInput(bytes)
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            if (!detached.get() && shouldRecoverAttachment(error)) {
                recoverAttachment(current, "Reconnecting")
            } else if (!detached.get()) {
                _state.update { it.copy(status = terminalCommandErrorStatus(error)) }
            }
            modifierManager.clearTransients()
            return
        }
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

    internal fun requestResize(rows: Int, columns: Int) {
        if (detached.get() || columns <= 0 || rows <= 0) {
            return
        }
        scope.launch {
            if (!detached.get()) {
                val current = attachedSession
                runCatching {
                    current.resize(
                        cols = columns.toUShort(),
                        rows = rows.toUShort(),
                    )
                }.onFailure { error ->
                    if (error is CancellationException) {
                        throw error
                    }
                    if (!detached.get() && shouldRecoverAttachment(error)) {
                        recoverAttachment(current, "Reconnecting")
                    } else if (!detached.get()) {
                        _state.update { it.copy(status = terminalCommandErrorStatus(error)) }
                    }
                }
            }
        }
    }

    fun detach() {
        if (!detached.compareAndSet(false, true)) {
            return
        }
        subscribeJob?.cancel()
        recordCurrentSeq()
        scope.launch {
            runCatching { attachedSession.detach() }
            attachedSession.destroy()
        }
    }

    override fun onInitialBytes(bytes: ByteArray) {
        if (detached.get()) return
        recordCurrentSeq()
        terminalWriter(bytes)
    }

    override fun onOutput(bytes: ByteArray) {
        if (detached.get()) return
        recordCurrentSeq()
        trackTelemetryExperienceOutput(bytes)
        terminalWriter(bytes)
    }

    override fun onAgentState(state: AgentStateFfi) {
        if (detached.get()) return
        val agentState = state.toAgentState()
        if (agentState == AgentState.AwaitingInput) {
            awaitingInputObserved = true
        }
        _state.update { it.copy(agentState = agentState) }
    }

    override fun onLag(skippedBytes: ULong) {
        if (detached.get()) return
        recordCurrentSeq()
        _state.update { it.copy(status = "Resyncing after $skippedBytes updates") }
        val current = attachedSession
        scope.launch {
            recoverAttachment(current, "Resyncing after $skippedBytes updates")
        }
    }

    override fun onSessionExited(code: Int) {
        if (detached.get()) return
        recordCurrentSeq()
        _state.update { it.copy(status = "Exited $code", exitedCode = code) }
    }

    private fun recordCurrentSeq() {
        recordLastSeenSeq(attachedSession.lastSeenSeq())
    }

    private suspend fun recoverAttachment(failed: AttachedSession, reason: String) {
        recoveryMutex.withLock {
            if (detached.get() || failed !== attachedSession) {
                return
            }
            val lastSeenSeq = failed.lastSeenSeq()
            recordLastSeenSeq(lastSeenSeq)
            runCatching { failed.detach() }
            failed.destroy()

            var attempt = 0
            while (!detached.get()) {
                val status = when {
                    attempt == 0 -> reason
                    else -> "Reconnecting (${attempt + 1})"
                }
                _state.update { it.copy(status = status) }
                try {
                    attachedSession = reattach(lastSeenSeq)
                    if (!detached.get()) {
                        _state.update { it.copy(status = "Attached") }
                        launchSubscribe(cancelExisting = false)
                    }
                    return
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                    _state.update { it.copy(status = terminalCommandErrorStatus(error)) }
                }
                attempt += 1
                delay(reconnectDelayMillis(attempt))
            }
        }
    }

    private fun reconnectDelayMillis(attempt: Int): Long {
        return minOf(5_000L, 250L * (1L shl minOf(attempt, 4)))
    }

    private fun shouldRecoverAttachment(error: Throwable): Boolean {
        return when (error) {
            is ShellyException.Transport,
            is ShellyException.Protocol -> true
            is ShellyException -> false
            else -> true
        }
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
