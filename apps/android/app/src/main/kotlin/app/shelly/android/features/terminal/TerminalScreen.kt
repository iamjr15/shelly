@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package app.shelly.android.features.terminal

import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.core.AgentState
import app.shelly.android.core.AndroidBiometricGate
import app.shelly.android.core.MobileSession
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.core.TerminalController
import app.shelly.android.core.TerminalErrorKind
import app.shelly.android.core.TerminalPhase
import app.shelly.android.core.TerminalAttachErrorMessage
import app.shelly.android.core.TerminalUiState
import app.shelly.android.core.terminalAttachErrorMessage
import app.shelly.android.R
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyTerminalPalette
import app.shelly.android.ui.theme.ShellyType
import androidx.core.content.res.ResourcesCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.connectbot.terminal.DelKeyMode
import org.connectbot.terminal.Terminal

@Composable
fun TerminalScreen(
    sessions: List<MobileSession>,
    tabs: List<MobileSession>,
    activeSessionId: String,
    viewModel: ShellyViewModel,
    biometricGate: AndroidBiometricGate,
    onSelectTab: (MobileSession) -> Unit,
    onCloseTab: (String) -> Unit,
    onNewSession: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val activity = context as? Activity
    val clipboard = remember(context) { context.getSystemService(ClipboardManager::class.java) }
    val view = LocalView.current
    val restoreLightStatusBars = !ShellyTheme.colors.isDark
    val selectionBackgroundColor = ShellyTheme.colors.accent.copy(alpha = 0.35f)
    val terminalTypeface = remember(context) {
        ResourcesCompat.getFont(context, R.font.jetbrains_mono_variable) ?: Typeface.MONOSPACE
    }
    val haptics = LocalHapticFeedback.current
    val controllers = remember { mutableStateMapOf<String, TerminalController>() }
    val attachErrors = remember { mutableStateMapOf<String, TerminalAttachErrorMessage>() }
    val attachAttempts = remember { mutableStateMapOf<String, Int>() }
    var sessionPickerVisible by remember { mutableStateOf(false) }
    var keyboardRequest by remember { mutableStateOf(0) }
    var showSoftKeyboard by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    DisposableEffect(activity, view, restoreLightStatusBars) {
        val insetsController = activity?.let { WindowCompat.getInsetsController(it.window, view) }
        insetsController?.isAppearanceLightStatusBars = false
        onDispose {
            insetsController?.isAppearanceLightStatusBars = restoreLightStatusBars
        }
    }

    tabs.forEach { session ->
        key(session.id) {
            val attachAttempt = attachAttempts[session.id] ?: 0
            LaunchedEffect(session.id, attachAttempt) {
                if (controllers.containsKey(session.id)) {
                    return@LaunchedEffect
                }
                attachErrors.remove(session.id)
                try {
                    controllers[session.id] = viewModel.createTerminalController(session) {
                        biometricGate.unlock("Send terminal input")
                    }
                } catch (error: Throwable) {
                    if (error is CancellationException) {
                        throw error
                    }
                    Log.e("ShellyTerminal", "Terminal attach failed for session ${session.id}", error)
                    attachErrors[session.id] = terminalAttachErrorMessage(error)
                }
            }
        }
    }

    val tabIds = tabs.map(MobileSession::id)
    LaunchedEffect(tabIds) {
        val removedIds = controllers.keys.toSet() - tabIds.toSet()
        removedIds.forEach { sessionId ->
            controllers.remove(sessionId)?.detach()
            attachErrors.remove(sessionId)
            attachAttempts.remove(sessionId)
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            controllers.values.toList().forEach(TerminalController::detach)
            controllers.clear()
        }
    }

    val activeSession = tabs.firstOrNull { it.id == activeSessionId } ?: tabs.firstOrNull()
    val currentController = activeSession?.let { controllers[it.id] }
    val terminalState = currentController?.state?.collectAsStateWithLifecycle()?.value

    LaunchedEffect(currentController) {
        currentController?.emulator?.setDefaultColors(
            foreground = TerminalFg.toArgb(),
            background = TerminalShellSurface.toArgb(),
        )
    }

    BackHandler(onBack = onBack)

    val locked = terminalState?.phase is TerminalPhase.Locked
    val keyboardEnabled = currentController != null && !locked && terminalState?.exitedCode == null

    LaunchedEffect(
        activeSessionId,
        currentController,
        sessionPickerVisible,
        keyboardEnabled,
        keyboardRequest,
    ) {
        showSoftKeyboard = false
        if (keyboardEnabled && !sessionPickerVisible) {
            // Drive termlib's native ImeInputView after AndroidView is attached. Its
            // showSoftKeyboard contract calls requestFocus + InputMethodManager on the
            // actual text editor, unlike Compose's best-effort keyboard controller.
            delay(160)
            showSoftKeyboard = true
        }
    }

    TerminalScaffold(
        topBar = {
            TerminalTabBar(
                tabs = tabs,
                activeSessionId = activeSession?.id,
                controllers = controllers,
                attachErrors = attachErrors,
                onBack = onBack,
                onSelectTab = onSelectTab,
                onCloseTab = onCloseTab,
                onAddTab = { sessionPickerVisible = true },
            )
        },
        accessoryDimmed = locked,
        accessoryEnabled = keyboardEnabled,
        ctrlActive = currentController?.modifierManager?.ctrl == true,
        altActive = currentController?.modifierManager?.alt == true,
        onAccessory = { spec ->
            currentController?.let { controller ->
                when (spec.action) {
                    TerminalKeyAction.SendBytes -> controller.sendAccessory(spec.bytes)
                    TerminalKeyAction.ToggleCtrl -> {
                        controller.modifierManager.toggleCtrl()
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }
                    TerminalKeyAction.ToggleAlt -> {
                        controller.modifierManager.toggleAlt()
                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }
                }
            }
        },
    ) {
        when {
            activeSession == null -> Unit
            currentController == null -> AttachStatus(
                sessionName = activeSession.name,
                error = attachErrors[activeSession.id],
                onRetry = {
                    attachAttempts[activeSession.id] = (attachAttempts[activeSession.id] ?: 0) + 1
                },
            )
            locked -> {
                LockedStatus(
                    onUnlock = {
                        scope.launch {
                            if (biometricGate.unlock("Send terminal input")) {
                                currentController.resumeAfterUnlock()
                                keyboardRequest += 1
                            }
                        }
                    },
                )
            }
            // TODO(M-26): termlib 0.1.0 owns zoomScale inside Terminal and exposes neither an
            // initial value nor an onZoomScaleChange callback. Hoist it above this keyed subtree
            // when termlib makes that state controllable so zoom survives tab switches.
            else -> key(activeSession.id) {
                Terminal(
                    terminalEmulator = currentController.emulator,
                    modifier = Modifier.fillMaxSize(),
                    backgroundColor = TerminalShellSurface,
                    foregroundColor = TerminalFg,
                    selectionBackgroundColor = selectionBackgroundColor,
                    typeface = terminalTypeface,
                    keyboardEnabled = keyboardEnabled,
                    showSoftKeyboard = showSoftKeyboard,
                    onPasteRequest = {
                        clipboard.primaryClip
                            ?.takeIf { it.itemCount > 0 }
                            ?.getItemAt(0)
                            ?.coerceToText(context)
                            ?.toString()
                            ?.takeIf { it.isNotEmpty() }
                            ?.let { currentController.sendAccessory(it.encodeToByteArray()) }
                    },
                    onHyperlinkClick = { url -> openTerminalUrl(context, url) },
                    modifierManager = currentController.modifierManager,
                    delKeyMode = DelKeyMode.Delete,
                )
            }
        }
    }

    if (sessionPickerVisible) {
        TerminalSessionPicker(
            sessions = sessions,
            openSessionIds = tabIds.toSet(),
            onDismiss = { sessionPickerVisible = false },
            onSelect = { session ->
                sessionPickerVisible = false
                onSelectTab(session)
            },
            onNewSession = {
                sessionPickerVisible = false
                onNewSession()
            },
        )
    }
}

@Composable
internal fun TerminalScaffold(
    topBar: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    accessoryDimmed: Boolean = false,
    accessoryEnabled: Boolean = true,
    ctrlActive: Boolean = false,
    altActive: Boolean = false,
    onAccessory: (TerminalKeySpec) -> Unit,
    body: @Composable BoxScope.() -> Unit,
) {
    val accent = ShellyTheme.colors.accent
    val density = LocalDensity.current
    val imeInsets = WindowInsets.ime
    val imeVisible by remember(imeInsets, density) {
        derivedStateOf { imeInsets.getBottom(density) > 0 }
    }
    Column(
        modifier = modifier
            .fillMaxSize()
            .background(TerminalPlane)
            .imePadding(),
    ) {
        topBar()
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(TerminalPlane)
                .padding(horizontal = 6.dp, vertical = 5.dp),
            content = body,
        )
        Box(
            modifier = Modifier.then(if (imeVisible) Modifier else Modifier.navigationBarsPadding()),
        ) {
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
}

@Composable
internal fun TerminalTabBar(
    tabs: List<MobileSession>,
    activeSessionId: String?,
    controllers: Map<String, TerminalController>,
    attachErrors: Map<String, TerminalAttachErrorMessage>,
    onBack: () -> Unit,
    onSelectTab: (MobileSession) -> Unit,
    onCloseTab: (String) -> Unit,
    onAddTab: () -> Unit,
) {
    val listState = rememberLazyListState()
    val selectedIndex = tabs.indexOfFirst { it.id == activeSessionId }
    val motionEnabled = ShellyTheme.motionEnabled
    LaunchedEffect(selectedIndex, tabs.map(MobileSession::id)) {
        if (selectedIndex >= 0) {
            if (motionEnabled) {
                listState.animateScrollToItem(selectedIndex)
            } else {
                listState.scrollToItem(selectedIndex)
            }
        }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(TerminalToolbar)
            .statusBarsPadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(55.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TerminalBarAction(
                contentDescription = "Back to sessions",
                onClick = onBack,
            ) {
                BackGlyph(Modifier.size(17.dp))
            }
            LazyRow(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxHeight(),
                contentPadding = PaddingValues(horizontal = 4.dp, vertical = 3.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                items(
                    items = tabs,
                    key = MobileSession::id,
                ) { session ->
                    TerminalSessionTab(
                        session = session,
                        selected = session.id == activeSessionId,
                        width = when (tabs.size) {
                            1 -> 172.dp
                            2 -> if (session.id == activeSessionId) 152.dp else 100.dp
                            else -> 128.dp
                        },
                        controller = controllers[session.id],
                        attachFailed = attachErrors.containsKey(session.id),
                        onSelect = { onSelectTab(session) },
                        onClose = { onCloseTab(session.id) },
                    )
                }
            }
            TerminalBarAction(
                contentDescription = "Open another session",
                onClick = onAddTab,
            ) {
                PlusGlyph(Modifier.size(17.dp))
            }
        }
    }
}

@Composable
private fun TerminalSessionTab(
    session: MobileSession,
    selected: Boolean,
    width: Dp,
    controller: TerminalController?,
    attachFailed: Boolean,
    onSelect: () -> Unit,
    onClose: () -> Unit,
) {
    val state = controller?.state?.collectAsStateWithLifecycle()?.value
    val status = terminalTabStatus(state = state, attachFailed = attachFailed)
    val shape = RoundedCornerShape(11.dp)
    Box(
        modifier = Modifier
            .height(48.dp)
            .width(width)
            .clickable(role = Role.Tab, onClick = onSelect)
            .semantics {
                this.selected = selected
                contentDescription = "${session.name}, ${status.label}"
            },
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(42.dp)
                .clip(shape)
                .background(if (selected) TerminalTabSelected else TerminalTabInactive)
                .padding(start = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .clip(RoundedCornerShape(50))
                    .background(status.color),
            )
            Spacer(Modifier.width(8.dp))
            Text(
                text = session.name.lowercase(),
                style = terminalMonoStyle(
                    fontSize = 12,
                    lineHeight = 16,
                    weight = if (selected) FontWeight(650) else FontWeight(500),
                ),
                color = if (selected) TerminalTabSelectedText else TerminalDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (selected) {
                Spacer(Modifier.width(48.dp))
            } else {
                Spacer(Modifier.width(9.dp))
            }
        }
        if (selected) {
            Box(
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .size(48.dp)
                    .clickable(role = Role.Button, onClick = onClose)
                    .semantics { contentDescription = "Close ${session.name} tab" },
                contentAlignment = Alignment.Center,
            ) {
                CloseGlyph(Modifier.size(13.dp))
            }
        }
    }
}

@Composable
private fun TerminalBarAction(
    contentDescription: String,
    onClick: () -> Unit,
    size: Dp = 52.dp,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(
        modifier = Modifier
            .size(size)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(11.dp))
                .background(TerminalTabInactive),
            contentAlignment = Alignment.Center,
            content = content,
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
    var expanded by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (dimmed) 0.4f else 1f)
            .background(TerminalToolbar),
    ) {
        if (expanded) {
            TerminalKeyStrip(
                specs = terminalOverflowKeySpecs(),
                enabled = enabled,
                accent = accent,
                ctrlActive = ctrlActive,
                altActive = altActive,
                onAccessory = onAccessory,
                modifier = Modifier.border(1.dp, TerminalBorder),
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .border(1.dp, TerminalBorder),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TerminalKeyStrip(
                specs = terminalKeySpecs(),
                enabled = enabled,
                accent = accent,
                ctrlActive = ctrlActive,
                altActive = altActive,
                onAccessory = onAccessory,
                modifier = Modifier.weight(1f),
            )
            Box(
                modifier = Modifier
                    .width(1.dp)
                    .height(30.dp)
                    .background(TerminalBorder),
            )
            TerminalMoreButton(
                expanded = expanded,
                enabled = enabled,
                accent = accent,
                onClick = { expanded = !expanded },
            )
        }
    }
}

@Composable
private fun TerminalKeyStrip(
    specs: List<TerminalKeySpec>,
    enabled: Boolean,
    accent: Color,
    ctrlActive: Boolean,
    altActive: Boolean,
    onAccessory: (TerminalKeySpec) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .height(48.dp)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        specs.forEach { spec ->
            if (spec.separatorBefore) {
                Spacer(Modifier.width(5.dp))
                Box(Modifier.width(1.dp).height(28.dp).background(TerminalBorder))
                Spacer(Modifier.width(5.dp))
            }
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
private fun TerminalMoreButton(
    expanded: Boolean,
    enabled: Boolean,
    accent: Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(width = 52.dp, height = 48.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = if (expanded) "Hide terminal keys" else "More terminal keys" },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .width(44.dp)
                .height(36.dp)
                .clip(RoundedCornerShape(7.dp))
                .background(if (expanded) accent else TerminalKeySurface),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = "•••",
                style = terminalMonoStyle(fontSize = 13, lineHeight = 16, weight = FontWeight(700)),
                color = if (expanded) Color.Black else TerminalFg,
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
    val shape = RoundedCornerShape(7.dp)
    val keyWidth = when {
        spec.fixedSquare -> 48.dp
        '\n' in spec.label || spec.label.length >= 5 -> 62.dp
        else -> 52.dp
    }
    Box(
        modifier = Modifier
            .size(width = keyWidth, height = 48.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics {
                contentDescription = spec.contentDescription
                role = Role.Button
                this.selected = selected
            }
            .padding(horizontal = 2.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .size(width = keyWidth - 4.dp, height = 36.dp)
                .clip(shape)
                .background(if (selected) accent else TerminalKeySurface),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = spec.label,
                style = terminalMonoStyle(
                    fontSize = if (spec.label.length == 1) 15 else 12,
                    lineHeight = 14,
                    weight = if (spec.label.length == 1) FontWeight(500) else FontWeight(700),
                ),
                color = if (selected) Color.Black else TerminalFg,
                maxLines = 2,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TerminalSessionPicker(
    sessions: List<MobileSession>,
    openSessionIds: Set<String>,
    onDismiss: () -> Unit,
    onSelect: (MobileSession) -> Unit,
    onNewSession: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = TerminalToolbar,
        contentColor = TerminalFg,
        scrimColor = Color.Black.copy(alpha = 0.62f),
        dragHandle = {
            Box(
                Modifier
                    .padding(top = 10.dp, bottom = 8.dp)
                    .width(32.dp)
                    .height(3.dp)
                    .clip(RoundedCornerShape(50))
                    .background(TerminalSoft),
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = 18.dp),
        ) {
            Text(
                text = "open a terminal",
                style = terminalInterStyle(fontSize = 20, lineHeight = 24, weight = FontWeight(650)),
                color = TerminalFg,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
            TerminalPickerAction(
                title = "new shell",
                detail = "start a clean terminal session",
                contentDescription = "Start a new shell session",
                onClick = onNewSession,
                leading = { PlusGlyph(Modifier.size(16.dp)) },
            )
            HorizontalDivider(color = TerminalBorder, modifier = Modifier.padding(horizontal = 20.dp))
            if (sessions.isEmpty()) {
                Text(
                    text = "no existing sessions",
                    style = terminalMonoStyle(fontSize = 12, lineHeight = 16),
                    color = TerminalMuted,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 22.dp),
                )
            } else {
                Column(
                    modifier = Modifier
                        .heightIn(max = 430.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    sessions.forEach { session ->
                        TerminalPickerAction(
                            title = session.name.lowercase(),
                            detail = terminalPickerDetail(session),
                            trailing = if (session.id in openSessionIds) "open" else null,
                            contentDescription = if (session.id in openSessionIds) {
                                "Switch to ${session.name}"
                            } else {
                                "Open ${session.name}"
                            },
                            onClick = { onSelect(session) },
                            leading = {
                                Box(
                                    Modifier
                                        .size(7.dp)
                                        .clip(RoundedCornerShape(50))
                                        .background(agentStatusColor(session.state)),
                                )
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun TerminalPickerAction(
    title: String,
    detail: String,
    contentDescription: String,
    onClick: () -> Unit,
    leading: @Composable () -> Unit,
    trailing: String? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 62.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { this.contentDescription = contentDescription }
            .padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.width(28.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            leading()
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = terminalMonoStyle(fontSize = 14, lineHeight = 18, weight = FontWeight(650)),
                color = TerminalFg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text = detail,
                style = terminalMonoStyle(fontSize = 11, lineHeight = 14),
                color = TerminalMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        trailing?.let {
            Text(
                text = it,
                style = terminalMonoStyle(fontSize = 10, lineHeight = 13, weight = FontWeight(700)),
                color = ShellyTheme.colors.accent,
                modifier = Modifier.padding(start = 12.dp),
            )
        }
    }
}

private data class TerminalTabStatus(
    val label: String,
    val color: Color,
)

@Composable
private fun terminalTabStatus(state: TerminalUiState?, attachFailed: Boolean): TerminalTabStatus {
    if (attachFailed) {
        return TerminalTabStatus("attach failed", TerminalRed)
    }
    if (state == null) {
        return TerminalTabStatus("attaching", TerminalMuted)
    }
    return when (val phase = state.phase) {
        TerminalPhase.Attached -> when (state.agentState) {
            AgentState.AwaitingInput -> TerminalTabStatus("awaiting input", ShellyTheme.colors.accent)
            AgentState.Crashed -> TerminalTabStatus("crashed", TerminalRed)
            AgentState.Working -> TerminalTabStatus("working", TerminalGreen)
            AgentState.Idle -> TerminalTabStatus("attached", TerminalGreen)
        }
        TerminalPhase.Locked -> TerminalTabStatus("locked", ShellyTheme.colors.accent)
        is TerminalPhase.Reconnecting,
        is TerminalPhase.Resyncing -> TerminalTabStatus("reconnecting", TerminalMutedStrong)
        is TerminalPhase.Exited -> TerminalTabStatus("exited", TerminalDim)
        is TerminalPhase.Error -> TerminalTabStatus(
            label = when (phase.kind) {
                TerminalErrorKind.ConnectionLost -> "offline"
                TerminalErrorKind.Denied -> "denied"
                TerminalErrorKind.SessionEnded -> "ended"
                TerminalErrorKind.Unpaired -> "unpaired"
            },
            color = TerminalRed,
        )
    }
}

@Composable
private fun agentStatusColor(state: AgentState): Color = when (state) {
    AgentState.AwaitingInput -> ShellyTheme.colors.accent
    AgentState.Crashed -> TerminalRed
    AgentState.Working -> TerminalGreen
    AgentState.Idle -> TerminalDim
}

private fun terminalPickerDetail(session: MobileSession): String = when {
    session.model?.isNotBlank() == true -> session.model
    session.command.isNotEmpty() -> session.command.joinToString(" ")
    else -> "shell session"
}

@Composable
internal fun AttachStatus(
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
            TerminalLine("opening terminal stream", color = TerminalMuted, lineHeight = 17, fill = false)
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
internal fun LockedStatus(onUnlock: () -> Unit) {
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
                "keystrokes blocked",
                color = TerminalMuted,
                lineHeight = 17,
                fill = false,
            )
        }
        Spacer(Modifier.height(22.dp))
        Row(
            modifier = Modifier
                .heightIn(min = 48.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(ShellyTheme.colors.accent)
                .clickable(role = Role.Button, onClick = onUnlock)
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
            .heightIn(min = 48.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(ShellyTheme.colors.accent)
            .clickable(role = Role.Button, onClick = onClick)
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
private fun BackGlyph(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val color = TerminalMutedStrong
        drawLine(
            color = color,
            start = Offset(size.width * 0.68f, size.height * 0.18f),
            end = Offset(size.width * 0.32f, size.height * 0.5f),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.32f, size.height * 0.5f),
            end = Offset(size.width * 0.68f, size.height * 0.82f),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun PlusGlyph(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val color = TerminalMutedStrong
        drawLine(
            color = color,
            start = Offset(size.width * 0.5f, size.height * 0.18f),
            end = Offset(size.width * 0.5f, size.height * 0.82f),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.18f, size.height * 0.5f),
            end = Offset(size.width * 0.82f, size.height * 0.5f),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun CloseGlyph(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val color = TerminalTabSelectedText
        val strokeWidth = 1.8.dp.toPx()
        drawLine(
            color = color,
            start = Offset(size.width * 0.22f, size.height * 0.22f),
            end = Offset(size.width * 0.78f, size.height * 0.78f),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(size.width * 0.78f, size.height * 0.22f),
            end = Offset(size.width * 0.22f, size.height * 0.78f),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round,
        )
    }
}

internal enum class TerminalKeyAction {
    SendBytes,
    ToggleCtrl,
    ToggleAlt,
}

@Immutable
internal data class TerminalKeySpec(
    val label: String,
    val contentDescription: String,
    val action: TerminalKeyAction,
    val bytes: ByteArray = byteArrayOf(),
    val fixedSquare: Boolean = false,
    val separatorBefore: Boolean = false,
) {
    override fun equals(other: Any?): Boolean {
        return other is TerminalKeySpec &&
            label == other.label &&
            contentDescription == other.contentDescription &&
            action == other.action &&
            bytes.contentEquals(other.bytes) &&
            fixedSquare == other.fixedSquare &&
            separatorBefore == other.separatorBefore
    }

    override fun hashCode(): Int {
        var result = label.hashCode()
        result = 31 * result + contentDescription.hashCode()
        result = 31 * result + action.hashCode()
        result = 31 * result + bytes.contentHashCode()
        result = 31 * result + fixedSquare.hashCode()
        result = 31 * result + separatorBefore.hashCode()
        return result
    }
}

private val TerminalKeySpecs = listOf(
    TerminalKeySpec("esc", "Send escape", TerminalKeyAction.SendBytes, byteArrayOf(0x1b)),
    TerminalKeySpec("ctrl", "Toggle control modifier", TerminalKeyAction.ToggleCtrl),
    TerminalKeySpec("tab", "Send tab", TerminalKeyAction.SendBytes, byteArrayOf(0x09)),
    TerminalKeySpec("shift\ntab", "Send shift tab", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x5a)),
    TerminalKeySpec("←", "Send arrow left", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x44), fixedSquare = true, separatorBefore = true),
    TerminalKeySpec("↑", "Send arrow up", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x41), fixedSquare = true),
    TerminalKeySpec("↓", "Send arrow down", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x42), fixedSquare = true),
    TerminalKeySpec("→", "Send arrow right", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x43), fixedSquare = true),
    TerminalKeySpec("[", "Send left bracket", TerminalKeyAction.SendBytes, "[".encodeToByteArray(), fixedSquare = true, separatorBefore = true),
    TerminalKeySpec("]", "Send right bracket", TerminalKeyAction.SendBytes, "]".encodeToByteArray(), fixedSquare = true),
    TerminalKeySpec("{", "Send left brace", TerminalKeyAction.SendBytes, "{".encodeToByteArray(), fixedSquare = true),
    TerminalKeySpec("}", "Send right brace", TerminalKeyAction.SendBytes, "}".encodeToByteArray(), fixedSquare = true),
    TerminalKeySpec("|", "Send pipe", TerminalKeyAction.SendBytes, "|".encodeToByteArray(), fixedSquare = true),
    TerminalKeySpec("/", "Send slash", TerminalKeyAction.SendBytes, "/".encodeToByteArray(), fixedSquare = true),
    TerminalKeySpec("~", "Send tilde", TerminalKeyAction.SendBytes, "~".encodeToByteArray(), fixedSquare = true),
    TerminalKeySpec("-", "Send dash", TerminalKeyAction.SendBytes, "-".encodeToByteArray(), fixedSquare = true),
)

private val TerminalOverflowKeySpecs = listOf(
    TerminalKeySpec("alt", "Toggle alt modifier", TerminalKeyAction.ToggleAlt),
    TerminalKeySpec("home", "Send home", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x48)),
    TerminalKeySpec("end", "Send end", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x46)),
    TerminalKeySpec("pg up", "Send page up", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x35, 0x7e)),
    TerminalKeySpec("pg dn", "Send page down", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x36, 0x7e)),
    TerminalKeySpec("del", "Send delete", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x33, 0x7e)),
    TerminalKeySpec("ins", "Send insert", TerminalKeyAction.SendBytes, byteArrayOf(0x1b, 0x5b, 0x32, 0x7e)),
    TerminalKeySpec("^C", "Send control C", TerminalKeyAction.SendBytes, byteArrayOf(0x03), separatorBefore = true),
    TerminalKeySpec("^L", "Send control L", TerminalKeyAction.SendBytes, byteArrayOf(0x0c)),
    TerminalKeySpec("^R", "Send control R", TerminalKeyAction.SendBytes, byteArrayOf(0x12)),
    TerminalKeySpec("^Z", "Send control Z", TerminalKeyAction.SendBytes, byteArrayOf(0x1a)),
)

internal fun terminalKeySpecs(): List<TerminalKeySpec> = TerminalKeySpecs

internal fun terminalOverflowKeySpecs(): List<TerminalKeySpec> = TerminalOverflowKeySpecs

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

private val TerminalShellSurface = ShellyTerminalPalette.shellSurface
private val TerminalPlane = ShellyTerminalPalette.shellSurface
private val TerminalToolbar = ShellyTerminalPalette.toolbar
private val TerminalTabSelected = ShellyTerminalPalette.tabSelected
private val TerminalTabSelectedText = ShellyTerminalPalette.tabSelectedText
private val TerminalTabInactive = ShellyTerminalPalette.tabInactive
private val TerminalKeySurface = ShellyTerminalPalette.keySurface
private val TerminalFg = ShellyTerminalPalette.foreground
private val TerminalMutedBase = ShellyTerminalPalette.mutedBase
private val TerminalMuted = ShellyTerminalPalette.muted
private val TerminalMutedStrong = ShellyTerminalPalette.mutedStrong
private val TerminalDim = ShellyTerminalPalette.dim
private val TerminalGreen = ShellyTerminalPalette.success
private val TerminalDiffGreen = ShellyTerminalPalette.success
private val TerminalRed = ShellyTerminalPalette.error
private val TerminalDiffPanel = ShellyTerminalPalette.diffPanel
private val TerminalBorder = ShellyTerminalPalette.border
private val TerminalSoft = ShellyTerminalPalette.soft
private val TerminalSoftText = ShellyTerminalPalette.softText
private val TerminalEditPath = ShellyTerminalPalette.editPath
private val TerminalCodeMuted = ShellyTerminalPalette.codeMuted
private val TerminalChoice = ShellyTerminalPalette.choice

private fun openTerminalUrl(context: android.content.Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }.onFailure { error ->
        Log.w("ShellyTerminal", "Could not open terminal hyperlink", error)
    }
}
