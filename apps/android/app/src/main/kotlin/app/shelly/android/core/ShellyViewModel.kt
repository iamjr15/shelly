package app.shelly.android.core

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.shelly.android.push.FcmTokenRegistrar
import app.shelly.android.push.ShellyPushNotifications
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import uniffi.shelly_mobile_core.AttachedSession
import uniffi.shelly_mobile_core.ShellyException

data class ShellyUiState(
    val unlocked: Boolean = false,
    val paired: Boolean = false,
    val restoringPairing: Boolean = true,
    val sessions: List<MobileSession> = emptyList(),
    val loading: Boolean = false,
    val message: ShellyAlertMessage? = null,
    val pairingError: PairingErrorMessage? = null,
    val pendingPairingSas: String? = null,
    val pairedDaemon: PairedDaemonRecord? = null,
    val targetSession: MobileSession? = null,
    val terminalTabs: List<MobileSession> = emptyList(),
    val activeTerminalSessionId: String? = null,
    val telemetryConsentPromptVisible: Boolean = false,
    val connectionState: ConnectionState = ConnectionState.Connected,
    val pairingRevoked: Boolean = false,
)

internal interface FcmTokenSource {
    fun pendingToken(context: Context): String?
    suspend fun currentToken(context: Context, enableAutoInit: Boolean = false): String?
    fun restorePrivacyDefault(context: Context)
    suspend fun deleteCurrentToken(context: Context)
    fun clearPendingToken(context: Context, token: String)
    fun clearPendingToken(context: Context)
}

private object AndroidFcmTokenSource : FcmTokenSource {
    override fun pendingToken(context: Context): String? = FcmTokenRegistrar.pendingToken(context)
    override suspend fun currentToken(context: Context, enableAutoInit: Boolean): String? =
        FcmTokenRegistrar.currentToken(context, enableAutoInit)
    override fun restorePrivacyDefault(context: Context) = FcmTokenRegistrar.restorePrivacyDefault(context)
    override suspend fun deleteCurrentToken(context: Context) = FcmTokenRegistrar.deleteCurrentToken(context)
    override fun clearPendingToken(context: Context, token: String) = FcmTokenRegistrar.clearPendingToken(context, token)
    override fun clearPendingToken(context: Context) = FcmTokenRegistrar.clearPendingToken(context)
}

class ShellyViewModel internal constructor(
    context: Context,
    private val repository: ShellyRepositoryClient,
    private val fcmTokens: FcmTokenSource,
    private val savedStateHandle: SavedStateHandle = SavedStateHandle(),
    private val restoreDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val repositoryDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val cleanupScope: CoroutineScope = ANDROID_CLEANUP_SCOPE,
    private val sessionSubscriptionRetryDelayMillis: Long = 750L,
    private val backgroundDetachGraceMillis: Long = 5 * 60 * 1000L,
    private val maxRetryDelayMillis: Long = 30_000L,
    private val unreachableAfterMillis: Long = 60_000L,
    private val unreachableRetryIntervalMillis: Long = 15_000L,
    private val now: () -> Long = { System.currentTimeMillis() },
) : ViewModel() {
    constructor(context: Context, savedStateHandle: SavedStateHandle = SavedStateHandle()) : this(
        context,
        ShellyRepository(context),
        AndroidFcmTokenSource,
        savedStateHandle,
    )

    private val appContext = context.applicationContext
    private val _state = MutableStateFlow(ShellyUiState())
    private var pendingPushSessionIdHash: String? = null
    private var sessionSubscriptionJob: Job? = null
    // Rendezvous so a retry tap only ever shortens an in-flight reconnect wait: trySend is a
    // no-op unless the subscription loop is currently parked in awaitRetryOrTimeout().
    private val retrySignal = Channel<Unit>(Channel.RENDEZVOUS)
    private var restoreJob: Job? = null
    private var pairJob: Job? = null
    private var pendingPairing: PendingPairingClient? = null
    private var unpairJob: Job? = null
    private var backgroundDetachJob: Job? = null
    private var restoreGeneration = 0
    private val liveControllers = ConcurrentHashMap.newKeySet<TerminalController>()
    private var restoredTerminalSessionIds =
        savedStateHandle.get<ArrayList<String>>(SAVED_TERMINAL_SESSION_IDS)?.toList().orEmpty()
    private var restoredActiveTerminalSessionId =
        savedStateHandle.get<String>(SAVED_ACTIVE_TERMINAL_SESSION_ID)
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
                terminalTabs = if (unlocked) it.terminalTabs else emptyList(),
                activeTerminalSessionId = if (unlocked) it.activeTerminalSessionId else null,
            )
        }
        if (!unlocked) {
            if (previous.unlocked) {
                stopSessionSubscription()
                persistTerminalState(emptyList(), null)
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

    private fun runPairing(pairAction: suspend () -> PendingPairingClient) {
        if (_state.value.loading || pendingPairing != null) {
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
                pendingPairingSas = null,
                pairingRevoked = false,
            )
        }
        pairJob = viewModelScope.launch {
            try {
                unpairJob?.join()
                unpairJob = null
                val pending = withContext(repositoryDispatcher) {
                    pairAction()
                }
                pendingPairing = pending
                _state.update {
                    it.copy(
                        loading = false,
                        pendingPairingSas = pending.sas,
                        message = null,
                        pairingError = null,
                        pairingRevoked = false,
                    )
                }
            } catch (error: Throwable) {
                if (error is CancellationException) {
                    throw error
                }
                _state.update {
                    it.copy(
                        message = null,
                        pairingError = pairingErrorMessage(error),
                        pendingPairingSas = null,
                    )
                }
            } finally {
                _state.update { it.copy(loading = false) }
            }
        }
    }

    fun confirmPairing() {
        val pending = pendingPairing ?: return
        if (_state.value.loading) {
            return
        }
        _state.update {
            it.copy(
                loading = true,
                pendingPairingSas = null,
                message = null,
                pairingError = null,
            )
        }
        pairJob = viewModelScope.launch {
            try {
                withContext(repositoryDispatcher) {
                    pending.confirm()
                }
                pendingPairing = null
                val pairedDaemon = repository.savedPairing
                    ?: error("confirmed pairing was not persisted by the repository")
                _state.update {
                    it.copy(
                        paired = true,
                        pairedDaemon = pairedDaemon,
                        message = null,
                        pairingError = null,
                        pairingRevoked = false,
                    )
                }
                if (_state.value.unlocked) {
                    startSessionSubscription()
                    loadSessions()
                    syncFcmToken()
                }
            } catch (error: Throwable) {
                pendingPairing = null
                if (error is CancellationException) {
                    throw error
                }
                _state.update {
                    it.copy(
                        message = null,
                        pairingError = pairingErrorMessage(error),
                        pendingPairingSas = null,
                    )
                }
            } finally {
                _state.update { it.copy(loading = false) }
            }
        }
    }

    fun cancelPairing() {
        pairJob?.cancel()
        pairJob = null
        val pending = pendingPairing
        pendingPairing = null
        _state.update {
            it.copy(
                loading = false,
                pairingError = null,
                pendingPairingSas = null,
            )
        }
        if (pending != null) {
            pairJob = viewModelScope.launch {
                withContext(repositoryDispatcher) {
                    runCatching { pending.cancel() }
                        .onFailure { debugLog("could not close cancelled pairing", it, VIEW_MODEL_LOG_TAG) }
                }
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

    // The repository returns only after the daemon has terminated the PTY and
    // removed its persisted state, so the row never claims success prematurely.
    fun killSession(sessionId: String) {
        viewModelScope.launch {
            try {
                withContext(repositoryDispatcher) {
                    repository.killSession(sessionId)
                }
                closeTerminalTab(sessionId)
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
        val pendingAttach = AtomicReference<AttachedSession?>(null)
        try {
            val attached = withContext(repositoryDispatcher) {
                repository.attach(session.id).also { pendingAttach.set(it) }
            }
            lateinit var controller: TerminalController
            controller = TerminalController(
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
                detachScope = cleanupScope,
                onDetached = { liveControllers.remove(controller) },
            )
            liveControllers += controller
            return controller.also { it.start() }
        } catch (error: CancellationException) {
            pendingAttach.get()?.let { attached ->
                withContext(NonCancellable + repositoryDispatcher) {
                    runCatching { attached.detach() }
                        .onFailure { debugLog("canceled attach cleanup failed", it, VIEW_MODEL_LOG_TAG) }
                    attached.destroy()
                }
            }
            throw error
        }
    }

    fun unpair() {
        val wasPaired = _state.value.paired
        val wasUnlocked = _state.value.unlocked
        restoreGeneration += 1
        restoreJob?.cancel()
        restoreJob = null
        stopSessionSubscription()
        pendingPushSessionIdHash = null
        _state.value = ShellyUiState(
            unlocked = wasUnlocked,
            restoringPairing = false,
        )
        persistTerminalState(emptyList(), null)
        unpairJob = viewModelScope.launch {
            try {
                if (wasPaired) {
                    withContext(repositoryDispatcher) {
                        val tokens = listOfNotNull(
                            fcmTokens.pendingToken(appContext),
                            currentFcmTokenOrNull(),
                        ).distinct()
                        repository.persistPushUnregisterTombstone(tokens)
                        withTimeoutOrNull(PUSH_CLEANUP_TIMEOUT_MILLIS) {
                            for (token in tokens) {
                                unregisterPersistedFcmToken(token)
                            }
                            unpairSelfBestEffort()
                        }
                    }
                }
            } finally {
                withContext(NonCancellable + repositoryDispatcher) {
                    runCatching { fcmTokens.deleteCurrentToken(appContext) }
                        .onFailure { debugLog("could not delete FCM token during unpair", it, VIEW_MODEL_LOG_TAG) }
                    fcmTokens.restorePrivacyDefault(appContext)
                    fcmTokens.clearPendingToken(appContext)
                    repository.clear()
                }
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
        _state.update { state ->
            val current = state.terminalTabs.firstOrNull { it.id == session.id }
            state.copy(
                terminalTabs = if (current == null) {
                    state.terminalTabs + session
                } else {
                    state.terminalTabs.map { if (it.id == session.id) session else it }
                },
                activeTerminalSessionId = session.id,
            )
        }
        persistCurrentTerminalState()
    }

    fun closeTerminalTab(sessionId: String) {
        _state.update { state ->
            val closedIndex = state.terminalTabs.indexOfFirst { it.id == sessionId }
            if (closedIndex == -1) {
                return@update state
            }
            val remaining = state.terminalTabs.filterNot { it.id == sessionId }
            val nextActiveId = if (state.activeTerminalSessionId == sessionId) {
                remaining.getOrNull(closedIndex)?.id ?: remaining.lastOrNull()?.id
            } else {
                state.activeTerminalSessionId?.takeIf { activeId ->
                    remaining.any { it.id == activeId }
                }
            }
            state.copy(
                terminalTabs = remaining,
                activeTerminalSessionId = nextActiveId,
            )
        }
        persistCurrentTerminalState()
    }

    fun closeTerminalSession() {
        _state.update {
            it.copy(
                terminalTabs = emptyList(),
                activeTerminalSessionId = null,
            )
        }
        persistTerminalState(emptyList(), null)
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
        viewModelScope.launch(repositoryDispatcher) {
            val pendingToken = fcmTokens.pendingToken(appContext)
            val tokens = listOfNotNull(pendingToken, fcmTokens.currentToken(appContext, enableAutoInit = true))
                .distinct()
            for (token in tokens) {
                try {
                    repository.registerFcmToken(token)
                    if (token == pendingToken) {
                        fcmTokens.clearPendingToken(appContext, token)
                    }
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                    debugLog("FCM token registration deferred", error, VIEW_MODEL_LOG_TAG)
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
        val wasPaired = _state.value.paired
        viewModelScope.launch {
            try {
                withContext(repositoryDispatcher) {
                    val tokens = listOfNotNull(
                        fcmTokens.pendingToken(appContext),
                        currentFcmTokenOrNull(),
                    ).distinct()
                    if (wasPaired) {
                        repository.persistPushUnregisterTombstone(tokens)
                        for (token in tokens) {
                            unregisterPersistedFcmToken(token)
                        }
                    }
                }
            } finally {
                withContext(NonCancellable + repositoryDispatcher) {
                    runCatching { fcmTokens.deleteCurrentToken(appContext) }
                        .onFailure { debugLog("could not delete disabled FCM token", it, VIEW_MODEL_LOG_TAG) }
                    fcmTokens.restorePrivacyDefault(appContext)
                    fcmTokens.clearPendingToken(appContext)
                }
            }
        }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }

    private suspend fun currentFcmTokenOrNull(): String? {
        return try {
            fcmTokens.currentToken(appContext, enableAutoInit = false)
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            debugLog("could not read current FCM token", error, VIEW_MODEL_LOG_TAG)
            null
        }
    }

    private suspend fun unregisterPersistedFcmToken(token: String) {
        try {
            repository.unregisterFcmToken(token)
            repository.acknowledgePushTokenUnregistered(token)
        } catch (error: ShellyException.Unauthorized) {
            // The request may have landed and only the acknowledgement was lost. Either way this
            // credential can no longer receive pushes, so retaining it would retry forever.
            repository.acknowledgePushTokenUnregistered(token)
            debugLog("push unregister already unauthorized; tombstone acknowledged", error, VIEW_MODEL_LOG_TAG)
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            debugLog("push unregister deferred", error, VIEW_MODEL_LOG_TAG)
        }
    }

    private suspend fun unpairSelfBestEffort() {
        try {
            repository.unpairSelf()
        } catch (error: ShellyException.Unauthorized) {
            // Idempotent success: the daemon already has no paired record for this credential.
            debugLog("authoritative unpair already completed", error, VIEW_MODEL_LOG_TAG)
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            debugLog("authoritative unpair could not reach the daemon", error, VIEW_MODEL_LOG_TAG)
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
                repository.retryPendingPushUnregister()
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

    /**
     * Pulls the daemon version and host name from the live handshake and updates the paired-daemon
     * record if either changed (e.g. the user upgraded or renamed their laptop since pairing). Keeps
     * DaemonDetail and the laptop identifier honest without forcing a re-pair.
     */
    private suspend fun refreshDaemonInfo() {
        val current = _state.value.pairedDaemon ?: return
        val liveVersion = repository.liveDaemonVersion()?.takeIf { it.isNotBlank() }
        val liveHost = repository.liveDaemonHostName()?.takeIf { it.isNotBlank() }
        val updated = current.copy(
            daemonVersion = liveVersion ?: current.daemonVersion,
            hostName = liveHost ?: current.hostName,
        )
        if (updated != current) _state.update { st -> if (st.pairedDaemon == null) st else st.copy(pairedDaemon = updated) }
    }

    private fun startSessionSubscription() {
        if (sessionSubscriptionJob?.isActive == true) {
            return
        }
        sessionSubscriptionJob = viewModelScope.launch(repositoryDispatcher) {
            // Fresh run: optimistically assume connected until the first drop. Clears any stale
            // reconnecting/unreachable state left from a prior lock or background cycle.
            val attempt = AtomicInteger(0)
            val droppedAtMillis = AtomicLong(0L)
            _state.update { it.copy(connectionState = ConnectionState.Connected) }
            while (_state.value.unlocked && _state.value.paired) {
                // Refresh the daemon info once per (re)connection: the live handshake values
                // (version + host name) can differ from the snapshot stored at pairing if the
                // daemon was upgraded or the laptop renamed since.
                val infoRefreshed = AtomicBoolean(false)
                try {
                    repository.subscribeSessions { sessions ->
                        if (!_state.value.unlocked) {
                            return@subscribeSessions
                        }
                        // The call blocks while healthy, so any session-list callback is the
                        // authoritative "we're connected" edge — reset the reconnect machine.
                        attempt.set(0)
                        droppedAtMillis.set(0L)
                        if (_state.value.connectionState != ConnectionState.Connected) {
                            _state.update { it.copy(connectionState = ConnectionState.Connected) }
                        }
                        applySessions(sessions)
                        resolvePendingPushTarget(sessions)
                        if (infoRefreshed.compareAndSet(false, true)) {
                            viewModelScope.launch(repositoryDispatcher) { refreshDaemonInfo() }
                        }
                    }
                } catch (error: ShellyException.Unauthorized) {
                    debugLog("session subscription pairing revoked", error, VIEW_MODEL_LOG_TAG)
                    handleRevokedPairing()
                    return@launch
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                    debugLog("session subscription dropped", error, VIEW_MODEL_LOG_TAG)
                }
                if (!_state.value.unlocked || !_state.value.paired) {
                    return@launch
                }
                // subscribeSessions returned or threw → the tunnel dropped. Advance the reconnect
                // state machine (keeping the held sessions on screen), then wait before retrying.
                val nowMillis = now()
                val currentAttempt = attempt.incrementAndGet()
                droppedAtMillis.compareAndSet(0L, nowMillis)
                val currentDroppedAtMillis = droppedAtMillis.get()
                val backoff = sessionRetryBackoffMillis(
                    attempt = currentAttempt,
                    baseMillis = sessionSubscriptionRetryDelayMillis,
                    capMillis = maxRetryDelayMillis,
                )
                val waitMillis = if (nowMillis - currentDroppedAtMillis < unreachableAfterMillis) {
                    _state.update {
                        it.copy(
                            connectionState = ConnectionState.Reconnecting(
                                droppedAtMillis = currentDroppedAtMillis,
                                attempt = currentAttempt,
                                nextRetryAtMillis = nowMillis + backoff,
                            ),
                        )
                    }
                    backoff
                } else {
                    _state.update {
                        it.copy(
                            connectionState = ConnectionState.Unreachable(
                                droppedAtMillis = currentDroppedAtMillis,
                                attempt = currentAttempt,
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

    private suspend fun handleRevokedPairing() {
        val wasUnlocked = _state.value.unlocked
        pendingPushSessionIdHash = null
        val detachJobs = liveControllers.toList().mapNotNull(TerminalController::detach)
        liveControllers.clear()
        withContext(NonCancellable + repositoryDispatcher) {
            detachJobs.joinAll()
            runCatching { fcmTokens.deleteCurrentToken(appContext) }
                .onFailure { debugLog("could not delete FCM token after revocation", it, VIEW_MODEL_LOG_TAG) }
            fcmTokens.restorePrivacyDefault(appContext)
            fcmTokens.clearPendingToken(appContext)
            repository.clearRevokedPairing()
        }
        persistTerminalState(emptyList(), null)
        _state.value = ShellyUiState(
            unlocked = wasUnlocked,
            restoringPairing = false,
            pairingError = revokedPairingMessage(),
            pairingRevoked = true,
        )
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
            val sessionsById = sessions.associateBy(MobileSession::id)
            val updatedTabs = if (state.terminalTabs.isEmpty() && state.unlocked) {
                restoredTerminalSessionIds.mapNotNull(sessionsById::get)
            } else {
                state.terminalTabs.map { tab -> sessionsById[tab.id] ?: tab }
            }
            val activeTerminalSessionId = state.activeTerminalSessionId
                ?: restoredActiveTerminalSessionId?.takeIf { restoredId ->
                    updatedTabs.any { it.id == restoredId }
                }
            state.copy(
                sessions = sessions,
                activeTerminalSessionId = activeTerminalSessionId?.takeIf { id ->
                    updatedTabs.any { it.id == id }
                },
                terminalTabs = updatedTabs,
            )
        }
    }

    private fun persistCurrentTerminalState() {
        val current = _state.value
        persistTerminalState(current.terminalTabs, current.activeTerminalSessionId)
    }

    private fun persistTerminalState(tabs: List<MobileSession>, activeSessionId: String?) {
        restoredTerminalSessionIds = tabs.map(MobileSession::id)
        restoredActiveTerminalSessionId = activeSessionId
        savedStateHandle[SAVED_TERMINAL_SESSION_IDS] = ArrayList(restoredTerminalSessionIds)
        savedStateHandle[SAVED_ACTIVE_TERMINAL_SESSION_ID] = activeSessionId
    }

    private fun recordTelemetryExperience() {
        if (MobileTelemetry.shouldShowConsentPrompt(appContext)) {
            _state.update { it.copy(telemetryConsentPromptVisible = true) }
        }
    }

    override fun onCleared() {
        val pendingPairingToCancel = pendingPairing
        pendingPairing = null
        val scopedJobs = viewModelScope.coroutineContext[Job]?.children?.toList().orEmpty()
        val lifecycleJobs = (
            listOfNotNull(
                restoreJob,
                pairJob,
                unpairJob,
                backgroundDetachJob,
                sessionSubscriptionJob,
            ) + scopedJobs
        ).distinct()
        lifecycleJobs.forEach { it.cancel() }
        restoreJob = null
        pairJob = null
        unpairJob = null
        backgroundDetachJob = null
        sessionSubscriptionJob = null
        val detachJobs = liveControllers.toList().mapNotNull(TerminalController::detach)
        liveControllers.clear()
        cleanupScope.launch {
            lifecycleJobs.joinAll()
            detachJobs.joinAll()
            withContext(repositoryDispatcher) {
                pendingPairingToCancel?.let { pending ->
                    runCatching { pending.cancel() }
                        .onFailure { debugLog("pending pairing cleanup failed", it, VIEW_MODEL_LOG_TAG) }
                }
                repository.destroy()
            }
        }
        super.onCleared()
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

private const val PUSH_CLEANUP_TIMEOUT_MILLIS = 5_000L
private const val SAVED_TERMINAL_SESSION_IDS = "terminal_session_ids"
private const val SAVED_ACTIVE_TERMINAL_SESSION_ID = "active_terminal_session_id"
private const val VIEW_MODEL_LOG_TAG = "ShellyViewModel"
private val ANDROID_CLEANUP_SCOPE = CoroutineScope(SupervisorJob() + Dispatchers.IO)
