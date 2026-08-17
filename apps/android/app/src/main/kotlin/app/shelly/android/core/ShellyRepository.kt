package app.shelly.android.core

import android.content.Context
import android.os.Build
import android.util.Log
import app.shelly.android.BuildConfig
import kotlinx.coroutines.CancellationException
import uniffi.shelly_mobile_core.AgentStateFfi
import uniffi.shelly_mobile_core.AttachedSession
import uniffi.shelly_mobile_core.ClientConfig
import uniffi.shelly_mobile_core.DaemonConfig
import uniffi.shelly_mobile_core.DaemonInfo
import uniffi.shelly_mobile_core.ShellyClient
import uniffi.shelly_mobile_core.MobilePlatform
import uniffi.shelly_mobile_core.PendingPairing
import uniffi.shelly_mobile_core.PushPlatform
import uniffi.shelly_mobile_core.SessionListSink
import uniffi.shelly_mobile_core.SessionSummaryFfi
import uniffi.shelly_mobile_core.ShellyException

internal interface ShellyRepositoryClient {
    val savedPairing: PairedDaemonRecord?
    fun restore(): Boolean
    suspend fun pair(qrPayload: String): PendingPairingClient
    suspend fun pairWithCode(code: String): PendingPairingClient
    suspend fun listSessions(): List<MobileSession>
    suspend fun subscribeSessions(onUpdate: (List<MobileSession>) -> Unit)

    /** Daemon version from the most recent handshake, or null if not yet connected this launch. */
    suspend fun liveDaemonVersion(): String?

    /** Daemon host name from the most recent handshake, or null if not yet connected this launch. */
    suspend fun liveDaemonHostName(): String?

    suspend fun createSession(name: String?): MobileSession
    suspend fun killSession(sessionId: String)
    suspend fun attach(sessionId: String, lastSeenSeq: ULong? = null): AttachedSession
    fun recordLastSeenSeq(sessionId: String, seq: ULong)
    suspend fun registerFcmToken(token: String)
    suspend fun unregisterFcmToken(token: String)
    suspend fun unpairSelf()
    fun persistPushUnregisterTombstone(tokens: List<String>)
    fun acknowledgePushTokenUnregistered(token: String)
    suspend fun retryPendingPushUnregister()
    fun clear()
    fun clearRevokedPairing()
    fun destroy()
}

interface PendingPairingClient {
    val sas: String
    suspend fun confirm()
    suspend fun cancel()
}

class ShellyRepository(context: Context) : ShellyRepositoryClient {
    private val appContext = context.applicationContext
    private val store by lazy { PairingStore(appContext) }
    private val stateLock = Any()
    private var client: ShellyClient? = null
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

    override suspend fun pair(qrPayload: String): PendingPairingClient {
        val freshClient = createClient(null)
        replaceClient(freshClient)
        return try {
            RepositoryPendingPairing(freshClient.pairWithQr(qrPayload), freshClient)
        } catch (error: Throwable) {
            discardPairingClient(freshClient)
            throw error
        }
    }

    override suspend fun pairWithCode(code: String): PendingPairingClient {
        val freshClient = createClient(null)
        replaceClient(freshClient)
        return try {
            RepositoryPendingPairing(freshClient.pairWithCode(code), freshClient)
        } catch (error: Throwable) {
            discardPairingClient(freshClient)
            throw error
        }
    }

    private inner class RepositoryPendingPairing(
        private val pending: PendingPairing,
        private val pairingClient: ShellyClient,
    ) : PendingPairingClient {
        override val sas: String = pending.sas()

        override suspend fun confirm() {
            try {
                val info = pending.confirm()
                debugLog("pairing confirmed")
                persistPairing(info)
            } catch (error: Throwable) {
                discardPairingClient(pairingClient)
                throw error
            } finally {
                pending.destroy()
            }
        }

        override suspend fun cancel() {
            try {
                pending.cancel()
            } finally {
                discardPairingClient(pairingClient)
                pending.destroy()
            }
        }
    }

    private fun persistPairing(info: DaemonInfo) {
        val record = PairedDaemonRecord(
            daemonNodeId = info.daemonNodeId,
            relayUrl = info.relayUrl,
            addrs = info.addrs,
            deviceNodeId = info.deviceNodeId,
            deviceSecretKey = info.deviceSecretKey,
            pairedAtMillis = System.currentTimeMillis(),
            daemonVersion = info.daemonVersion,
            hostName = info.hostName,
            protocolVersion = info.protocolVersion.toInt(),
        )
        store.save(record)
        replacePairing(record, createClient(record))
    }

    override suspend fun listSessions(): List<MobileSession> {
        val summaries = requireClient().listSessions()
        debugLog("listSessions returned ${summaries.size} sessions")
        return summaries
            .map(::toMobileSession)
            .sortedWith(sessionOrderComparator)
    }

    override suspend fun subscribeSessions(onUpdate: (List<MobileSession>) -> Unit) {
        requireClient().subscribeSessions(object : SessionListSink {
            override fun onUpdate(sessions: List<SessionSummaryFfi>) {
                onUpdate(
                    sessions
                        .map(::toMobileSession)
                        .sortedWith(sessionOrderComparator),
                )
            }
        })
    }

    override suspend fun liveDaemonVersion(): String? = currentClient()?.daemonVersion()

    override suspend fun liveDaemonHostName(): String? = currentClient()?.daemonHostName()

    override suspend fun createSession(name: String?): MobileSession {
        val summary = requireClient().createSession(name)
        debugLog("createSession returned ${summary.id}")
        return toMobileSession(summary)
    }

    override suspend fun killSession(sessionId: String) {
        requireClient().killSession(sessionId)
        debugLog("killSession confirmed for $sessionId")
        synchronized(stateLock) {
            lastSeenSeqBySession.remove(sessionId)
        }
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

    override suspend fun unpairSelf() {
        requireClient().unpairSelf()
    }

    override fun persistPushUnregisterTombstone(tokens: List<String>) {
        val pairing = savedPairing ?: return
        val normalizedTokens = tokens.map(String::trim).filter(String::isNotEmpty).distinct()
        if (normalizedTokens.isEmpty()) {
            return
        }
        store.savePushUnregisterTombstone(
            PushUnregisterTombstone(
                daemonNodeId = pairing.daemonNodeId,
                relayUrl = pairing.relayUrl,
                addrs = pairing.addrs,
                deviceNodeId = pairing.deviceNodeId,
                deviceSecretKey = pairing.deviceSecretKey,
                tokens = normalizedTokens.map { token ->
                    PushTokenMetadata(
                        platform = PUSH_PLATFORM_FCM,
                        token = token,
                        createdAtMillis = System.currentTimeMillis(),
                    )
                },
            ),
        )
    }

    override fun acknowledgePushTokenUnregistered(token: String) {
        store.acknowledgePushToken(token)
    }

    override suspend fun retryPendingPushUnregister() {
        val tombstone = store.loadPushUnregisterTombstone() ?: return
        val retryClient = runCatching { createClient(tombstone) }
            .onFailure { debugLog("could not rebuild client for push unregister retry", it) }
            .getOrNull() ?: return
        try {
            tombstone.tokens.forEach { metadata ->
                if (metadata.platform != PUSH_PLATFORM_FCM) {
                    debugLog("unknown push tombstone platform ${metadata.platform}")
                    return@forEach
                }
                try {
                    retryClient.unregisterPushToken(PushPlatform.FCM, metadata.token)
                    store.acknowledgePushToken(metadata.token)
                } catch (error: ShellyException.Unauthorized) {
                    // Idempotency: the original unregister/unpair may have landed and only its ack
                    // was lost. A now-invalid device credential is terminal success for cleanup.
                    debugLog("push unregister retry already unauthorized; acknowledging tombstone")
                    store.acknowledgePushToken(metadata.token)
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                    debugLog("push unregister retry deferred", error)
                }
            }
        } finally {
            retryClient.destroy()
        }
    }

    override fun clear() {
        store.clear()
        val previous = synchronized(stateLock) {
            lastSeenSeqBySession.clear()
            savedPairing = null
            val old = client
            client = null
            old
        }
        previous?.destroy()
    }

    override fun clearRevokedPairing() {
        // Unauthorized is definitive: no retry credential is useful, so remove every encrypted
        // copy of the device secret rather than retaining the normal offline-cleanup tombstone.
        store.clearPushUnregisterTombstone()
        clear()
    }

    override fun destroy() {
        val previous = synchronized(stateLock) {
            lastSeenSeqBySession.clear()
            val old = client
            client = null
            old
        }
        previous?.destroy()
    }

    private fun requireClient(): ShellyClient {
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

    private fun currentClient(): ShellyClient? = synchronized(stateLock) { client }

    private fun cachedLastSeenSeq(sessionId: String): ULong? {
        return synchronized(stateLock) {
            lastSeenSeqBySession[sessionId]
        }
    }

    private fun replaceClient(next: ShellyClient) {
        val previous = synchronized(stateLock) {
            val old = client
            client = next
            old
        }
        if (previous !== next) {
            previous?.destroy()
        }
    }

    private fun replacePairing(record: PairedDaemonRecord, nextClient: ShellyClient) {
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

    private fun discardPairingClient(pairingClient: ShellyClient) {
        val discarded = synchronized(stateLock) {
            if (client === pairingClient) {
                client = null
                true
            } else {
                false
            }
        }
        if (discarded) {
            pairingClient.destroy()
        }
    }

    private fun createClient(record: PairedDaemonRecord?): ShellyClient {
        return createClient(
            deviceSecretKey = record?.deviceSecretKey,
            daemonNodeId = record?.daemonNodeId,
            relayUrl = record?.relayUrl,
            addrs = record?.addrs.orEmpty(),
        )
    }

    private fun createClient(tombstone: PushUnregisterTombstone): ShellyClient {
        return createClient(
            deviceSecretKey = tombstone.deviceSecretKey,
            daemonNodeId = tombstone.daemonNodeId,
            relayUrl = tombstone.relayUrl,
            addrs = tombstone.addrs,
        )
    }

    private fun createClient(
        deviceSecretKey: ByteArray?,
        daemonNodeId: String?,
        relayUrl: String?,
        addrs: List<String>,
    ): ShellyClient {
        ShellyNative.installAndroidContext(appContext)
        return ShellyClient(
            ClientConfig(
                deviceName = Build.MODEL ?: "Android",
                platform = MobilePlatform.ANDROID,
                deviceSecretKey = deviceSecretKey,
                pairedDaemon = daemonNodeId?.let {
                    DaemonConfig(
                        daemonNodeId = it,
                        relayUrl = relayUrl,
                        addrs = addrs,
                    )
                },
                relayControlUrl = BuildConfig.SHELLY_RELAY_CONTROL_URL.ifBlank { null },
            ),
        )
    }
}

internal fun debugLog(message: String, error: Throwable? = null, tag: String = "ShellyRepository") {
    if (BuildConfig.DEBUG) {
        if (error == null) {
            Log.d(tag, message)
        } else {
            Log.d(tag, message, error)
        }
    }
}

private const val PUSH_PLATFORM_FCM = "fcm"

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
