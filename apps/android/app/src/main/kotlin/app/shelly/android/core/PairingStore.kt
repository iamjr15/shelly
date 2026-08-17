package app.shelly.android.core

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

class PairingStore internal constructor(
    context: Context,
    private val cipher: PairingCipher,
) {
    constructor(context: Context) : this(context, KeystorePairingCipher())

    private val prefs = context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    init {
        context.deleteSharedPreferences("shelly_pairing")
    }

    fun load(): PairedDaemonRecord? {
        return readEncrypted(DAEMON_KEY) { json ->
            PairedDaemonRecord(
                daemonNodeId = json.getString("daemonNodeId"),
                relayUrl = json.optString("relayUrl").ifBlank { null },
                addrs = json.stringList("addrs"),
                deviceNodeId = json.getString("deviceNodeId"),
                deviceSecretKey = Base64.decode(json.getString("deviceSecretKey"), Base64.NO_WRAP),
                pairedAtMillis = json.getLong("pairedAtMillis"),
                // Defaults keep records written before these fields existed loadable.
                daemonVersion = json.optString("daemonVersion", ""),
                hostName = json.optString("hostName", ""),
                protocolVersion = json.optInt("protocolVersion", 0),
            )
        }
    }

    fun save(record: PairedDaemonRecord) {
        val addrs = JSONArray()
        record.addrs.forEach(addrs::put)
        val json = JSONObject()
            .put("daemonNodeId", record.daemonNodeId)
            .put("relayUrl", record.relayUrl ?: "")
            .put("addrs", addrs)
            .put("deviceNodeId", record.deviceNodeId)
            .put("deviceSecretKey", Base64.encodeToString(record.deviceSecretKey, Base64.NO_WRAP))
            .put("pairedAtMillis", record.pairedAtMillis)
            .put("daemonVersion", record.daemonVersion)
            .put("hostName", record.hostName)
            .put("protocolVersion", record.protocolVersion)
        writeEncrypted(DAEMON_KEY, json)
    }

    fun clear() {
        // Keep the encrypted push-unregister tombstone: it must outlive the visible pairing.
        prefs.edit().remove(DAEMON_KEY).apply()
    }

    internal fun savePushUnregisterTombstone(tombstone: PushUnregisterTombstone) {
        val addrs = JSONArray().apply { tombstone.addrs.forEach(::put) }
        val tokens = JSONArray().apply {
            tombstone.tokens.forEach { token ->
                put(
                    JSONObject()
                        .put("platform", token.platform)
                        .put("token", token.token)
                        .put("createdAtMillis", token.createdAtMillis),
                )
            }
        }
        val json = JSONObject()
            .put("daemonNodeId", tombstone.daemonNodeId)
            .put("relayUrl", tombstone.relayUrl ?: "")
            .put("addrs", addrs)
            .put("deviceNodeId", tombstone.deviceNodeId)
            .put("deviceSecretKey", Base64.encodeToString(tombstone.deviceSecretKey, Base64.NO_WRAP))
            .put("tokens", tokens)
        writeEncrypted(PUSH_UNREGISTER_TOMBSTONE_KEY, json)
    }

    internal fun loadPushUnregisterTombstone(): PushUnregisterTombstone? {
        return readEncrypted(PUSH_UNREGISTER_TOMBSTONE_KEY) { json ->
            val tokensJson = json.getJSONArray("tokens")
            PushUnregisterTombstone(
                daemonNodeId = json.getString("daemonNodeId"),
                relayUrl = json.optString("relayUrl").ifBlank { null },
                addrs = json.stringList("addrs"),
                deviceNodeId = json.getString("deviceNodeId"),
                deviceSecretKey = Base64.decode(json.getString("deviceSecretKey"), Base64.NO_WRAP),
                tokens = List(tokensJson.length()) { index ->
                    tokensJson.getJSONObject(index).let { token ->
                        PushTokenMetadata(
                            platform = token.getString("platform"),
                            token = token.getString("token"),
                            createdAtMillis = token.getLong("createdAtMillis"),
                        )
                    }
                },
            )
        }
    }

    internal fun acknowledgePushToken(token: String) {
        val tombstone = loadPushUnregisterTombstone() ?: return
        val remaining = tombstone.tokens.filterNot { it.token == token }
        if (remaining.isEmpty()) {
            clearPushUnregisterTombstone()
        } else {
            savePushUnregisterTombstone(tombstone.copy(tokens = remaining))
        }
    }

    internal fun clearPushUnregisterTombstone() {
        prefs.edit().remove(PUSH_UNREGISTER_TOMBSTONE_KEY).apply()
    }

    internal fun warm() {
        prefs.all
    }

    private fun writeEncrypted(key: String, json: JSONObject) {
        val encrypted = cipher.encrypt(json.toString().toByteArray(Charsets.UTF_8))
        prefs.edit().putString(key, Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply()
    }

    private fun <T> readEncrypted(key: String, parse: (JSONObject) -> T): T? {
        val stored = prefs.getString(key, null) ?: return null
        return runCatching {
            val raw = String(cipher.decrypt(Base64.decode(stored, Base64.NO_WRAP)), Charsets.UTF_8)
            parse(JSONObject(raw))
        }.onFailure { error ->
            debugLog("clearing poisoned encrypted record: $key", error, "ShellyPairingStore")
            prefs.edit().remove(key).apply()
        }.getOrNull()
    }

    private fun JSONObject.stringList(key: String): List<String> {
        val array = getJSONArray(key)
        return List(array.length()) { index -> array.getString(index) }
    }

    private companion object {
        const val PREFERENCES_NAME = "shelly_pairing_v2"
        const val DAEMON_KEY = "daemon"
        const val PUSH_UNREGISTER_TOMBSTONE_KEY = "push_unregister_tombstone"
    }
}
