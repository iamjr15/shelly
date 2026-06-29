package app.shelly.android.core

/**
 * Health of the live daemon tunnel that backs the session subscription.
 *
 * The subscription call blocks while connected and unblocks (returns or throws) when the iroh
 * link drops, so [Connected] is the authoritative "we just heard from the daemon" edge and the
 * other two states are driven by the reconnect state machine in [ShellyViewModel]. All timestamps
 * are wall-clock millis so the UI can render absolute drop times and live countdowns.
 */
sealed interface ConnectionState {
    data object Connected : ConnectionState

    /** Link dropped recently; backing off with exponential delay before the next retry. */
    data class Reconnecting(
        val droppedAtMillis: Long,
        val attempt: Int,
        val nextRetryAtMillis: Long,
    ) : ConnectionState

    /** Link has stayed down past the unreachable threshold; retrying on a fixed slow cadence. */
    data class Unreachable(
        val droppedAtMillis: Long,
        val attempt: Int,
        val retryIntervalMillis: Long,
        val nextRetryAtMillis: Long,
    ) : ConnectionState
}

data class MobileSession(
    val id: String,
    val name: String,
    val command: List<String>,
    val cwd: String,
    val createdAt: ULong,
    val lastActivity: ULong,
    val state: AgentState,
    val lastLine: String?,
    val model: String?,
)

enum class AgentState(val sortRank: Int) {
    AwaitingInput(0),
    Working(1),
    Idle(2),
    Crashed(3),
}

data class PairedDaemonRecord(
    val daemonNodeId: String,
    val relayUrl: String?,
    val addrs: List<String>,
    val deviceNodeId: String,
    val deviceSecretKey: ByteArray,
    val pairedAtMillis: Long,
    val daemonVersion: String,
    val hostName: String,
    val protocolVersion: Int,
) {
    override fun equals(other: Any?): Boolean {
        return other is PairedDaemonRecord &&
            daemonNodeId == other.daemonNodeId &&
            relayUrl == other.relayUrl &&
            addrs == other.addrs &&
            deviceNodeId == other.deviceNodeId &&
            deviceSecretKey.contentEquals(other.deviceSecretKey) &&
            pairedAtMillis == other.pairedAtMillis &&
            daemonVersion == other.daemonVersion &&
            hostName == other.hostName &&
            protocolVersion == other.protocolVersion
    }

    override fun hashCode(): Int {
        var result = daemonNodeId.hashCode()
        result = 31 * result + (relayUrl?.hashCode() ?: 0)
        result = 31 * result + addrs.hashCode()
        result = 31 * result + deviceNodeId.hashCode()
        result = 31 * result + deviceSecretKey.contentHashCode()
        result = 31 * result + pairedAtMillis.hashCode()
        result = 31 * result + daemonVersion.hashCode()
        result = 31 * result + hostName.hashCode()
        result = 31 * result + protocolVersion
        return result
    }
}

/** Friendly identifier for the paired computer; falls back to a generic label pre-host-name. */
fun PairedDaemonRecord?.displayName(): String =
    this?.hostName?.takeIf { it.isNotBlank() } ?: "your laptop"
