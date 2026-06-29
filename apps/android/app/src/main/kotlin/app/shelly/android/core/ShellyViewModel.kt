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
import kotlinx.coroutines.channels.Channel
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
    val message: ShellyAlertMessage? = null,
    val pairingError: PairingErrorMessage? = null,
    val pairedDaemon: PairedDaemonRecord? = null,
    val targetSession: MobileSession? = null,
    val activeTerminalSessionId: String? = null,
    val telemetryConsentPromptVisible: Boolean = false,
    val connectionState: ConnectionState = ConnectionState.Connected,
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
    private val maxRetryDelayMillis: Long = 30_000L,
    private val unreachableAfterMillis: Long = 60_000L,
    private val unreachableRetryIntervalMillis: Long = 15_000L,
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    constructor(context: Context) : this(context, ShellyRepository(context), AndroidFcmTokenSource)

    private val appContext = context.applicationContext
    private val _state = MutableStateFlow(ShellyUiState())
    private var pendingPushSessionIdHash: String? = null
    private var sessionSubscriptionJob: Job? = null
    // Rendezvous so a retry tap only ever shortens an in-flight reconnect wait: trySend is a
    // no-op unless the subscription loop is currently parked in awaitRetryOrTimeout().
    private val retrySignal = Channel<Unit>(Channel.RENDEZVOUS)
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
                pairingError = null,
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
                        message = null,
                        pairingError = null,
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
                _state.update {
                    it.copy(
                        message = null,
                        pairingError = pairingErrorMessage(error),
                    )
                }
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
                _state.update { it.copy(message = createSessionFailedMessage(error)) }
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
                _state.update { it.copy(message = killSessionFailedMessage(error)) }
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
                        val tokens = listOfNotNull(pendingToken, currentFcmTokenOrNull()).distinct()
                        for (token in tokens) {
                            unregisterFcmTokenQuietly(token)
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

    // Mirrors FCM registration to the push preference: ON re-syncs the token, OFF unregisters
    // every token we know about. Notification display is still gated on-device in
    // ShellyPushNotifications, so this is best-effort server-side cleanup.
    fun setPushEnabled(enabled: Boolean) {
        if (enabled) {
            syncFcmToken()
            return
        }
        if (!_state.value.paired) {
            return
        }
        val pendingToken = fcmTokens.pendingToken(appContext)
        viewModelScope.launch {
            val tokens = listOfNotNull(pendingToken, currentFcmTokenOrNull()).distinct()
            for (token in tokens) {
                unregisterFcmTokenQuietly(token)
            }
        }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }

    private suspend fun currentFcmTokenOrNull(): String? {
        return try {
            fcmTokens.currentToken(appContext)
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            null
        }
    }

    private suspend fun unregisterFcmTokenQuietly(token: String) {
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
                    message = null,
                    pairingError = savedPairingUnavailableMessage(error),
                )
            }
        }
    }

    // Interrupts an in-flight reconnect wait so the loop retries the daemon immediately. Backs the
    // "Retry now"/"Retry connection" buttons on the reconnecting/unreachable screens.
    fun retryConnectionNow() {
        retrySignal.trySend(Unit)
    }

    private fun startSessionSubscription() {
        if (sessionSubscriptionJob?.isActive == true) {
            return
        }
        sessionSubscriptionJob = viewModelScope.launch(repositoryDispatcher) {
            // Fresh run: optimistically assume connected until the first drop. Clears any stale
            // reconnecting/unreachable state left from a prior lock or background cycle.
            var attempt = 0
            var droppedAtMillis = 0L
            _state.update { it.copy(connectionState = ConnectionState.Connected) }
            while (_state.value.unlocked && _state.value.paired) {
                try {
                    repository.subscribeSessions { sessions ->
                        if (!_state.value.unlocked) {
                            return@subscribeSessions
                        }
                        // The call blocks while healthy, so any session-list callback is the
                        // authoritative "we're connected" edge — reset the reconnect machine.
                        attempt = 0
                        droppedAtMillis = 0L
                        if (_state.value.connectionState != ConnectionState.Connected) {
                            _state.update { it.copy(connectionState = ConnectionState.Connected) }
                        }
                        applySessions(sessions)
                        resolvePendingPushTarget(sessions)
                    }
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                }
                if (!_state.value.unlocked || !_state.value.paired) {
                    return@launch
                }
                // subscribeSessions returned or threw → the tunnel dropped. Advance the reconnect
                // state machine (keeping the held sessions on screen), then wait before retrying.
                val nowMillis = now()
                attempt += 1
                if (droppedAtMillis == 0L) {
                    droppedAtMillis = nowMillis
                }
                val backoff = sessionRetryBackoffMillis(
                    attempt = attempt,
                    baseMillis = sessionSubscriptionRetryDelayMillis,
                    capMillis = maxRetryDelayMillis,
                )
                val waitMillis = if (nowMillis - droppedAtMillis < unreachableAfterMillis) {
                    _state.update {
                        it.copy(
                            connectionState = ConnectionState.Reconnecting(
                                droppedAtMillis = droppedAtMillis,
                                attempt = attempt,
                                nextRetryAtMillis = nowMillis + backoff,
                            ),
                        )
                    }
                    backoff
                } else {
                    _state.update {
                        it.copy(
                            connectionState = ConnectionState.Unreachable(
                                droppedAtMillis = droppedAtMillis,
                                attempt = attempt,
                                retryIntervalMillis = unreachableRetryIntervalMillis,
                                nextRetryAtMillis = nowMillis + unreachableRetryIntervalMillis,
                            ),
                        )
                    }
                    unreachableRetryIntervalMillis
                }
                awaitRetryOrTimeout(waitMillis)
            }
        }
    }

    // Waits up to [timeoutMillis] before the next retry, but resolves early if retryConnectionNow()
    // signals. A non-positive timeout retries immediately.
    private suspend fun awaitRetryOrTimeout(timeoutMillis: Long) {
        if (timeoutMillis <= 0L) {
            return
        }
        withTimeoutOrNull(timeoutMillis) {
            retrySignal.receive()
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
            _state.update { it.copy(message = sessionsUnavailableMessage(error)) }
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

/**
 * Pure exponential backoff for reconnect attempts: [baseMillis] doubled per attempt, capped at
 * [capMillis]. Attempt 1 yields the base delay. Kept side-effect-free (no jitter) so the reconnect
 * timing is deterministic and unit-testable; clamps before doubling to avoid overflow.
 */
internal fun sessionRetryBackoffMillis(attempt: Int, baseMillis: Long, capMillis: Long): Long {
    if (baseMillis <= 0L || capMillis <= 0L) {
        return 0L
    }
    var delayMillis = baseMillis
    repeat((attempt - 1).coerceAtLeast(0)) {
        if (delayMillis >= capMillis) {
            return capMillis
        }
        delayMillis *= 2
    }
    return delayMillis.coerceAtMost(capMillis)
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
