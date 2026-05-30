package app.fieldwork.android.core

import android.content.Context
import android.os.Build
import android.util.Log
import app.fieldwork.android.BuildConfig
import uniffi.fieldwork_mobile_core.AgentStateFfi
import uniffi.fieldwork_mobile_core.AttachedSession
import uniffi.fieldwork_mobile_core.ClientConfig
import uniffi.fieldwork_mobile_core.DaemonConfig
import uniffi.fieldwork_mobile_core.DaemonInfo
import uniffi.fieldwork_mobile_core.FieldworkClient
import uniffi.fieldwork_mobile_core.MobilePlatform
import uniffi.fieldwork_mobile_core.PushPlatform
import uniffi.fieldwork_mobile_core.SessionListSink
import uniffi.fieldwork_mobile_core.SessionSummaryFfi

internal interface FieldworkRepositoryClient {
    val savedPairing: PairedDaemonRecord?
    fun restore(): Boolean
    suspend fun pair(qrPayload: String)
    suspend fun pairWithCode(code: String)
    suspend fun listSessions(): List<MobileSession>
    suspend fun subscribeSessions(onUpdate: (List<MobileSession>) -> Unit)
    suspend fun attach(sessionId: String, lastSeenSeq: ULong? = null): AttachedSession
    fun recordLastSeenSeq(sessionId: String, seq: ULong)
    suspend fun registerFcmToken(token: String)
    fun clear()
}

class FieldworkRepository(context: Context) : FieldworkRepositoryClient {
    private val appContext = context.applicationContext
    private val store by lazy { PairingStore(appContext) }
    private var client: FieldworkClient? = null
    private val lastSeenSeqBySession = mutableMapOf<String, ULong>()

    override var savedPairing: PairedDaemonRecord? = null
        private set

    override fun restore(): Boolean {
        savedPairing = store.load()
        client = savedPairing?.let(::createClient)
        return savedPairing != null
    }

    override suspend fun pair(qrPayload: String) {
        val freshClient = createClient(null)
        client = freshClient
        val info = freshClient.pairWithQr(qrPayload)
        debugLog("pair completed")
        persistPairing(info)
    }

    override suspend fun pairWithCode(code: String) {
        val freshClient = createClient(null)
        client = freshClient
        val info = freshClient.pairWithCode(code)
        debugLog("pairWithCode completed")
        persistPairing(info)
    }

    private fun persistPairing(info: DaemonInfo) {
        val record = PairedDaemonRecord(
            daemonNodeId = info.daemonNodeId,
            relayUrl = info.relayUrl,
            addrs = info.addrs,
            deviceNodeId = info.deviceNodeId,
            deviceSecretKey = info.deviceSecretKey,
            pairedAtMillis = System.currentTimeMillis(),
        )
        store.save(record)
        savedPairing = record
        client = createClient(record)
    }

    override suspend fun listSessions(): List<MobileSession> {
        val summaries = requireClient().listSessions()
        debugLog("listSessions returned ${summaries.size} sessions")
        return summaries
            .map(::toMobileSession)
            .sortedWith(compareBy<MobileSession> { it.state.sortRank }.thenByDescending { it.lastActivity })
    }

    override suspend fun subscribeSessions(onUpdate: (List<MobileSession>) -> Unit) {
        requireClient().subscribeSessions(object : SessionListSink {
            override fun onUpdate(sessions: List<SessionSummaryFfi>) {
                onUpdate(
                    sessions
                        .map(::toMobileSession)
                        .sortedWith(
                            compareBy<MobileSession> { it.state.sortRank }
                                .thenByDescending { it.lastActivity },
                        ),
                )
            }
        })
    }

    override suspend fun attach(sessionId: String, lastSeenSeq: ULong?): AttachedSession {
        val seq = lastSeenSeq ?: lastSeenSeqBySession[sessionId]
        return if (seq == null) {
            requireClient().attachSession(sessionId)
        } else {
            requireClient().attachSessionFrom(sessionId, seq)
        }
    }

    override fun recordLastSeenSeq(sessionId: String, seq: ULong) {
        lastSeenSeqBySession[sessionId] = seq
    }

    override suspend fun registerFcmToken(token: String) {
        requireClient().registerPushToken(PushPlatform.FCM, token)
    }

    override fun clear() {
        store.clear()
        lastSeenSeqBySession.clear()
        savedPairing = null
        client?.destroy()
        client = createClient(null)
    }

    private fun requireClient(): FieldworkClient {
        return client ?: createClient(savedPairing).also { client = it }
    }

    private fun createClient(record: PairedDaemonRecord?): FieldworkClient {
        FieldworkNative.installAndroidContext(appContext)
        return FieldworkClient(
            ClientConfig(
                deviceName = Build.MODEL ?: "Android",
                platform = MobilePlatform.ANDROID,
                deviceSecretKey = record?.deviceSecretKey,
                pairedDaemon = record?.let {
                    DaemonConfig(
                        daemonNodeId = it.daemonNodeId,
                        relayUrl = it.relayUrl,
                        addrs = it.addrs,
                    )
                },
                relayControlUrl = BuildConfig.FIELDWORK_RELAY_CONTROL_URL.ifBlank { null },
            ),
        )
    }
}

private fun debugLog(message: String) {
    if (BuildConfig.DEBUG) {
        Log.d("FieldworkRepository", message)
    }
}

private fun toMobileSession(summary: SessionSummaryFfi): MobileSession {
    return MobileSession(
        id = summary.id,
        name = summary.name,
        command = summary.command,
        cwd = summary.cwd,
        createdAt = summary.createdAt,
        lastActivity = summary.lastActivity,
        state = when (summary.state) {
            AgentStateFfi.AWAITING_INPUT -> AgentState.AwaitingInput
            AgentStateFfi.WORKING -> AgentState.Working
            AgentStateFfi.CRASHED -> AgentState.Crashed
            AgentStateFfi.IDLE -> AgentState.Idle
        },
        lastLine = summary.lastLine,
        model = summary.model,
    )
}
