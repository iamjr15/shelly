package app.fieldwork.android.core

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.fieldwork.android.push.FcmTokenRegistrar
import app.fieldwork.android.push.FieldworkPushNotifications
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest

data class FieldworkUiState(
    val unlocked: Boolean = false,
    val paired: Boolean = false,
    val restoringPairing: Boolean = true,
    val sessions: List<MobileSession> = emptyList(),
    val loading: Boolean = false,
    val message: String? = null,
    val pairedDaemon: PairedDaemonRecord? = null,
    val targetSession: MobileSession? = null,
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

class FieldworkViewModel internal constructor(
    context: Context,
    private val repository: FieldworkRepositoryClient,
    private val fcmTokens: FcmTokenSource,
    private val restoreDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val repositoryDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {
    constructor(context: Context) : this(context, FieldworkRepository(context), AndroidFcmTokenSource)

    private val appContext = context.applicationContext
    private val _state = MutableStateFlow(FieldworkUiState())
    private var pendingPushSessionIdHash: String? = null
    private var sessionSubscriptionJob: Job? = null
    private var restoreJob: Job? = null
    private var restoreGeneration = 0
    val state: StateFlow<FieldworkUiState> = _state.asStateFlow()

    init {
        val generation = restoreGeneration
        restoreJob = viewModelScope.launch {
            restoreSavedPairing(generation)
        }
    }

    fun setUnlocked(unlocked: Boolean) {
        val wasUnlocked = _state.value.unlocked
        _state.value = _state.value.copy(unlocked = unlocked)
        if (!unlocked) {
            if (wasUnlocked) {
                stopSessionSubscription()
            }
            return
        }
        if (unlocked && !wasUnlocked && _state.value.paired) {
            refreshSessions()
            startSessionSubscription()
            syncFcmToken()
        }
    }

    fun pair(qrPayload: String) {
        restoreGeneration += 1
        restoreJob?.cancel()
        restoreJob = null
        _state.value = _state.value.copy(restoringPairing = false)
        viewModelScope.launch {
            runLoading {
                withContext(repositoryDispatcher) {
                    repository.pair(qrPayload)
                }
                _state.value = _state.value.copy(
                    paired = true,
                    pairedDaemon = repository.savedPairing,
                    message = "Paired",
                )
                if (_state.value.unlocked) {
                    loadSessions()
                    startSessionSubscription()
                    syncFcmToken()
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

    suspend fun createTerminalController(
        session: MobileSession,
        inputGate: suspend () -> Boolean,
    ): TerminalController {
        val attached = withContext(repositoryDispatcher) {
            repository.attach(session.id)
        }
        return TerminalController(
            session = session,
            attachedSession = attached,
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
        restoreGeneration += 1
        restoreJob?.cancel()
        restoreJob = null
        stopSessionSubscription()
        pendingPushSessionIdHash = null
        fcmTokens.clearPendingToken(appContext)
        repository.clear()
        _state.value = FieldworkUiState(
            unlocked = _state.value.unlocked,
            restoringPairing = false,
        )
    }

    fun handlePushIntent(sessionIdHash: String) {
        val parsedHash = FieldworkPushNotifications.sessionIdHashValue(sessionIdHash)
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
        _state.value = _state.value.copy(targetSession = null)
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
                runCatching {
                    withContext(repositoryDispatcher) {
                        repository.registerFcmToken(token)
                    }
                }.onSuccess {
                    if (token == pendingToken) {
                        fcmTokens.clearPendingToken(appContext, token)
                    }
                }
            }
        }
    }

    fun clearMessage() {
        _state.value = _state.value.copy(message = null)
    }

    fun answerTelemetryConsent(accepted: Boolean) {
        MobileTelemetry.setCrashReportingEnabled(appContext, accepted)
        _state.value = _state.value.copy(telemetryConsentPromptVisible = false)
    }

    private suspend fun loadSessions() {
        val sessions = withContext(repositoryDispatcher) {
            repository.listSessions()
        }
        _state.value = _state.value.copy(sessions = sessions)
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
            _state.value = _state.value.copy(
                paired = paired,
                restoringPairing = false,
                pairedDaemon = repository.savedPairing,
            )
            if (paired && _state.value.unlocked) {
                refreshSessions()
                startSessionSubscription()
                syncFcmToken()
            }
        }.onFailure { error ->
            if (error is CancellationException) {
                throw error
            }
            _state.value = _state.value.copy(
                restoringPairing = false,
                message = error.message ?: error.toString(),
            )
        }
    }

    private fun startSessionSubscription() {
        if (sessionSubscriptionJob?.isActive == true) {
            return
        }
        sessionSubscriptionJob = viewModelScope.launch(repositoryDispatcher) {
            runCatching {
                repository.subscribeSessions { sessions ->
                    if (!_state.value.unlocked) {
                        return@subscribeSessions
                    }
                    _state.value = _state.value.copy(sessions = sessions)
                    resolvePendingPushTarget(sessions)
                }
            }.onFailure { error ->
                _state.value = _state.value.copy(message = error.message ?: error.toString())
            }
        }
    }

    private fun stopSessionSubscription() {
        sessionSubscriptionJob?.cancel()
        sessionSubscriptionJob = null
    }

    private suspend fun runLoading(block: suspend () -> Unit) {
        _state.value = _state.value.copy(loading = true, message = null)
        try {
            block()
        } catch (error: Throwable) {
            _state.value = _state.value.copy(message = error.message ?: error.toString())
        } finally {
            _state.value = _state.value.copy(loading = false)
        }
    }

    private fun resolvePendingPushTarget(sessions: List<MobileSession>) {
        val hash = pendingPushSessionIdHash ?: return
        val session = sessions.firstOrNull { sha256Hex(it.id) == hash } ?: return
        pendingPushSessionIdHash = null
        _state.value = _state.value.copy(targetSession = session)
    }

    private fun recordTelemetryExperience() {
        if (MobileTelemetry.shouldShowConsentPrompt(appContext)) {
            _state.value = _state.value.copy(telemetryConsentPromptVisible = true)
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
