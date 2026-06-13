package app.shelly.android.features.pairing

/** Crockford base32 alphabet shared with the daemon/protocol, excluding confusable letters. */
internal const val PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
internal const val PAIRING_CODE_LENGTH = 5
internal const val PAIRING_CAMERA_DENIED_BODY =
    "Camera access is off. Enter the pairing code from your laptop instead."
internal const val PAIRING_CAMERA_DENIED_ACTION = "Enter code instead"

/** Normalizes manual pairing-code input to the daemon's accepted Crockford form. */
internal fun normalizePairingCodeInput(input: String): String {
    val builder = StringBuilder(PAIRING_CODE_LENGTH)
    for (raw in input) {
        if (builder.length >= PAIRING_CODE_LENGTH) break
        val upper = raw.uppercaseChar()
        val ch = when (upper) {
            'I', 'L' -> '1'
            'O' -> '0'
            else -> upper
        }
        if (ch in PAIRING_CODE_ALPHABET) builder.append(ch)
    }
    return builder.toString()
}

internal fun isCompletePairingCode(code: String): Boolean =
    code.length == PAIRING_CODE_LENGTH && code.all { it in PAIRING_CODE_ALPHABET }
