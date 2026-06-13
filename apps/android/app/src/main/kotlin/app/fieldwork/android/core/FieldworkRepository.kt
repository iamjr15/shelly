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
    suspend fun unregisterFcmToken(token: String)
    fun clear()
}

class FieldworkRepository(context: Context) : FieldworkRepositoryClient {
    private val appContext = context.applicationContext
    private val store by lazy { PairingStore(appContext) }
    private val stateLock = Any()
    private var client: FieldworkClient? = null
    private val lastSeenSeqBySession = mutableMapOf<String, ULong>()

    @Volatile
    override var savedPairing: PairedDaemonRecord? = null
        private set

    override fun restore(): Boolean {
        val restored = store.load()
        val restoredClient = restored?.let(::createClient)
        val accepted = synchronized(stateLock) {
            if (client != null || savedPairing != null) {
                false
            } else {
                savedPairing = restored
                client = restoredClient
                true
            }
        }
        if (!accepted) {
            restoredClient?.destroy()
        }
        return savedPairing != null
    }

    override suspend fun pair(qrPayload: String) {
        val freshClient = createClient(null)
        replaceClient(freshClient)
        val info = freshClient.pairWithQr(qrPayload)
        debugLog("pair completed")
        persistPairing(info)
    }

    override suspend fun pairWithCode(code: String) {
        val freshClient = createClient(null)
        replaceClient(freshClient)
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
        replacePairing(record, createClient(record))
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
        val seq = lastSeenSeq ?: cachedLastSeenSeq(sessionId)
        return if (seq == null) {
            requireClient().attachSession(sessionId)
        } else {
            requireClient().attachSessionFrom(sessionId, seq)
        }
    }

    override fun recordLastSeenSeq(sessionId: String, seq: ULong) {
        synchronized(stateLock) {
            lastSeenSeqBySession[sessionId] = seq
        }
    }

    override suspend fun registerFcmToken(token: String) {
        requireClient().registerPushToken(PushPlatform.FCM, token)
    }

    override suspend fun unregisterFcmToken(token: String) {
        requireClient().unregisterPushToken(PushPlatform.FCM, token)
    }

    override fun clear() {
        val clearedClient = createClient(null)
        store.clear()
        val previous = synchronized(stateLock) {
            lastSeenSeqBySession.clear()
            savedPairing = null
            val old = client
            client = clearedClient
            old
        }
        previous?.destroy()
    }

    private fun requireClient(): FieldworkClient {
        synchronized(stateLock) {
            client?.let { return it }
        }
        val record = savedPairing
        val freshClient = createClient(record)
        val winner = synchronized(stateLock) {
            client ?: freshClient.also { client = it }
        }
        if (winner !== freshClient) {
            freshClient.destroy()
        }
        return winner
    }

    private fun cachedLastSeenSeq(sessionId: String): ULong? {
        return synchronized(stateLock) {
            lastSeenSeqBySession[sessionId]
        }
    }

    private fun replaceClient(next: FieldworkClient) {
        val previous = synchronized(stateLock) {
            val old = client
            client = next
            old
        }
        if (previous !== next) {
            previous?.destroy()
        }
    }

    private fun replacePairing(record: PairedDaemonRecord, nextClient: FieldworkClient) {
        val previous = synchronized(stateLock) {
            savedPairing = record
            val old = client
            client = nextClient
            old
        }
        if (previous !== nextClient) {
            previous?.destroy()
        }
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
