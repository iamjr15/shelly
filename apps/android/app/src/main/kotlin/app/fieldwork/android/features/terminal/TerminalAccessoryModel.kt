package app.fieldwork.android.features.terminal

internal enum class TerminalAccessoryAction {
    SendBytes,
    ToggleCtrl,
    ToggleAlt,
}

internal data class TerminalAccessoryItem(
    val label: String,
    val contentDescription: String,
    val action: TerminalAccessoryAction,
    val bytes: ByteArray = byteArrayOf(),
) {
    override fun equals(other: Any?): Boolean {
        return other is TerminalAccessoryItem &&
            label == other.label &&
            contentDescription == other.contentDescription &&
            action == other.action &&
            bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int {
        var result = label.hashCode()
        result = 31 * result + contentDescription.hashCode()
        result = 31 * result + action.hashCode()
        result = 31 * result + bytes.contentHashCode()
        return result
    }
}

internal fun terminalAccessoryItems(): List<TerminalAccessoryItem> = listOf(
    TerminalAccessoryItem(
        label = "Esc",
        contentDescription = "Send escape",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b),
    ),
    TerminalAccessoryItem(
        label = "Ctrl",
        contentDescription = "Toggle control modifier",
        action = TerminalAccessoryAction.ToggleCtrl,
    ),
    TerminalAccessoryItem(
        label = "Alt",
        contentDescription = "Toggle alt modifier",
        action = TerminalAccessoryAction.ToggleAlt,
    ),
    TerminalAccessoryItem(
        label = "C-c",
        contentDescription = "Send Ctrl-C interrupt",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x03),
    ),
    TerminalAccessoryItem(
        label = "C-d",
        contentDescription = "Send Ctrl-D EOF",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x04),
    ),
    TerminalAccessoryItem(
        label = "Tab",
        contentDescription = "Send tab",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x09),
    ),
    TerminalAccessoryItem(
        label = "|",
        contentDescription = "Send pipe",
        action = TerminalAccessoryAction.SendBytes,
        bytes = "|".encodeToByteArray(),
    ),
    TerminalAccessoryItem(
        label = "/",
        contentDescription = "Send slash",
        action = TerminalAccessoryAction.SendBytes,
        bytes = "/".encodeToByteArray(),
    ),
    TerminalAccessoryItem(
        label = "Up",
        contentDescription = "Send arrow up",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x41),
    ),
    TerminalAccessoryItem(
        label = "Down",
        contentDescription = "Send arrow down",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x42),
    ),
    TerminalAccessoryItem(
        label = "Left",
        contentDescription = "Send arrow left",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x44),
    ),
    TerminalAccessoryItem(
        label = "Right",
        contentDescription = "Send arrow right",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x43),
    ),
    TerminalAccessoryItem(
        label = "Home",
        contentDescription = "Send home",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x48),
    ),
    TerminalAccessoryItem(
        label = "End",
        contentDescription = "Send end",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x46),
    ),
    TerminalAccessoryItem(
        label = "PgUp",
        contentDescription = "Send page up",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x35, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "PgDn",
        contentDescription = "Send page down",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x36, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F1",
        contentDescription = "Send F1",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x4f, 0x50),
    ),
    TerminalAccessoryItem(
        label = "F2",
        contentDescription = "Send F2",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x4f, 0x51),
    ),
    TerminalAccessoryItem(
        label = "F3",
        contentDescription = "Send F3",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x4f, 0x52),
    ),
    TerminalAccessoryItem(
        label = "F4",
        contentDescription = "Send F4",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x4f, 0x53),
    ),
    TerminalAccessoryItem(
        label = "F5",
        contentDescription = "Send F5",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x31, 0x35, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F6",
        contentDescription = "Send F6",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x31, 0x37, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F7",
        contentDescription = "Send F7",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x31, 0x38, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F8",
        contentDescription = "Send F8",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x31, 0x39, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F9",
        contentDescription = "Send F9",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x32, 0x30, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F10",
        contentDescription = "Send F10",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x32, 0x31, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F11",
        contentDescription = "Send F11",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x32, 0x33, 0x7e),
    ),
    TerminalAccessoryItem(
        label = "F12",
        contentDescription = "Send F12",
        action = TerminalAccessoryAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x32, 0x34, 0x7e),
    ),
)
