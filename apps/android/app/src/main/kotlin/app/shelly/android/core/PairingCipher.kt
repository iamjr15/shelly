package app.shelly.android.core

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal interface PairingCipher {
    fun encrypt(plaintext: ByteArray): ByteArray

    fun decrypt(payload: ByteArray): ByteArray
}

internal class KeystorePairingCipher : PairingCipher {
    override fun encrypt(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, obtainKey())
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
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, obtainKey(), GCMParameterSpec(128, payload, 1, ivLength))
        return cipher.doFinal(payload, 1 + ivLength, payload.size - 1 - ivLength)
    }

    private fun obtainKey(): SecretKey {
        return synchronized(KEY_LOCK) {
            loadKey()?.let { return@synchronized it }
            val generated = runCatching {
                val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
                generator.init(
                    KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .setUnlockedDeviceRequired(true)
                        .build(),
                )
                generator.generateKey()
            }
            // Another process may create the alias between our first lookup and generateKey().
            // Re-read the keystore before surfacing that race as a failure.
            generated.getOrElse { error -> loadKey() ?: throw error }
        }
    }

    private fun loadKey(): SecretKey? {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        return keyStore.getKey(KEY_ALIAS, null) as? SecretKey
    }

    private companion object {
        val KEY_LOCK = Any()
        const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        const val KEY_ALIAS = "shelly_pairing_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
