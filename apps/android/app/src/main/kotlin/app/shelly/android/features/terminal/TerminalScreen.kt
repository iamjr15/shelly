@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package app.shelly.android.features.terminal

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.core.AgentState
import app.shelly.android.core.AndroidBiometricGate
import app.shelly.android.core.MobileSession
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.core.TerminalController
import app.shelly.android.core.TerminalAttachErrorMessage
import app.shelly.android.core.TerminalUiState
import app.shelly.android.core.terminalAttachErrorMessage
import app.shelly.android.core.terminalHeaderStatusForError
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.connectbot.terminal.Terminal

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TerminalScreen(
    session: MobileSession,
    viewModel: ShellyViewModel,
    biometricGate: AndroidBiometricGate,
    onBack: () -> Unit,
) {
    val terminalFocusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    var controller by remember(session.id) { mutableStateOf<TerminalController?>(null) }
    var attachError by remember(session.id) { mutableStateOf<TerminalAttachErrorMessage?>(null) }
    var attachAttempt by remember(session.id) { mutableStateOf(0) }
    var lockedDismissed by remember(session.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(session.id, attachAttempt) {
        controller = null
        attachError = null
        lockedDismissed = false
        try {
            controller = viewModel.createTerminalController(session) {
                biometricGate.unlock("Send terminal input")
            }
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            attachError = terminalAttachErrorMessage(error)
        }
    }

    LaunchedEffect(controller) {
        if (controller != null) {
            delay(100)
            runCatching { terminalFocusRequester.requestFocus() }
            keyboardController?.show()
        }
    }

    val currentController = controller
    BackHandler(onBack = onBack)

    DisposableEffect(currentController) {
        onDispose { currentController?.detach() }
    }

    if (currentController == null) {
        TerminalChrome(
            title = session.name,
            status = "ATTACHING",
            onBack = onBack,
            accessoryEnabled = false,
            onAccessory = {},
        ) {
            AttachStatus(
                sessionName = session.name,
                error = attachError,
                onRetry = { attachAttempt += 1 },
            )
        }
        return
    }

    val terminalState by currentController.state.collectAsState()
    LaunchedEffect(terminalState.status) {
        if (terminalState.status != "Locked") {
            lockedDismissed = false
        }
    }

    val locked = terminalState.status == "Locked" && !lockedDismissed
    TerminalChrome(
        title = session.name,
        status = terminalHeaderStatus(session, terminalState),
        onBack = onBack,
        accessoryDimmed = locked,
        accessoryEnabled = !locked,
        ctrlActive = currentController.modifierManager.ctrl,
        altActive = currentController.modifierManager.alt,
        onAccessory = { spec ->
            when (spec.action) {
                TerminalKeyAction.SendBytes -> currentController.sendAccessory(spec.bytes)
                TerminalKeyAction.ToggleCtrl -> currentController.modifierManager.toggleCtrl()
                TerminalKeyAction.ToggleAlt -> currentController.modifierManager.toggleAlt()
            }
        },
    ) {
        if (locked) {
            LockedStatus(
                onUnlock = {
                    scope.launch {
                        if (biometricGate.unlock("Send terminal input")) {
                            lockedDismissed = true
                            runCatching { terminalFocusRequester.requestFocus() }
                            keyboardController?.show()
                        }
                    }
                },
            )
        } else {
            Terminal(
                terminalEmulator = currentController.emulator,
                modifier = Modifier.fillMaxSize(),
                keyboardEnabled = terminalState.exitedCode == null,
                focusRequester = terminalFocusRequester,
                onTerminalTap = {
                    runCatching { terminalFocusRequester.requestFocus() }
                    keyboardController?.show()
                },
                modifierManager = currentController.modifierManager,
            )
        }
    }
}

internal enum class TerminalPreviewState {
    Base,
    Attaching,
    Locked,
    Exited,
    ClaudeTui,
}

/** Stateless render of the terminal screen states from Paper, with no live PTY session. */
@Composable
internal fun TerminalContentPreview(state: TerminalPreviewState) {
    val title = if (state == TerminalPreviewState.ClaudeTui) "claude agent" else "crates/daemon"
    val status = when (state) {
        TerminalPreviewState.Base -> "ATTACHED"
        TerminalPreviewState.Attaching -> "ATTACHING"
        TerminalPreviewState.Locked -> "LOCKED"
        TerminalPreviewState.Exited -> "EXITED"
        TerminalPreviewState.ClaudeTui -> "THINKING"
    }
    TerminalChrome(
        title = title,
        status = status,
        onBack = {},
        accessoryDimmed = state == TerminalPreviewState.Locked,
        accessoryEnabled = false,
        ctrlActive = true,
        onAccessory = {},
    ) {
        when (state) {
            TerminalPreviewState.Base -> MockTerminalTranscript(exited = false)
            TerminalPreviewState.Attaching -> AttachStatus(sessionName = "crates/daemon", error = null, onRetry = {})
            TerminalPreviewState.Locked -> LockedStatus(onUnlock = {})
            TerminalPreviewState.Exited -> MockTerminalTranscript(exited = true)
            TerminalPreviewState.ClaudeTui -> ClaudeTuiTranscript()
        }
    }
}

@Composable
private fun TerminalChrome(
    title: String,
    status: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    accessoryDimmed: Boolean = false,
    accessoryEnabled: Boolean = true,
    ctrlActive: Boolean = false,
    altActive: Boolean = false,
    onAccessory: (TerminalKeySpec) -> Unit,
    body: @Composable BoxScope.() -> Unit,
) {
    val accent = ShellyTheme.colors.accent
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
            .padding(16.dp),
    ) {
        TerminalHeader(
            title = title,
            status = status,
            accent = accent,
            onBack = onBack,
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(TerminalPlane)
                .padding(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 12.dp),
            content = body,
        )
        TerminalAccessoryBar(
            accent = accent,
            dimmed = accessoryDimmed,
            enabled = accessoryEnabled,
            ctrlActive = ctrlActive,
            altActive = altActive,
            onAccessory = onAccessory,
        )
    }
}

@Composable
private fun TerminalHeader(
    title: String,
    status: String,
    accent: Color,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
            .background(accent)
            .padding(start = 20.dp, top = 15.dp, end = 14.dp, bottom = 15.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            style = terminalInterStyle(fontSize = 17, lineHeight = 22, weight = FontWeight(600)),
            color = Color.Black,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(end = 12.dp),
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusPill(status = status)
            Box(
                modifier = Modifier
                    .size(32.dp)
                    .clip(RoundedCornerShape(50))
                    .background(Color.Black)
                    .clickable(onClick = onBack)
                    .semantics { contentDescription = "Close terminal" },
                contentAlignment = Alignment.Center,
            ) {
                CloseGlyph(Modifier.size(14.dp))
            }
        }
    }
}

@Composable
private fun StatusPill(status: String) {
    val exited = status == "EXITED"
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(100.dp))
            .background(if (exited) Color.Black.copy(alpha = 36f / 255f) else Color.Black.copy(alpha = 31f / 255f))
            .padding(horizontal = 10.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(RoundedCornerShape(50))
                .background(if (exited) TerminalDim else Color.Black),
        )
        Text(
            text = status,
            style = terminalMonoStyle(fontSize = 11, lineHeight = 14, weight = FontWeight(700), letterSpacing = 0.04.em),
            color = Color.Black,
            maxLines = 1,
        )
    }
}

@Composable
private fun TerminalAccessoryBar(
    accent: Color,
    dimmed: Boolean,
    enabled: Boolean,
    ctrlActive: Boolean,
    altActive: Boolean,
    onAccessory: (TerminalKeySpec) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp))
            .alpha(if (dimmed) 0.4f else 1f)
            .background(Color.White)
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        terminalKeySpecs().forEach { spec ->
            val selected = when (spec.action) {
                TerminalKeyAction.ToggleCtrl -> ctrlActive
                TerminalKeyAction.ToggleAlt -> altActive
                TerminalKeyAction.SendBytes -> false
            }
            TerminalKeyButton(
                spec = spec,
                enabled = enabled,
                accent = accent,
                selected = selected,
                onClick = { onAccessory(spec) },
            )
        }
    }
}

@Composable
private fun TerminalKeyButton(
    spec: TerminalKeySpec,
    enabled: Boolean,
    accent: Color,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val accented = spec.action == TerminalKeyAction.ToggleCtrl || selected
    val shape = RoundedCornerShape(8.dp)
    Box(
        modifier = Modifier
            .then(if (spec.fixedSquare) Modifier.size(36.dp) else Modifier.height(36.dp).widthIn(min = 44.dp))
            .clip(shape)
            .background(if (accented) accent else Color.White)
            .border(1.5.dp, if (accented) accent else Color.Black, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = spec.contentDescription }
            .padding(horizontal = if (spec.fixedSquare) 0.dp else 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        when (spec.visual) {
            TerminalKeyVisual.Down -> ChevronGlyph(up = false, modifier = Modifier.size(14.dp))
            TerminalKeyVisual.Text -> Text(
                text = spec.label,
                style = terminalMonoStyle(
                    fontSize = if (spec.label == "|") 14 else 13,
                    lineHeight = if (spec.label == "|") 18 else 16,
                    weight = if (spec.label == "|") FontWeight(400) else FontWeight(700),
                ),
                color = Color.Black,
                maxLines = 1,
            )
            TerminalKeyVisual.Up -> ChevronGlyph(up = true, modifier = Modifier.size(14.dp))
        }
    }
}

@Composable
private fun AttachStatus(
    sessionName: String,
    error: TerminalAttachErrorMessage?,
    onRetry: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(bottom = 2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        if (error == null) {
            AttachRing(Modifier.size(56.dp))
            Spacer(Modifier.height(20.dp))
        }
        Text(
            text = if (error == null) "Attaching to $sessionName" else error.title,
            style = terminalInterStyle(
                fontSize = if (error == null) 18 else 20,
                lineHeight = if (error == null) 22 else 24,
                weight = FontWeight(600),
            ),
            color = if (error == null) TerminalFg else TerminalRed,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(20.dp))
        if (error == null) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                TerminalLine("daemon reached · 14ms", color = TerminalMuted, lineHeight = 17, fill = false)
                TerminalLine("replaying 256 KB scrollback", color = TerminalMutedStrong, lineHeight = 17, fill = false)
                TerminalLine("restoring 80×24 viewport", color = TerminalMuted, lineHeight = 17, fill = false)
            }
        } else {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text(
                    text = error.body,
                    style = terminalMonoStyle(fontSize = 12, lineHeight = 17),
                    color = TerminalMutedStrong,
                    textAlign = TextAlign.Center,
                )
                TerminalPillButton(label = TERMINAL_ATTACH_RETRY, onClick = onRetry)
            }
        }
    }
}

@Composable
private fun LockedStatus(onUnlock: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        LockGlyph(Modifier.size(48.dp))
        Spacer(Modifier.height(18.dp))
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Text(
                "Session locked",
                style = terminalInterStyle(fontSize = 20, lineHeight = 24, weight = FontWeight(600)),
                color = TerminalFg,
            )
            TerminalLine(
                "keystrokes blocked · backgrounded 5m ago",
                color = TerminalMuted,
                lineHeight = 17,
                fill = false,
            )
        }
        Spacer(Modifier.height(22.dp))
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(ShellyTheme.colors.accent)
                .clickable(onClick = onUnlock)
                .padding(horizontal = 22.dp, vertical = 13.dp),
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Default.Fingerprint,
                contentDescription = null,
                tint = Color.Black,
                modifier = Modifier.size(18.dp),
            )
            Text(
                "Unlock to resume",
                style = terminalInterStyle(fontSize = 16, lineHeight = 20, weight = FontWeight(700)),
                color = Color.Black,
            )
        }
    }
}

@Composable
private fun TerminalPillButton(label: String, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(ShellyTheme.colors.accent)
            .clickable(onClick = onClick)
            .padding(horizontal = 22.dp, vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = terminalInterStyle(fontSize = 16, lineHeight = 20, weight = FontWeight(700)),
            color = Color.Black,
        )
    }
}

@Composable
private fun MockTerminalTranscript(exited: Boolean) {
    Column(Modifier.fillMaxSize()) {
        TerminalLine("~/shelly on  main", color = TerminalFg, lineHeight = 17)
        TerminalLine("❯ cargo test --workspace", color = TerminalFg, lineHeight = 17)
        Spacer(Modifier.height(4.dp))
        TerminalLine("    Finished `test` profile [unoptimized]", color = TerminalMutedBase, lineHeight = 17)
        TerminalLine("     Running unittests src/lib.rs", color = TerminalMutedBase, lineHeight = 17)
        Spacer(Modifier.height(8.dp))
        TerminalLine("running 142 tests", color = TerminalFg, lineHeight = 17)
        TerminalLine("test ipc::tests::handshake_replays ... ok", color = TerminalFg, lineHeight = 17)
        TerminalLine("test ipc::tests::session_create ... ok", color = TerminalFg, lineHeight = 17)
        TerminalLine("test logging::redact_path ... ok", color = TerminalFg, lineHeight = 17)
        TerminalLine("test pairing::token_expires ... ok", color = TerminalFg, lineHeight = 17)
        TerminalLine("test session::subscription_lag ... ok", color = TerminalFg, lineHeight = 17)
        Spacer(Modifier.height(8.dp))
        TerminalLine("test result: ok. 142 passed; 0 failed", color = TerminalGreen, lineHeight = 17)
        Spacer(Modifier.height(12.dp))
        TerminalLine("~/shelly on  main", color = TerminalFg, lineHeight = 17)
        TerminalLine(if (exited) "❯ exit" else "❯ ", color = TerminalFg, lineHeight = 17)
        if (exited) {
            ExitBlock()
        }
    }
}

@Composable
private fun ExitBlock() {
    Column(Modifier.padding(top = 2.dp)) {
        TerminalLine("logout", color = TerminalMuted, lineHeight = 19)
        Spacer(Modifier.height(10.dp))
        TerminalLine("[ process exited · code 0 ]", color = TerminalRed, lineHeight = 19)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ExitActionChip(key = "R", label = "restart", active = true)
            ExitActionChip(key = "D", label = "detach", active = false)
        }
    }
}

@Composable
private fun ExitActionChip(key: String, label: String, active: Boolean) {
    val keyColor = if (active) ShellyTheme.colors.accent else TerminalSoft
    val labelColor = if (active) TerminalFg else TerminalSoftText
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, TerminalBorder, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(4.dp))
                .border(1.dp, keyColor, RoundedCornerShape(4.dp))
                .padding(horizontal = 5.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                key,
                style = terminalMonoStyle(fontSize = 11, lineHeight = 14, weight = FontWeight(700)),
                color = keyColor,
            )
        }
        Text(
            label,
            style = terminalMonoStyle(fontSize = 13, lineHeight = 16, weight = FontWeight(500)),
            color = labelColor,
        )
    }
}

@Composable
private fun ClaudeTuiTranscript() {
    Column(Modifier.fillMaxSize()) {
        Column {
            TerminalLine("~/shelly on main", color = TerminalDim, lineHeight = 19)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TerminalLine("❯", color = ShellyTheme.colors.accent, lineHeight = 19, fill = false)
                TerminalLine("shelly agent", color = TerminalFg, lineHeight = 19, fill = false)
            }
            Spacer(Modifier.height(6.dp))
            TerminalLine("opus-4-8 · session a3f1 · ready", color = TerminalDim, lineHeight = 19)
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TerminalLine("❯", color = ShellyTheme.colors.accent, lineHeight = 19, fill = false)
                TerminalLine("expire pairing tokens after 60s", color = TerminalFg, lineHeight = 19, fill = false)
            }
            Spacer(Modifier.height(14.dp))
        }
        Column {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TerminalLine("●", color = ShellyTheme.colors.accent, lineHeight = 19, fill = false)
                TerminalLine("Read src/pairing/token.rs", color = TerminalFg, lineHeight = 19, fill = false)
            }
            TerminalLine("Tokens never expire today. I’ll gate", color = TerminalMutedStrong, lineHeight = 19)
            TerminalLine("verify() on a 60s TTL.", color = TerminalMutedStrong, lineHeight = 19)
            Spacer(Modifier.height(14.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(TerminalFg)
                        .padding(horizontal = 7.dp, vertical = 1.dp),
                ) {
                    Text(
                        "EDIT",
                        style = terminalMonoStyle(fontSize = 11, lineHeight = 16, letterSpacing = 0.04.em),
                        color = TerminalPlane,
                    )
                }
                TerminalLine("src/pairing/token.rs", color = TerminalEditPath, lineHeight = 19, fill = false)
            }
            Spacer(Modifier.height(28.dp))
        }
        DiffPanel()
        Spacer(Modifier.height(28.dp))
        ApprovalPanel()
    }
}

@Composable
private fun DiffPanel() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(TerminalDiffPanel)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        TerminalLine("  fn verify(t: &Token) -> bool {", color = TerminalCodeMuted, lineHeight = 19, wrap = false)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0x1FE0705E)),
        ) {
            TerminalLine("-     t.sig_ok()", color = TerminalRed, lineHeight = 19, wrap = false)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0x1F6BC48E)),
        ) {
            TerminalLine("+     t.sig_ok() && t.age() < TTL", color = TerminalDiffGreen, lineHeight = 19, wrap = false)
        }
        TerminalLine("  }", color = TerminalCodeMuted, lineHeight = 19, wrap = false)
    }
}

@Composable
private fun ApprovalPanel() {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, TerminalBorder, RoundedCornerShape(8.dp)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .border(width = 0.dp, color = Color.Transparent)
                .padding(horizontal = 12.dp, vertical = 9.dp),
        ) {
            TerminalLine("Apply this change to token.rs?", color = TerminalFg, lineHeight = 18)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(TerminalBorder))
        ChoiceRow(selected = true, label = "1. Yes, apply it")
        ChoiceRow(selected = false, label = "2. No, keep as is")
        ChoiceRow(selected = false, label = "3. Always allow edits")
    }
}

@Composable
private fun ChoiceRow(selected: Boolean, label: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (selected) Color(0x29E85D29) else Color.Transparent)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selected) {
            TerminalLine("❯", color = ShellyTheme.colors.accent, lineHeight = 18, fill = false)
        } else {
            Spacer(Modifier.width(0.dp))
        }
        TerminalLine(
            label,
            color = if (selected) TerminalChoice else TerminalSoftText,
            lineHeight = 18,
            fill = false,
        )
    }
}

@Composable
private fun TerminalLine(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    lineHeight: Int = 17,
    wrap: Boolean = false,
    fill: Boolean = true,
) {
    Text(
        text = text,
        modifier = if (fill) modifier.fillMaxWidth() else modifier,
        style = terminalMonoStyle(fontSize = 12, lineHeight = lineHeight),
        color = color,
        softWrap = wrap,
        maxLines = if (wrap) Int.MAX_VALUE else 1,
    )
}

@Composable
private fun AttachRing(modifier: Modifier = Modifier) {
    val accent = ShellyTheme.colors.accent
    Canvas(modifier) {
        val strokeWidth = size.minDimension * (5f / 60f)
        val radius = size.minDimension * (26f / 60f)
        drawCircle(
            color = accent.copy(alpha = 0.22f),
            radius = radius,
            style = Stroke(width = strokeWidth),
        )
        drawArc(
            color = accent,
            startAngle = -90f,
            sweepAngle = 124f,
            useCenter = false,
            topLeft = Offset(center.x - radius, center.y - radius),
            size = Size(radius * 2, radius * 2),
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
    }
}

@Composable
private fun LockGlyph(modifier: Modifier = Modifier) {
    val accent = ShellyTheme.colors.accent
    Canvas(modifier) {
        val scale = size.minDimension / 24f
        val stroke = Stroke(width = 1.8f * scale, cap = StrokeCap.Round)
        drawRoundRect(
            color = accent,
            topLeft = Offset(4f * scale, 11f * scale),
            size = Size(16f * scale, 10f * scale),
            cornerRadius = CornerRadius(2.5f * scale, 2.5f * scale),
            style = stroke,
        )
        val path = Path().apply {
            moveTo(8f * scale, 11f * scale)
            lineTo(8f * scale, 7f * scale)
            arcTo(
                rect = Rect(8f * scale, 3f * scale, 16f * scale, 11f * scale),
                startAngleDegrees = 180f,
                sweepAngleDegrees = 180f,
                forceMoveTo = false,
            )
            lineTo(16f * scale, 11f * scale)
        }
        drawPath(path, color = accent, style = stroke)
    }
}

@Composable
private fun CloseGlyph(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val stroke = Stroke(width = 2.4.dp.toPx(), cap = StrokeCap.Round)
        drawLine(
            color = Color.White,
            start = Offset(size.width * 0.25f, size.height * 0.25f),
            end = Offset(size.width * 0.75f, size.height * 0.75f),
            strokeWidth = stroke.width,
            cap = stroke.cap,
        )
        drawLine(
            color = Color.White,
            start = Offset(size.width * 0.75f, size.height * 0.25f),
            end = Offset(size.width * 0.25f, size.height * 0.75f),
            strokeWidth = stroke.width,
            cap = stroke.cap,
        )
    }
}

@Composable
private fun ChevronGlyph(up: Boolean, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val y1 = if (up) size.height * 0.62f else size.height * 0.38f
        val y2 = if (up) size.height * 0.38f else size.height * 0.62f
        drawLine(
            color = Color.Black,
            start = Offset(size.width * 0.22f, y1),
            end = Offset(size.width * 0.5f, y2),
            strokeWidth = 2.5.dp.toPx(),
            cap = StrokeCap.Round,
        )
        drawLine(
            color = Color.Black,
            start = Offset(size.width * 0.5f, y2),
            end = Offset(size.width * 0.78f, y1),
            strokeWidth = 2.5.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}

private fun terminalHeaderStatus(session: MobileSession, state: TerminalUiState): String {
    terminalHeaderStatusForError(state.status)?.let { return it }
    return when {
        state.exitedCode != null -> "EXITED"
        state.status == "Locked" -> "LOCKED"
        state.status.startsWith("Reconnecting") || state.status.startsWith("Resyncing") -> "ATTACHING"
        state.agentState == AgentState.Working && (session.model != null || session.name.contains("claude", ignoreCase = true)) -> "THINKING"
        else -> "ATTACHED"
    }
}

private enum class TerminalKeyAction {
    SendBytes,
    ToggleCtrl,
    ToggleAlt,
}

private enum class TerminalKeyVisual {
    Text,
    Up,
    Down,
}

private data class TerminalKeySpec(
    val label: String,
    val contentDescription: String,
    val action: TerminalKeyAction,
    val bytes: ByteArray = byteArrayOf(),
    val visual: TerminalKeyVisual = TerminalKeyVisual.Text,
    val fixedSquare: Boolean = false,
) {
    override fun equals(other: Any?): Boolean {
        return other is TerminalKeySpec &&
            label == other.label &&
            contentDescription == other.contentDescription &&
            action == other.action &&
            bytes.contentEquals(other.bytes) &&
            visual == other.visual &&
            fixedSquare == other.fixedSquare
    }

    override fun hashCode(): Int {
        var result = label.hashCode()
        result = 31 * result + contentDescription.hashCode()
        result = 31 * result + action.hashCode()
        result = 31 * result + bytes.contentHashCode()
        result = 31 * result + visual.hashCode()
        result = 31 * result + fixedSquare.hashCode()
        return result
    }
}

private fun terminalKeySpecs(): List<TerminalKeySpec> = listOf(
    TerminalKeySpec("Esc", "Send escape", TerminalKeyAction.SendBytes, byteArrayOf(0x1b)),
    TerminalKeySpec("Ctrl", "Toggle control modifier", TerminalKeyAction.ToggleCtrl),
    TerminalKeySpec("Alt", "Toggle alt modifier", TerminalKeyAction.ToggleAlt),
    TerminalKeySpec("Tab", "Send tab", TerminalKeyAction.SendBytes, byteArrayOf(0x09)),
    TerminalKeySpec("|", "Send pipe", TerminalKeyAction.SendBytes, "|".encodeToByteArray(), fixedSquare = true),
    TerminalKeySpec(
        label = "Up",
        contentDescription = "Send arrow up",
        action = TerminalKeyAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x41),
        visual = TerminalKeyVisual.Up,
        fixedSquare = true,
    ),
    TerminalKeySpec(
        label = "Down",
        contentDescription = "Send arrow down",
        action = TerminalKeyAction.SendBytes,
        bytes = byteArrayOf(0x1b, 0x5b, 0x42),
        visual = TerminalKeyVisual.Down,
        fixedSquare = true,
    ),
)

private fun terminalMonoStyle(
    fontSize: Int,
    lineHeight: Int,
    weight: FontWeight = FontWeight(400),
    letterSpacing: TextUnit = TextUnit.Unspecified,
): TextStyle = ShellyType.mono.copy(
    fontSize = fontSize.sp,
    lineHeight = lineHeight.sp,
    fontWeight = weight,
    letterSpacing = letterSpacing,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private fun terminalInterStyle(
    fontSize: Int,
    lineHeight: Int,
    weight: FontWeight,
): TextStyle = ShellyType.heading.copy(
    fontSize = fontSize.sp,
    lineHeight = lineHeight.sp,
    fontWeight = weight,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private val TerminalPlane = Color(0xFF0B0D0C)
private val TerminalFg = Color(0xFFE8EAE5)
private val TerminalMutedBase = Color(0xFF7A8079)
private val TerminalMuted = Color(0xFF7C857F)
private val TerminalMutedStrong = Color(0xFFB8BEB9)
private val TerminalDim = Color(0xFF5E6B66)
private val TerminalGreen = Color(0xFF5BB390)
private val TerminalDiffGreen = Color(0xFF6BC48E)
private val TerminalRed = Color(0xFFE0705E)
private val TerminalDiffPanel = Color(0xFF11150F)
private val TerminalBorder = Color(0xFF2C322D)
private val TerminalSoft = Color(0xFF4A524C)
private val TerminalSoftText = Color(0xFF9AA29B)
private val TerminalEditPath = Color(0xFF8A9A8F)
private val TerminalCodeMuted = Color(0xFF6E756F)
private val TerminalChoice = Color(0xFFF2A07E)
