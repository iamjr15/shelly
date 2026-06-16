package app.shelly.android.core

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shelly.android.push.FcmTokenRegistrar
import app.shelly.android.push.ShellyPushNotifications
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.security.MessageDigest

data class ShellyUiState(
    val unlocked: Boolean = false,
    val paired: Boolean = false,
    val restoringPairing: Boolean = true,
    val sessions: List<MobileSession> = emptyList(),
    val loading: Boolean = false,
    val message: String? = null,
    val pairedDaemon: PairedDaemonRecord? = null,
    val targetSession: MobileSession? = null,
    val activeTerminalSessionId: String? = null,
    val telemetryConsentPromptVisible: Boolean = false,
)

internal interface FcmTokenSource {
    fun pendingToken(context: Context): String?
    suspend fun currentToken(context: Context): String?
    fun clearPendingToken(context: Context, token: String)
    fun clearPendingToken(context: Context)
}

private object AndroidFcmTokenSource : FcmTokenSource {
    override fun pendingToken(context: Context): String? = FcmTokenRegistrar.pendingToken(context)
    override suspend fun currentToken(context: Context): String? = FcmTokenRegistrar.currentToken(context)
    override fun clearPendingToken(context: Context, token: String) = FcmTokenRegistrar.clearPendingToken(context, token)
    override fun clearPendingToken(context: Context) = FcmTokenRegistrar.clearPendingToken(context)
}

class ShellyViewModel internal constructor(
    context: Context,
    private val repository: ShellyRepositoryClient,
    private val fcmTokens: FcmTokenSource,
    private val restoreDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val repositoryDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val sessionSubscriptionRetryDelayMillis: Long = 750L,
    private val backgroundDetachGraceMillis: Long = 5 * 60 * 1000L,
) : ViewModel() {
    constructor(context: Context) : this(context, ShellyRepository(context), AndroidFcmTokenSource)

    private val appContext = context.applicationContext
    private val _state = MutableStateFlow(ShellyUiState())
    private var pendingPushSessionIdHash: String? = null
    private var sessionSubscriptionJob: Job? = null
    private var restoreJob: Job? = null
    private var unpairJob: Job? = null
    private var backgroundDetachJob: Job? = null
    private var restoreGeneration = 0
    val state: StateFlow<ShellyUiState> = _state.asStateFlow()

    init {
        val generation = restoreGeneration
        restoreJob = viewModelScope.launch {
            restoreSavedPairing(generation)
        }
    }

    fun setUnlocked(unlocked: Boolean) {
        val previous = _state.getAndUpdate {
            it.copy(
                unlocked = unlocked,
                activeTerminalSessionId = if (unlocked) it.activeTerminalSessionId else null,
            )
        }
        if (!unlocked) {
            if (previous.unlocked) {
                stopSessionSubscription()
            }
            return
        }
        if (unlocked && !previous.unlocked && _state.value.paired) {
            refreshSessions()
            startSessionSubscription()
            syncFcmToken()
        }
    }

    fun pair(qrPayload: String) {
        runPairing { repository.pair(qrPayload) }
    }

    fun pairWithCode(code: String) {
        runPairing { repository.pairWithCode(code) }
    }

    private fun runPairing(pairAction: suspend () -> Unit) {
        if (_state.value.loading) {
            return
        }
        restoreGeneration += 1
        restoreJob?.cancel()
        restoreJob = null
        _state.update {
            it.copy(
                restoringPairing = false,
                loading = true,
                message = null,
            )
        }
        viewModelScope.launch {
            try {
                unpairJob?.join()
                unpairJob = null
                withContext(repositoryDispatcher) {
                    pairAction()
                }
                val pairedDaemon = repository.savedPairing
                _state.update {
                    it.copy(
                        paired = true,
                        pairedDaemon = pairedDaemon,
                        message = "Paired",
                    )
                }
                if (_state.value.unlocked) {
                    startSessionSubscription()
                    loadSessions()
                    syncFcmToken()
                }
            } catch (error: Throwable) {
                if (error is CancellationException) {
                    throw error
                }
                _state.update { it.copy(message = PAIRING_FAILED_MESSAGE) }
            } finally {
                _state.update { it.copy(loading = false) }
            }
        }
    }

    fun refreshSessions() {
        viewModelScope.launch {
            runLoading {
                loadSessions()
            }
        }
    }

    // Creates a new shell session on the laptop and opens it. The command is
    // chosen by the daemon (always a shell); the optional name is just a label.
    fun createSession(name: String? = null) {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, message = null) }
            try {
                val session = withContext(repositoryDispatcher) {
                    repository.createSession(name?.takeIf { it.isNotBlank() })
                }
                applySessions((_state.value.sessions + session).distinctBy { it.id })
                openTerminalSession(session)
            } catch (error: Throwable) {
                if (error is CancellationException) {
                    throw error
                }
                _state.update { it.copy(message = CREATE_SESSION_FAILED_MESSAGE) }
            } finally {
                _state.update { it.copy(loading = false) }
            }
        }
    }

    // Kills a session on the laptop. Fire-and-forget at the daemon; the list is
    // updated optimistically and reconciled by the session subscription.
    fun killSession(sessionId: String) {
        viewModelScope.launch {
            try {
                withContext(repositoryDispatcher) {
                    repository.killSession(sessionId)
                }
                if (_state.value.activeTerminalSessionId == sessionId) {
                    closeTerminalSession()
                }
                applySessions(_state.value.sessions.filterNot { it.id == sessionId })
            } catch (error: Throwable) {
                if (error is CancellationException) {
                    throw error
                }
                _state.update { it.copy(message = KILL_SESSION_FAILED_MESSAGE) }
            }
        }
    }

    suspend fun createTerminalController(
        session: MobileSession,
        inputGate: suspend () -> Boolean,
    ): TerminalController {
        val attached = withContext(repositoryDispatcher) {
            repository.attach(session.id)
        }
        return TerminalController(
            session = session,
            initialAttachedSession = attached,
            scope = viewModelScope,
            inputGate = inputGate,
            reattach = { lastSeenSeq ->
                withContext(repositoryDispatcher) {
                    repository.attach(session.id, lastSeenSeq)
                }
            },
            recordLastSeenSeq = { seq -> repository.recordLastSeenSeq(session.id, seq) },
            recordTelemetryExperience = ::recordTelemetryExperience,
        ).also { it.start() }
    }

    fun unpair() {
        val wasPaired = _state.value.paired
        val wasUnlocked = _state.value.unlocked
        val pendingToken = fcmTokens.pendingToken(appContext)
        restoreGeneration += 1
        restoreJob?.cancel()
        restoreJob = null
        stopSessionSubscription()
        pendingPushSessionIdHash = null
        _state.value = ShellyUiState(
            unlocked = wasUnlocked,
            restoringPairing = false,
        )
        unpairJob = viewModelScope.launch {
            try {
                if (wasPaired && wasUnlocked) {
                    withTimeoutOrNull(5_000L) {
                        val tokens = listOfNotNull(pendingToken, currentFcmTokenForUnpair()).distinct()
                        for (token in tokens) {
                            unregisterFcmTokenForUnpair(token)
                        }
                    }
                }
            } finally {
                fcmTokens.clearPendingToken(appContext)
                repository.clear()
            }
        }
    }

    fun handlePushIntent(sessionIdHash: String) {
        val parsedHash = ShellyPushNotifications.sessionIdHashValue(sessionIdHash)
        if (parsedHash == null) {
            pendingPushSessionIdHash = null
            return
        }
        pendingPushSessionIdHash = parsedHash
        if (!_state.value.unlocked) {
            return
        }
        resolvePendingPushTarget(_state.value.sessions)
        if (_state.value.paired) {
            refreshSessions()
        }
    }

    fun consumeTargetSession() {
        _state.update { it.copy(targetSession = null) }
    }

    fun openTerminalSession(session: MobileSession) {
        _state.update { it.copy(activeTerminalSessionId = session.id) }
    }

    fun closeTerminalSession() {
        _state.update { it.copy(activeTerminalSessionId = null) }
    }

    fun onAppBackgrounded() {
        backgroundDetachJob?.cancel()
        backgroundDetachJob = viewModelScope.launch {
            delay(backgroundDetachGraceMillis)
            closeTerminalSession()
            stopSessionSubscription()
        }
    }

    fun onAppForegrounded() {
        backgroundDetachJob?.cancel()
        backgroundDetachJob = null
        if (_state.value.paired && _state.value.unlocked) {
            startSessionSubscription()
        }
    }

    fun syncFcmToken() {
        if (!_state.value.paired || !_state.value.unlocked) {
            return
        }
        viewModelScope.launch {
            val pendingToken = fcmTokens.pendingToken(appContext)
            val tokens = listOfNotNull(pendingToken, fcmTokens.currentToken(appContext))
                .distinct()
            for (token in tokens) {
                try {
                    withContext(repositoryDispatcher) {
                        repository.registerFcmToken(token)
                    }
                    if (token == pendingToken) {
                        fcmTokens.clearPendingToken(appContext, token)
                    }
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                }
            }
        }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }

    private suspend fun currentFcmTokenForUnpair(): String? {
        return try {
            fcmTokens.currentToken(appContext)
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            null
        }
    }

    private suspend fun unregisterFcmTokenForUnpair(token: String) {
        try {
            withContext(repositoryDispatcher) {
                repository.unregisterFcmToken(token)
            }
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
        }
    }

    fun answerTelemetryConsent(accepted: Boolean) {
        MobileTelemetry.setDiagnosticsEnabled(appContext, accepted)
        _state.update { it.copy(telemetryConsentPromptVisible = false) }
    }

    private suspend fun loadSessions() {
        val sessions = withContext(repositoryDispatcher) {
            repository.listSessions()
        }
        applySessions(sessions)
        resolvePendingPushTarget(sessions)
    }

    private suspend fun restoreSavedPairing(generation: Int) {
        runCatching {
            withContext(restoreDispatcher) {
                repository.restore()
            }
        }.onSuccess { paired ->
            if (generation != restoreGeneration) {
                return@onSuccess
            }
            val pairedDaemon = repository.savedPairing
            _state.update {
                it.copy(
                    paired = paired,
                    restoringPairing = false,
                    pairedDaemon = pairedDaemon,
                )
            }
            if (paired && _state.value.unlocked) {
                refreshSessions()
                startSessionSubscription()
                syncFcmToken()
            }
        }.onFailure { error ->
            if (error is CancellationException) {
                throw error
            }
            _state.update {
                it.copy(
                    restoringPairing = false,
                    message = SAVED_PAIRING_UNAVAILABLE_MESSAGE,
                )
            }
        }
    }

    private fun startSessionSubscription() {
        if (sessionSubscriptionJob?.isActive == true) {
            return
        }
        sessionSubscriptionJob = viewModelScope.launch(repositoryDispatcher) {
            while (_state.value.unlocked && _state.value.paired) {
                try {
                    repository.subscribeSessions { sessions ->
                        if (!_state.value.unlocked) {
                            return@subscribeSessions
                        }
                        applySessions(sessions)
                        resolvePendingPushTarget(sessions)
                    }
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                    if (!_state.value.unlocked || !_state.value.paired) {
                        return@launch
                    }
                }
                if (!_state.value.unlocked || !_state.value.paired) {
                    return@launch
                }
                delay(sessionSubscriptionRetryDelayMillis)
            }
        }
    }

    private fun stopSessionSubscription() {
        sessionSubscriptionJob?.cancel()
        sessionSubscriptionJob = null
    }

    private suspend fun runLoading(block: suspend () -> Unit) {
        _state.update { it.copy(loading = true, message = null) }
        try {
            block()
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            _state.update { it.copy(message = SESSIONS_UNAVAILABLE_MESSAGE) }
        } finally {
            _state.update { it.copy(loading = false) }
        }
    }

    private fun resolvePendingPushTarget(sessions: List<MobileSession>) {
        val hash = pendingPushSessionIdHash ?: return
        val session = sessions.firstOrNull { sha256Hex(it.id) == hash } ?: return
        pendingPushSessionIdHash = null
        _state.update { it.copy(targetSession = session) }
    }

    private fun applySessions(sessions: List<MobileSession>) {
        _state.update { state ->
            state.copy(
                sessions = sessions,
                activeTerminalSessionId = state.activeTerminalSessionId?.takeIf { id ->
                    sessions.any { it.id == id }
                },
            )
        }
    }

    private fun recordTelemetryExperience() {
        if (MobileTelemetry.shouldShowConsentPrompt(appContext)) {
            _state.update { it.copy(telemetryConsentPromptVisible = true) }
        }
    }
}

private fun sha256Hex(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    val chars = CharArray(digest.size * 2)
    digest.forEachIndexed { index, byte ->
        val value = byte.toInt() and 0xff
        chars[index * 2] = HEX[value ushr 4]
        chars[index * 2 + 1] = HEX[value and 0x0f]
    }
    return String(chars)
}

private val HEX = "0123456789abcdef".toCharArray()
private const val PAIRING_FAILED_MESSAGE = "Pairing failed"
private const val SAVED_PAIRING_UNAVAILABLE_MESSAGE = "Saved pairing unavailable"
private const val SESSIONS_UNAVAILABLE_MESSAGE = "Sessions unavailable"
private const val CREATE_SESSION_FAILED_MESSAGE = "Couldn't create session"
private const val KILL_SESSION_FAILED_MESSAGE = "Couldn't close session"
