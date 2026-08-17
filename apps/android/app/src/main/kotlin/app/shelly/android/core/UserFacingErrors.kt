package app.shelly.android.core

import uniffi.shelly_mobile_core.ShellyException

data class PairingErrorMessage(
    val message: String,
    val detail: String,
)

data class ShellyAlertMessage(
    val kicker: String,
    val title: String,
    val meta: String,
    val body: String,
    val primary: String = "Try again",
    val secondary: String = "Dismiss",
)

internal data class TerminalAttachErrorMessage(
    val title: String,
    val body: String,
)

internal fun pairingErrorMessage(error: Throwable): PairingErrorMessage {
    return when (error) {
        is ShellyException.VersionMismatch -> PairingErrorMessage(
            message = "Update Shelly to continue pairing.",
            detail = "Install the latest Shelly app and update Shelly on your computer, then try again.",
        )
        is ShellyException.NotFound -> PairingErrorMessage(
            message = "That pairing code expired or was already used.",
            detail = "Run `shelly pair` on your computer for a fresh code.",
        )
        is ShellyException.Forbidden -> {
            val detail = error.message.orEmpty()
            when {
                detail.contains("denied", ignoreCase = true) -> PairingErrorMessage(
                    message = "Pairing was denied on your computer.",
                    detail = "Run `shelly pair` again and approve this phone when prompted.",
                )
                detail.contains("expired", ignoreCase = true) ||
                    detail.contains("invalid", ignoreCase = true) ||
                    detail.contains("already used", ignoreCase = true) -> PairingErrorMessage(
                        message = "That pairing code expired or was already used.",
                        detail = "Run `shelly pair` on your computer for a fresh code.",
                    )
                else -> PairingErrorMessage(
                    message = "The daemon rejected this pairing request.",
                    detail = "Run `shelly pair` again and approve this phone from the computer.",
                )
            }
        }
        is ShellyException.InvalidConfig -> PairingErrorMessage(
            message = "Typed pairing codes are not available in this build.",
            detail = "Scan the QR code from `shelly pair` instead.",
        )
        is ShellyException.Transport -> PairingErrorMessage(
            message = "Shelly could not reach the pairing relay or your computer.",
            detail = "Check your connection, keep `shelly pair` open, then try again.",
        )
        is ShellyException.Unauthorized -> PairingErrorMessage(
            message = "The daemon rejected this phone's pairing identity.",
            detail = "Run `shelly pair` again and use the fresh QR code or code.",
        )
        is ShellyException.Protocol -> PairingErrorMessage(
            message = "Shelly could not read that pairing ticket.",
            detail = "Run `shelly pair` again and scan or type the fresh code.",
        )
        is ShellyException.Internal -> PairingErrorMessage(
            message = "The daemon could not finish pairing.",
            detail = "Run `shelly doctor` on your computer, then start `shelly pair` again.",
        )
        else -> PairingErrorMessage(
            message = "Pairing stopped because Android reported an unexpected error.",
            detail = "Run `shelly pair` again and try a fresh code.",
        )
    }
}

internal fun savedPairingUnavailableMessage(error: Throwable): PairingErrorMessage {
    return when (error) {
        is ShellyException.InvalidConfig -> PairingErrorMessage(
            message = "The saved pairing on this phone is incomplete.",
            detail = "Run `shelly pair` on your computer and pair this phone again.",
        )
        else -> PairingErrorMessage(
            message = "Shelly could not read the saved pairing on this phone.",
            detail = "Pair again from your computer if your sessions do not appear.",
        )
    }
}

internal fun revokedPairingMessage(): PairingErrorMessage = PairingErrorMessage(
    message = "This phone is no longer paired with your computer.",
    detail = "Run `shelly pair` on your computer and pair this phone again.",
)

internal fun sessionsUnavailableMessage(error: Throwable): ShellyAlertMessage {
    return when (error) {
        is ShellyException.Transport -> daemonUnreachableAlert(
            meta = transportMeta(error),
            body = transportBody("load sessions", error),
        )
        is ShellyException.Unauthorized -> unpairedAlert(
            body = "This phone is no longer paired with the daemon. Run `shelly pair` on your computer and pair this phone again.",
        )
        is ShellyException.Forbidden -> ShellyAlertMessage(
            kicker = "SESSION LIST WAS REJECTED",
            title = "DENIED",
            meta = "daemon authorization",
            body = "The daemon rejected the session list request. Restart `shellyd`; if it keeps happening, pair this phone again.",
        )
        is ShellyException.Protocol -> ShellyAlertMessage(
            kicker = "SESSION LIST RESPONSE WAS INVALID",
            title = "SYNC",
            meta = "protocol mismatch",
            body = "Shelly could not understand the daemon's session response. Update or restart Shelly on your computer, then try again.",
        )
        is ShellyException.Internal -> ShellyAlertMessage(
            kicker = "DAEMON COULD NOT LIST SESSIONS",
            title = "DAEMON",
            meta = "daemon internal error",
            body = "The daemon failed while listing sessions. Run `shelly doctor` on your computer, then try again.",
        )
        else -> ShellyAlertMessage(
            kicker = "SESSION REFRESH FAILED",
            title = "SYNC",
            meta = "android client error",
            body = "Shelly could not refresh sessions because Android reported an unexpected error. Try again; if it continues, run `shelly doctor` on your computer.",
        )
    }
}

internal fun createSessionFailedMessage(error: Throwable): ShellyAlertMessage {
    return when (error) {
        is ShellyException.Transport -> daemonUnreachableAlert(
            meta = transportMeta(error),
            body = transportBody("create a new shell session", error),
        )
        is ShellyException.Unauthorized -> unpairedAlert(
            body = "This phone is no longer authorized to create sessions. Run `shelly pair` on your computer and pair this phone again.",
        )
        is ShellyException.Forbidden -> ShellyAlertMessage(
            kicker = "SESSION CREATE WAS REJECTED",
            title = "DENIED",
            meta = "daemon authorization",
            body = "The daemon rejected mobile session creation. Update or restart Shelly on your computer, then try again.",
        )
        is ShellyException.InvalidConfig -> ShellyAlertMessage(
            kicker = "SAVED PAIRING IS INCOMPLETE",
            title = "PAIR",
            meta = "local pairing config",
            body = "Shelly cannot create a session because this phone's saved pairing is incomplete. Pair this phone again from your computer.",
            primary = "Pair again",
        )
        is ShellyException.Internal -> ShellyAlertMessage(
            kicker = "DAEMON COULD NOT CREATE A SESSION",
            title = "DAEMON",
            meta = "daemon session create",
            body = "The daemon could not start a shell session. Run `shelly doctor` on your computer, then try again.",
        )
        else -> ShellyAlertMessage(
            kicker = "SESSION CREATE FAILED",
            title = "CREATE",
            meta = "android client error",
            body = "Shelly could not create a session because Android reported an unexpected error. Try again from the Sessions screen.",
        )
    }
}

internal fun killSessionFailedMessage(error: Throwable): ShellyAlertMessage {
    return when (error) {
        is ShellyException.NotFound -> ShellyAlertMessage(
            kicker = "SESSION IS ALREADY GONE",
            title = "GONE",
            meta = "session not found",
            body = "That session no longer exists on your computer. Refresh sessions to update the list.",
            primary = "Refresh",
        )
        is ShellyException.Transport -> daemonUnreachableAlert(
            meta = transportMeta(error),
            body = transportBody("close the session", error),
        )
        is ShellyException.Unauthorized -> unpairedAlert(
            body = "This phone is no longer authorized to close sessions. Run `shelly pair` on your computer and pair this phone again.",
        )
        is ShellyException.Forbidden -> ShellyAlertMessage(
            kicker = "SESSION CLOSE WAS REJECTED",
            title = "DENIED",
            meta = "daemon authorization",
            body = "The daemon rejected the close request for this session. Refresh sessions and try again.",
        )
        else -> ShellyAlertMessage(
            kicker = "SESSION CLOSE FAILED",
            title = "CLOSE",
            meta = "android client error",
            body = "Shelly could not close that session because Android reported an unexpected error. Refresh sessions and try again.",
        )
    }
}

internal fun terminalAttachErrorMessage(error: Throwable): TerminalAttachErrorMessage {
    return when (error) {
        is ShellyException.NotFound -> TerminalAttachErrorMessage(
            title = "Session not found",
            body = "That session ended or was removed on your computer. Go back to Sessions and refresh.",
        )
        is ShellyException.Transport -> TerminalAttachErrorMessage(
            title = "Could not reach daemon",
            body = "Make sure your computer is awake and `shellyd` is running, then retry the attach.",
        )
        is ShellyException.Unauthorized -> TerminalAttachErrorMessage(
            title = "Phone is no longer paired",
            body = "Pair this phone again from your computer before opening terminal sessions.",
        )
        is ShellyException.Forbidden -> TerminalAttachErrorMessage(
            title = "Attach was rejected",
            body = "The daemon rejected this terminal attach. Refresh sessions and try again.",
        )
        is ShellyException.Protocol -> TerminalAttachErrorMessage(
            title = "Terminal response invalid",
            body = "Restart `shellyd` or update Shelly on your computer, then retry the attach.",
        )
        else -> TerminalAttachErrorMessage(
            title = "Terminal attach failed",
            body = "Shelly could not open that terminal because Android reported an unexpected error. Go back to Sessions and try again.",
        )
    }
}

internal fun terminalCommandErrorPhase(error: Throwable): TerminalPhase {
    return when (error) {
        is ShellyException.NotFound -> TerminalPhase.Error(TerminalErrorKind.SessionEnded)
        is ShellyException.Unauthorized -> TerminalPhase.Error(TerminalErrorKind.Unpaired)
        is ShellyException.Forbidden -> TerminalPhase.Error(TerminalErrorKind.Denied)
        else -> TerminalPhase.Error(TerminalErrorKind.ConnectionLost)
    }
}

private fun daemonUnreachableAlert(meta: String, body: String): ShellyAlertMessage {
    return ShellyAlertMessage(
        kicker = when (meta) {
            "transport timeout" -> "DAEMON CONNECTION TIMED OUT"
            "relay connection" -> "RELAY CONNECTION FAILED"
            "network connection" -> "NETWORK PATH TO DAEMON FAILED"
            "daemon stream closed" -> "DAEMON CONNECTION DROPPED"
            else -> "COULD NOT REACH THE DAEMON"
        },
        title = "OFFLINE",
        meta = meta,
        body = body,
    )
}

private fun unpairedAlert(body: String): ShellyAlertMessage {
    return ShellyAlertMessage(
        kicker = "PHONE IS NOT AUTHORIZED",
        title = "UNPAIRED",
        meta = "daemon authorization",
        body = body,
        primary = "Pair again",
    )
}

private fun transportMeta(error: ShellyException.Transport): String {
    val message = error.message.orEmpty()
    return when {
        message.contains("timed out", ignoreCase = true) -> "transport timeout"
        message.contains("relay", ignoreCase = true) -> "relay connection"
        message.contains("network", ignoreCase = true) ||
            message.contains("dns", ignoreCase = true) ||
            message.contains("resolve", ignoreCase = true) -> "network connection"
        message.contains("stream", ignoreCase = true) ||
            message.contains("frame", ignoreCase = true) ||
            message.contains("read", ignoreCase = true) ||
            message.contains("write", ignoreCase = true) -> "daemon stream closed"
        else -> "transport connection"
    }
}

private fun transportBody(action: String, error: ShellyException.Transport): String {
    return when (transportMeta(error)) {
        "transport timeout" -> "Shelly timed out while trying to $action from your computer. Make sure the computer is awake and `shellyd` is running, then try again."
        "relay connection", "network connection" -> "Shelly could not $action because the network path to your computer failed. Check this phone's connection and that your computer is online, then try again."
        "daemon stream closed" -> "The connection to your computer dropped while Shelly tried to $action. Keep the computer awake and try again."
        else -> "Shelly could not $action because your computer could not be reached. Make sure it is awake and `shellyd` is running, then try again."
    }
}
