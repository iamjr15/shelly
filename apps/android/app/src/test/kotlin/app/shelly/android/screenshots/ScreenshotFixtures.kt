package app.shelly.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import app.shelly.android.core.AgentState
import app.shelly.android.core.ConnectionState
import app.shelly.android.core.MobileSession
import app.shelly.android.core.PairedDaemonRecord
import app.shelly.android.core.UiTestClock
import app.shelly.android.features.pairing.PairingContent
import app.shelly.android.features.pairing.PairingUiState
import app.shelly.android.features.sessions.DaemonUnreachableScaffold
import app.shelly.android.features.sessions.ReconnectingScaffold
import app.shelly.android.features.sessions.SessionActionsSheet
import app.shelly.android.features.sessions.SessionsDashboard
import app.shelly.android.features.sessions.SessionsEmptyScaffold
import app.shelly.android.features.sessions.SessionsSearchScaffold
import app.shelly.android.features.settings.AppearanceScreen
import app.shelly.android.features.settings.SettingsContent
import app.shelly.android.features.terminal.AttachStatus
import app.shelly.android.features.terminal.LockedStatus
import app.shelly.android.features.terminal.TerminalScaffold
import app.shelly.android.features.terminal.TerminalTabBar
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType

internal fun screenshotSessions(): List<MobileSession> = listOf(
    MobileSession("1", "shelly · crates/cli", listOf("claude"), "/x", 0u, 6u, AgentState.AwaitingInput, "› Approve replacing src/cli/pair.rs ?", "opus-4-8"),
    MobileSession("2", "shelly · crates/daemon", listOf("cargo", "test"), "/x", 0u, 5u, AgentState.Working, "cargo test --workspace --no-fail-fast", null),
    MobileSession("3", "infra · scripts/dogfood", listOf("./gradlew"), "/x", 0u, 4u, AgentState.Working, "Building Android release · :app:assemble", null),
    MobileSession("4", "scratch · ~/notes", listOf("vim"), "/x", 0u, 3u, AgentState.Idle, "vim notes/2026-06-28-plan.md", null),
    MobileSession("5", "dotfiles · ~", listOf("zsh"), "/x", 0u, 2u, AgentState.Idle, "zsh · idle 1h", null),
    MobileSession("6", "ios-release · apps/ios", listOf("xcodebuild"), "/x", 0u, 1u, AgentState.Crashed, "xcodebuild: archive failed (code 65)", null),
)

@Composable
internal fun SettingsScreenshotFixture() {
    SettingsContent(
        paired = true,
        pairedDaemon = PairedDaemonRecord(
            daemonNodeId = "fixture-daemon",
            relayUrl = null,
            addrs = emptyList(),
            deviceNodeId = "fixture-device",
            deviceSecretKey = ByteArray(0),
            pairedAtMillis = 0L,
            daemonVersion = "1.0.0",
            hostName = "dev-macbook",
            protocolVersion = 3,
        ),
        themeModeLabel = "SYSTEM",
        notificationsLabel = "OFF",
        securityLabel = "5 MIN",
        aboutVersionLabel = "V1.0",
        onBackToSessions = {},
        onOpenAppearance = {},
        onOpenNotifications = {},
        onOpenSecurity = {},
        onOpenAbout = {},
        onOpenDaemonDetail = {},
        onUnpair = {},
    )
}

@Composable
internal fun PairingScreenshotFixture(state: PairingUiState = PairingUiState.Idle) {
    val fixtureCode = "K29M7QX"
    var code by remember {
        mutableStateOf(TextFieldValue(fixtureCode, selection = TextRange(fixtureCode.length)))
    }
    PairingContent(
        code = code,
        onCodeChange = { code = it },
        cameraGranted = false,
        showCamera = false,
        pairing = state == PairingUiState.Connecting,
        uiState = state,
        onCancelPairing = {},
        onRetryPairing = {},
        onOpenSettings = {},
        onPair = {},
        onPairWithCode = {},
        onConfirmPairing = {},
    )
}

@Composable
internal fun ModalScreenshotHost(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(ShellyTheme.colors.screen)) {
        AppearanceScreen(onBack = {})
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.70f))
                .clearAndSetSemantics {},
        )
        Box(Modifier.align(Alignment.BottomCenter)) { content() }
    }
}

@Composable
internal fun SessionsDashboardFixture(loading: Boolean = false, sessions: List<MobileSession> = screenshotSessions()) {
    val counts = AgentState.entries.associateWith { state -> sessions.count { it.state == state } }
    SessionsDashboard(
        allSessions = sessions,
        visibleSessions = sessions,
        loading = loading,
        laptopName = "dev-macbook",
        counts = counts,
        selectedFilter = null,
        onSelectFilter = {},
        onOpenCommandPalette = {},
        onSearch = {},
        onRefresh = {},
        onToggleTheme = {},
        onOpen = {},
        onActions = {},
        onNewSession = {},
    )
}

@Composable
internal fun SessionsSearchFixture() {
    val sessions = screenshotSessions().take(2)
    SessionsSearchScaffold(
        query = TextFieldValue("shelly"),
        focusRequester = remember { FocusRequester() },
        matches = sessions,
        totalSessions = 6,
        totalDevices = 1,
        onQueryChange = {},
        onClose = {},
        onRefresh = {},
        onOpen = {},
        onActions = {},
    )
}

@Composable
internal fun SessionsEmptyFixture() = SessionsEmptyScaffold(laptopName = "dev-macbook")

@Composable
internal fun DaemonUnreachableFixture() {
    val now = remember { UiTestClock.nowMillis() }
    DaemonUnreachableScaffold(
        unreachable = ConnectionState.Unreachable(now - 120_000L, 9, 15_000L, now + 15_000L),
        laptopName = "dev-macbook",
        onRetry = {},
    )
}

@Composable
internal fun ReconnectingFixture() {
    val now = remember { UiTestClock.nowMillis() }
    ReconnectingScaffold(
        reconnecting = ConnectionState.Reconnecting(now - 4_000L, 3, now + 2_000L),
        sessions = screenshotSessions().take(2),
        laptopName = "dev-macbook",
        onRetry = {},
    )
}

@Composable
internal fun SessionsLongPressFixture() {
    val sessions = screenshotSessions()
    Box(Modifier.fillMaxSize()) {
        SessionsDashboardFixture(sessions = sessions)
        SessionActionsSheet(sessions.first(), "dev-macbook", {}, {}, {})
    }
}

internal enum class TerminalFixtureState { Base, Attaching, Locked, Exited, ClaudeTui }

@Composable
internal fun TerminalScreenshotFixture(state: TerminalFixtureState) {
    val session = remember {
        MobileSession("terminal", "crates/daemon", listOf("zsh"), "/repo", 0u, 1u, AgentState.Idle, null, null)
    }
    TerminalScaffold(
        topBar = {
            TerminalTabBar(
                tabs = listOf(session),
                activeSessionId = session.id,
                controllers = emptyMap(),
                attachErrors = emptyMap(),
                onBack = {},
                onSelectTab = {},
                onCloseTab = {},
                onAddTab = {},
            )
        },
        accessoryDimmed = state == TerminalFixtureState.Locked,
        accessoryEnabled = false,
        ctrlActive = true,
        onAccessory = {},
    ) {
        when (state) {
            TerminalFixtureState.Attaching -> AttachStatus("crates/daemon", null, {})
            TerminalFixtureState.Locked -> LockedStatus {}
            TerminalFixtureState.Base,
            TerminalFixtureState.Exited,
            TerminalFixtureState.ClaudeTui,
            -> TerminalTranscriptFixture(state)
        }
    }
}

@Composable
private fun TerminalTranscriptFixture(state: TerminalFixtureState) {
    val terminal = ShellyTheme.terminalColors
    val lines = when (state) {
        TerminalFixtureState.Exited -> listOf("~/shelly on main", "❯ exit", "logout", "[ process exited · code 0 ]")
        TerminalFixtureState.ClaudeTui -> listOf("~/shelly on main", "❯ shelly agent", "opus-4-8 · ready", "Read src/pairing/token.rs", "Apply this change?")
        else -> listOf("~/shelly on main", "❯ cargo test --workspace", "running 142 tests", "test result: ok. 142 passed; 0 failed", "❯ ")
    }
    Column(
        Modifier.fillMaxSize().padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        lines.forEachIndexed { index, line ->
            Text(
                line,
                style = ShellyType.mono,
                color = when {
                    state == TerminalFixtureState.Exited && index == lines.lastIndex -> terminal.error
                    line.startsWith("test result") -> terminal.success
                    else -> terminal.foreground
                },
            )
        }
        if (state == TerminalFixtureState.ClaudeTui) {
            Spacer(Modifier.height(12.dp))
            Box(
                Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .background(terminal.diffPanel)
                    .padding(12.dp),
            ) {
                Text("+ t.sig_ok() && t.age() < TTL", style = ShellyType.mono, color = terminal.success)
            }
        }
    }
}
