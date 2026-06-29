package app.shelly.android.core

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
        result = 31 * result + protocolVersion
        return result
    }
}
