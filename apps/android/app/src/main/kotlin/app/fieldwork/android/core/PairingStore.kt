package app.fieldwork.android.core

import android.content.Context
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

class PairingStore(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs = EncryptedSharedPreferences.create(
        context,
        "fieldwork_pairing",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun load(): PairedDaemonRecord? {
        val raw = prefs.getString("daemon", null) ?: return null
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
        prefs.edit().putString("daemon", json.toString()).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }
}
