package app.shelly.android.core

import android.os.Handler
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
import java.util.concurrent.atomic.AtomicReference

sealed interface TerminalPhase {
    data object Attached : TerminalPhase
    data object Locked : TerminalPhase
    data class Reconnecting(val attempt: Int? = null) : TerminalPhase
    data class Resyncing(val skippedBytes: ULong) : TerminalPhase
    data class Exited(val code: Int) : TerminalPhase
    data class Error(val kind: TerminalErrorKind) : TerminalPhase
}

enum class TerminalErrorKind {
    SessionEnded,
    Unpaired,
    Denied,
    ConnectionLost,
}

data class TerminalUiState(
    val phase: TerminalPhase = TerminalPhase.Attached,
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
    private val detachScope: CoroutineScope = scope,
    private val onDetached: () -> Unit = {},
) : ByteStreamSink {
    private val _state = MutableStateFlow(TerminalUiState(agentState = session.state))
    val state: StateFlow<TerminalUiState> = _state.asStateFlow()

    private val attachedSession = AtomicReference<AttachedSession?>(initialAttachedSession)
    private var subscribeJob: Job? = null
    private var awaitingInputObserved = false
    private var inputSentAfterAwaiting = false
    private var outputLinesAfterResponse = 0
    private var telemetryExperienceRecorded = false
    private val detached = AtomicBoolean(false)
    private val recoveryMutex = Mutex()

    val modifierManager = ShellyModifierManager()

    @Volatile
    private var terminalEmulator: TerminalEmulator? = TerminalEmulatorFactory.create(
        initialRows = 24,
        initialCols = 80,
        onKeyboardInput = { bytes ->
            scope.launch { sendInput(bytes) }
        },
        onResize = { dimensions: TerminalDimensions ->
            requestResize(rows = dimensions.rows, columns = dimensions.columns)
        },
    )

    val emulator: TerminalEmulator
        get() = checkNotNull(terminalEmulator) { "Terminal emulator has been detached" }

    private val terminalWriter: (ByteArray) -> Unit = terminalWriterForTests ?: { bytes ->
        terminalEmulator?.writeInput(bytes)
    }

    fun start() {
        if (detached.get()) return
        launchSubscribe(cancelExisting = true)
    }

    private fun launchSubscribe(cancelExisting: Boolean) {
        if (detached.get()) {
            return
        }
        if (cancelExisting) {
            subscribeJob?.cancel()
        }
        val current = attachedSession.get() ?: return
        subscribeJob = scope.launch(Dispatchers.IO) {
            try {
                current.subscribe(this@TerminalController)
            } catch (error: Throwable) {
                if (error is CancellationException) {
                    throw error
                }
                recoverAttachment(current, TerminalPhase.Reconnecting())
            }
        }
    }

    suspend fun sendInput(bytes: ByteArray) {
        if (detached.get()) return
        if (bytes.isEmpty()) return
        if (!inputGate()) {
            _state.update { it.copy(phase = TerminalPhase.Locked) }
            modifierManager.clearTransients()
            return
        }
        val current = attachedSession.get() ?: return
        try {
            current.sendInput(bytes)
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            if (!detached.get() && shouldRecoverAttachment(error)) {
                recoverAttachment(current, TerminalPhase.Reconnecting())
            } else if (!detached.get()) {
                _state.update { it.copy(phase = terminalCommandErrorPhase(error)) }
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

    fun resumeAfterUnlock() {
        _state.update { current ->
            if (current.phase is TerminalPhase.Locked) {
                current.copy(phase = TerminalPhase.Attached)
            } else {
                current
            }
        }
    }

    internal fun requestResize(rows: Int, columns: Int) {
        if (detached.get() || columns <= 0 || rows <= 0) {
            return
        }
        scope.launch {
            if (!detached.get()) {
                val current = attachedSession.get() ?: return@launch
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
                        recoverAttachment(current, TerminalPhase.Reconnecting())
                    } else if (!detached.get()) {
                        _state.update { it.copy(phase = terminalCommandErrorPhase(error)) }
                    }
                }
            }
        }
    }

    fun detach(): Job? {
        if (!detached.compareAndSet(false, true)) {
            return null
        }
        subscribeJob?.cancel()
        val current = attachedSession.getAndSet(null)
        current?.let(::recordCurrentSeq)
        tearDownTerminalEmulator()
        onDetached()
        return current?.let { attachment ->
            detachScope.launch {
                runCatching { attachment.detach() }
                    .onFailure { debugLog("terminal detach RPC failed", it, "ShellyTerminal") }
                attachment.destroy()
            }
        }
    }

    override fun onInitialBytes(bytes: ByteArray) {
        if (detached.get()) return
        terminalWriter(bytes)
    }

    override fun onOutput(bytes: ByteArray) {
        if (detached.get()) return
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
        val current = attachedSession.get() ?: return
        recordCurrentSeq(current)
        val phase = TerminalPhase.Resyncing(skippedBytes)
        _state.update { it.copy(phase = phase) }
        scope.launch {
            recoverAttachment(current, phase)
        }
    }

    override fun onSessionExited(code: Int) {
        if (detached.get()) return
        attachedSession.get()?.let(::recordCurrentSeq)
        _state.update { it.copy(phase = TerminalPhase.Exited(code), exitedCode = code) }
    }

    private fun recordCurrentSeq(attachment: AttachedSession) {
        runCatching { recordLastSeenSeq(attachment.lastSeenSeq()) }
            .onFailure { debugLog("could not record terminal sequence", it, "ShellyTerminal") }
    }

    private suspend fun recoverAttachment(failed: AttachedSession, initialPhase: TerminalPhase) {
        recoveryMutex.withLock {
            if (detached.get() || failed !== attachedSession.get()) {
                return
            }
            val lastSeenSeq = runCatching { failed.lastSeenSeq() }.getOrElse { error ->
                if (detached.get() || failed !== attachedSession.get()) {
                    return
                }
                throw error
            }
            recordLastSeenSeq(lastSeenSeq)
            runCatching { failed.detach() }
                .onFailure { debugLog("terminal recovery detach failed", it, "ShellyTerminal") }
            if (!attachedSession.compareAndSet(failed, null)) {
                return
            }
            failed.destroy()

            var attempt = 0
            while (!detached.get()) {
                val phase = when {
                    attempt == 0 -> initialPhase
                    else -> TerminalPhase.Reconnecting(attempt + 1)
                }
                _state.update { it.copy(phase = phase) }
                try {
                    val replacement = reattach(lastSeenSeq)
                    if (detached.get() || !attachedSession.compareAndSet(null, replacement)) {
                        releaseAttachment(replacement)
                        return
                    }
                    if (detached.get()) {
                        if (attachedSession.compareAndSet(replacement, null)) {
                            releaseAttachment(replacement)
                        }
                        return
                    }
                    _state.update { it.copy(phase = TerminalPhase.Attached) }
                    launchSubscribe(cancelExisting = false)
                    return
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                    _state.update { it.copy(phase = terminalCommandErrorPhase(error)) }
                }
                attempt += 1
                delay(reconnectDelayMillis(attempt))
            }
        }
    }

    private fun releaseAttachment(attachment: AttachedSession) {
        detachScope.launch {
            runCatching { attachment.detach() }
                .onFailure { debugLog("terminal replacement detach failed", it, "ShellyTerminal") }
            attachment.destroy()
        }
    }

    private fun tearDownTerminalEmulator() {
        val emulator = terminalEmulator ?: return
        // TODO(upstream-termlib): add close() to pinned termlib 0.1.0 and replace this reflective
        // best-effort cleanup with the supported API once the upstream release exposes it.
        runCatching {
            generateSequence(emulator.javaClass as Class<*>?) { it.superclass }
                .flatMap { type -> type.declaredFields.asSequence() }
                .firstOrNull { field -> Handler::class.java.isAssignableFrom(field.type) }
                ?.let { field ->
                    field.isAccessible = true
                    (field.get(emulator) as? Handler)?.removeCallbacksAndMessages(null)
                }
        }.onFailure { error ->
            debugLog("termlib handler cleanup failed", error, "ShellyTerminal")
        }
        terminalEmulator = null
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
