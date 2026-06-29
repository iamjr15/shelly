package app.shelly.android.core

import android.content.Context
import android.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PairingStoreTest {
    private lateinit var context: Context
    private lateinit var cipher: PairingCipher

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication().applicationContext
        context.pairingPrefsForTests().edit().clear().commit()
        cipher = InMemoryPairingCipher()
    }

    @Test
    fun saveThenLoadRoundTripsRecord() {
        val store = PairingStore(context, cipher)
        val record = pairedRecord()

        store.save(record)

        assertEquals(record, store.load())
    }

    @Test
    fun saveThenLoadPreservesNullRelayUrl() {
        val store = PairingStore(context, cipher)
        val record = pairedRecord(relayUrl = null)

        store.save(record)

        assertEquals(record, store.load())
    }

    @Test
    fun clearRemovesSavedRecord() {
        val store = PairingStore(context, cipher)
        store.save(pairedRecord())

        store.clear()

        assertNull(store.load())
    }

    @Test
    fun loadReturnsNullForCorruptedStoredBlob() {
        val store = PairingStore(context, cipher)
        val corrupted = byteArrayOf(12) + ByteArray(12) + ByteArray(24) { 7 }
        context.pairingPrefsForTests()
            .edit()
            .putString("daemon", Base64.encodeToString(corrupted, Base64.NO_WRAP))
            .commit()

        assertNull(store.load())
    }

    @Test
    fun initDeletesLegacyPairingPrefs() {
        context.applicationContext
            .getSharedPreferences("shelly_pairing", Context.MODE_PRIVATE)
            .edit()
            .putString("daemon", "legacy")
            .commit()

        PairingStore(context, cipher)

        val legacy = context.applicationContext
            .getSharedPreferences("shelly_pairing", Context.MODE_PRIVATE)
        assertTrue(legacy.all.isEmpty())
    }

    private fun pairedRecord(relayUrl: String? = "https://relay.example.com") = PairedDaemonRecord(
        daemonNodeId = "daemon-node-id",
        relayUrl = relayUrl,
        addrs = listOf("192.168.1.20:4433", "10.0.0.7:4433"),
        deviceNodeId = "device-node-id",
        deviceSecretKey = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8),
        pairedAtMillis = 1_717_000_000_000L,
        daemonVersion = "1.2.3",
        hostName = "macbook-pro",
        protocolVersion = 3,
    )

    private fun Context.pairingPrefsForTests() =
        applicationContext.getSharedPreferences("shelly_pairing_v2", Context.MODE_PRIVATE)

    private class InMemoryPairingCipher : PairingCipher {
        private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

        override fun encrypt(plaintext: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext)
            val payload = ByteArray(1 + iv.size + ciphertext.size)
            payload[0] = iv.size.toByte()
            iv.copyInto(payload, 1)
            ciphertext.copyInto(payload, 1 + iv.size)
            return payload
        }

        override fun decrypt(payload: ByteArray): ByteArray {
            val ivLength = payload[0].toInt()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, payload, 1, ivLength))
            return cipher.doFinal(payload, 1 + ivLength, payload.size - 1 - ivLength)
        }
    }
}
