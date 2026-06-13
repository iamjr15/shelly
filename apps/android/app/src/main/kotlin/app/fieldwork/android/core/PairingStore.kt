package app.fieldwork.android.core

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

class PairingStore internal constructor(
    context: Context,
    private val cipher: PairingCipher,
) {
    constructor(context: Context) : this(context, KeystorePairingCipher())

    private val prefs = context.getSharedPreferences("fieldwork_pairing_v2", Context.MODE_PRIVATE)

    init {
        context.deleteSharedPreferences("fieldwork_pairing")
    }

    fun load(): PairedDaemonRecord? {
        val stored = prefs.getString("daemon", null) ?: return null
        val raw = runCatching {
            String(cipher.decrypt(Base64.decode(stored, Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrNull() ?: return null
        val json = JSONObject(raw)
        return PairedDaemonRecord(
            daemonNodeId = json.getString("daemonNodeId"),
            relayUrl = json.optString("relayUrl").ifBlank { null },
            addrs = json.getJSONArray("addrs").let { array ->
                List(array.length()) { index -> array.getString(index) }
            },
            deviceNodeId = json.getString("deviceNodeId"),
            deviceSecretKey = Base64.decode(json.getString("deviceSecretKey"), Base64.NO_WRAP),
            pairedAtMillis = json.getLong("pairedAtMillis"),
        )
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
        val encrypted = cipher.encrypt(json.toString().toByteArray(Charsets.UTF_8))
        prefs.edit().putString("daemon", Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
