package app.shelly.android.features.sessions

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.draw.drawBehind
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DarkMode
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.LightMode
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.shelly.android.core.AgentState
import app.shelly.android.core.AndroidBiometricGate
import app.shelly.android.core.ConnectionState
import app.shelly.android.core.MobileSession
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.core.displayName
import app.shelly.android.core.sessionOrderComparator
import app.shelly.android.ui.components.BrandRow
import app.shelly.android.ui.components.DoubleChevron
import app.shelly.android.ui.components.HeroBody
import app.shelly.android.ui.components.HeroEscapeButton
import app.shelly.android.ui.components.IconCircleButton
import app.shelly.android.ui.components.StatusDot
import app.shelly.android.ui.components.SessionRow
import app.shelly.android.ui.components.ShellyScreen
import app.shelly.android.ui.components.SessionStateTab
import app.shelly.android.ui.components.wordmarkFootprint
import app.shelly.android.ui.theme.ShellyMotion
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType
import app.shelly.android.ui.theme.shellyPressScale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.sin

private val FilteredSessionsHeroHeight = 344.dp

@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun SessionsScreen(
    viewModel: ShellyViewModel,
    biometricGate: AndroidBiometricGate,
    onOpenSession: (MobileSession) -> Unit,
    onOpenSettings: () -> Unit = {},
    onToggleTheme: () -> Unit = {},
    onOpenCommandPalette: () -> Unit = {},
    searchRequestToken: Int = 0,
) {
    val state by viewModel.state.collectAsState()
    val laptopName = state.pairedDaemon.displayName()
    val c = ShellyTheme.colors
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val searchFocus = remember { FocusRequester() }

    var searchActive by remember { mutableStateOf(false) }
    var search by remember { mutableStateOf(TextFieldValue("")) }
    var stateFilter by remember { mutableStateOf<AgentState?>(null) }
    var menuSession by remember { mutableStateOf<MobileSession?>(null) }
    var killPending by remember { mutableStateOf<MobileSession?>(null) }

    val closeSearch = { search = TextFieldValue(""); searchActive = false }
    BackHandler(enabled = searchActive, onBack = closeSearch)
    LaunchedEffect(searchRequestToken) {
        if (searchRequestToken > 0) {
            searchActive = true
        }
    }
    LaunchedEffect(searchActive) {
        if (searchActive) { searchFocus.requestFocus(); keyboard?.show() }
    }
    LaunchedEffect(state.targetSession?.id) {
        val target = state.targetSession ?: return@LaunchedEffect
        val unlocked = biometricGate.unlock("Open terminal session")
        viewModel.consumeTargetSession()
        if (unlocked) onOpenSession(target)
    }

    val all = state.sessions
    val counts = AgentState.values().associateWith { st -> all.count { it.state == st } }
    val visible = run {
        val byState = if (stateFilter == null) all else all.filter { it.state == stateFilter }
        if (searchActive) filterSessions(byState, search.text) else byState
    }
    val ordered = visible.sortedWith(sessionOrderComparator)
    val openSession: (MobileSession) -> Unit = { session ->
        scope.launch { if (biometricGate.unlock("Open terminal session")) onOpenSession(session) }
    }

    Box(Modifier.fillMaxSize()) {
        Crossfade(
            targetState = searchActive,
            animationSpec = ShellyMotion.standardTween(),
            label = "sessionsSearchCrossfade",
        ) { searching ->
            if (searching) {
                SessionsSearchScaffold(
                    query = search,
                    focusRequester = searchFocus,
                    matches = ordered,
                    totalSessions = all.size,
                    totalDevices = if (state.pairedDaemon != null) 1 else 0,
                    onQueryChange = { search = it },
                    onClose = closeSearch,
                    onRefresh = viewModel::refreshSessions,
                    onOpen = openSession,
                    onActions = { menuSession = it },
                )
            } else if (all.isEmpty() && !state.loading) {
                SessionsEmptyScaffold(
                    laptopName = laptopName,
                    onRefresh = viewModel::refreshSessions,
                    onToggleTheme = onToggleTheme,
                    onOpenCommandPalette = onOpenCommandPalette,
                    onSearch = { searchActive = true },
                )
            } else {
                ShellyScreen(
                    heroHeight = FilteredSessionsHeroHeight,
                    hero = {
                        HeroBody(
                            eyebrow = sessionsEyebrow(all.size, laptopName),
                            wordmark = "SES",
                            wordmarkSize = 132.sp,
                            brandTrailing = {
                                Row {
                                    CommandMenuButton(onOpenCommandPalette)
                                    HeroActionButton(Icons.Default.Search, "Search", onClick = { searchActive = true })
                                    RefreshCircleButton(viewModel::refreshSessions, touchTargetSize = 48.dp)
                                    IconCircleButton(
                                        if (c.isDark) Icons.Default.LightMode else Icons.Default.DarkMode,
                                        "Toggle theme",
                                        onToggleTheme,
                                        touchTargetSize = 48.dp,
                                    )
                                }
                            },
                            below = { FilterChips(counts, stateFilter) { stateFilter = it } },
                        )
                    },
                    content = {
                        when {
                            all.isEmpty() && state.loading -> CenteredHint(loading = true, text = "Connecting to $laptopName…")
                            ordered.isEmpty() -> CenteredHint(loading = false, text = "No sessions match.")
                            else -> SessionList(
                                sessions = ordered,
                                onOpen = openSession,
                                onActions = { menuSession = it },
                                onNewSession = {
                                    scope.launch { if (biometricGate.unlock("Create new session")) viewModel.createSession() }
                                },
                            )
                        }
                    },
                )
            }
        }

        menuSession?.let { session ->
            SessionActionsSheet(
                session = session,
                laptopName = laptopName,
                onDismiss = { menuSession = null },
                onAttach = { menuSession = null; openSession(session) },
                onKill = { menuSession = null; killPending = session },
            )
        }

        killPending?.let { session ->
            ConfirmKillSheet(
                session = session,
                laptopName = laptopName,
                onDismiss = { killPending = null },
                onConfirm = {
                    killPending = null
                    scope.launch { if (biometricGate.unlock("Close session")) viewModel.killSession(session.id) }
                },
            )
        }
    }
}

private fun sessionsEyebrow(count: Int, laptopName: String = "your computer"): String {
    val n = when (count) {
        0 -> "NO"; 1 -> "ONE"; 2 -> "TWO"; 3 -> "THREE"; 4 -> "FOUR"; 5 -> "FIVE"; 6 -> "SIX"
        else -> count.toString()
    }
    val noun = if (count == 1) "SESSION" else "SESSIONS"
    return "$n $noun LIVE ON\n${laptopName.uppercase()}"
}

@Composable
private fun RefreshCircleButton(
    onRefresh: () -> Unit,
    visualSize: Dp = 32.dp,
    touchTargetSize: Dp = visualSize,
    iconSize: Dp = 16.dp,
) {
    val scope = rememberCoroutineScope()
    val rotation = remember { Animatable(0f) }
    IconCircleButton(
        icon = Icons.Default.Refresh,
        contentDescription = "Refresh",
        onClick = {
            onRefresh()
            scope.launch {
                rotation.stop()
                val start = rotation.value % 360f
                rotation.snapTo(start)
                rotation.animateTo(
                    targetValue = start + 360f,
                    animationSpec = tween(
                        durationMillis = 650,
                        easing = ShellyMotion.EmphasizedEasing,
                    ),
                )
                rotation.snapTo(rotation.value % 360f)
            }
        },
        iconModifier = Modifier.graphicsLayer { rotationZ = rotation.value },
        visualSize = visualSize,
        touchTargetSize = touchTargetSize,
        iconSize = iconSize,
    )
}

@Composable
private fun FilterChips(counts: Map<AgentState, Int>, selected: AgentState?, onSelect: (AgentState?) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SessionStateTab(
            label = "All",
            count = counts.values.sum(),
            active = selected == null,
            onClick = { onSelect(null) },
            modifier = Modifier.weight(1f),
        )
        listOf(AgentState.AwaitingInput, AgentState.Working, AgentState.Idle).forEach { st ->
            SessionStateTab(
                label = st.sessionStateLabel().substringBefore(' '),
                count = counts[st] ?: 0,
                active = selected == st,
                onClick = { onSelect(if (selected == st) null else st) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun SearchField(
    value: TextFieldValue,
    onValue: (TextFieldValue) -> Unit,
    focus: FocusRequester,
    onClear: () -> Unit,
    previewText: String? = null,
) {
    val c = ShellyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (c.isDark) c.insetCard else Color.White)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Default.Search, null, tint = if (c.isDark) c.textMuted else c.textPrimary, modifier = Modifier.size(20.dp))
        if (previewText != null) {
            Text(
                previewText,
                style = ShellyType.mono.copy(fontWeight = FontWeight(500), fontSize = 16.sp, lineHeight = 20.sp),
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
        } else {
            androidx.compose.foundation.text.BasicTextField(
                value = value,
                onValueChange = onValue,
                singleLine = true,
                textStyle = ShellyType.mono.copy(
                    color = c.textPrimary,
                    fontWeight = FontWeight(500),
                    fontSize = 16.sp,
                    lineHeight = 20.sp,
                ),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(c.accent),
                modifier = Modifier.weight(1f).focusRequester(focus),
                decorationBox = { inner ->
                    if (value.text.isEmpty()) {
                        Text(
                            "search sessions",
                            style = ShellyType.mono.copy(fontWeight = FontWeight(500), fontSize = 16.sp, lineHeight = 20.sp),
                            color = c.textMuted,
                        )
                    }
                    inner()
                },
            )
        }
        Box(
            Modifier
                .size(32.dp)
                .clickable(onClick = onClear),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                Modifier
                    .size(24.dp)
                    .clip(RoundedCornerShape(100))
                    .background(if (c.isDark) c.surfaceSubtle else c.divider),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Default.Close, null, tint = c.textMuted, modifier = Modifier.size(12.dp))
            }
        }
    }
}

@Composable
private fun SessionList(
    sessions: List<MobileSession>,
    onOpen: (MobileSession) -> Unit,
    onActions: (MobileSession) -> Unit,
    onNewSession: () -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize()) {
        items(sessions, key = { it.id }) { session ->
            var visible by remember(session.id) { mutableStateOf(false) }
            LaunchedEffect(session.id) { visible = true }
            AnimatedVisibility(
                visible = visible,
                enter = fadeIn(animationSpec = ShellyMotion.fastTween()) +
                    slideInVertically(
                        animationSpec = ShellyMotion.routeTween(),
                        initialOffsetY = { it / 4 },
                    ),
            ) {
                Box(
                    Modifier.animateItem(placementSpec = ShellyMotion.standardTween()),
                ) {
                    SessionRow(
                        session = session,
                        onClick = { onOpen(session) },
                        onLongClick = { onActions(session) },
                        onMoreClick = { onActions(session) },
                        showDivider = session != sessions.last(),
                    )
                }
            }
        }
        item {
            Spacer(Modifier.height(16.dp))
            NewSessionButton(onNewSession)
        }
    }
}

/** Footer action styled like the design's "View all" row: a 2dp top rule + big underlined link. */
@Composable
private fun NewSessionButton(onClick: () -> Unit) {
    val c = ShellyTheme.colors
    Column(Modifier.fillMaxWidth().padding(top = 14.dp)) {
        Box(Modifier.fillMaxWidth().height(2.dp).background(c.textPrimary.copy(alpha = 0.14f)))
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(top = 18.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "New session",
                style = ShellyType.heading.copy(fontWeight = FontWeight(700), fontSize = 22.sp, lineHeight = 28.sp),
                color = c.textPrimary,
                textDecoration = TextDecoration.Underline,
            )
            Icon(Icons.Default.Add, null, tint = c.textPrimary, modifier = Modifier.size(26.dp))
        }
    }
}

@Composable
private fun CenteredHint(loading: Boolean, text: String) {
    val c = ShellyTheme.colors
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (loading) CircularProgressIndicator(color = c.accent, strokeWidth = 2.dp, modifier = Modifier.size(28.dp))
            Text(text, style = ShellyType.mono, color = c.textMuted)
        }
    }
}

@Composable
private fun SessionActionsSheet(
    session: MobileSession,
    laptopName: String,
    onDismiss: () -> Unit,
    onAttach: () -> Unit,
    onKill: () -> Unit,
) {
    val c = ShellyTheme.colors
    BackHandler(onBack = onDismiss)
    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier
                .padding(16.dp)
                .fillMaxSize()
                .clip(RoundedCornerShape(24.dp))
                .background(Color.Black.copy(alpha = 0.55f))
                .clickable(onClick = onDismiss),
        )
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(horizontal = 16.dp, vertical = 16.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(24.dp))
                .background(c.modalCard)
                .padding(horizontal = 10.dp)
                .padding(top = 10.dp, bottom = 12.dp),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp)
                    .padding(top = 14.dp, bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                StatusDot(session.state, size = 9.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(
                        session.name,
                        style = ShellyType.rowTitle.copy(fontSize = 18.sp, lineHeight = 22.sp),
                        color = c.textPrimary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        session.sheetSubtitle(laptopName),
                        style = ShellyType.monoSmall.copy(fontWeight = FontWeight(500), lineHeight = 15.sp),
                        color = c.textMuted.copy(alpha = 0.5f),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(c.insetCard)
                    .padding(6.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                SheetRow(Icons.Default.Link, "Attach", c.textPrimary, FontWeight(600), onAttach)
                SheetRow(Icons.Default.DeleteOutline, "End session", c.destructive, FontWeight(600), onKill)
            }
        }
    }
}

@Composable
private fun SheetRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tint: Color,
    weight: FontWeight,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            icon,
            null,
            tint = if (tint == ShellyTheme.colors.destructive) tint else ShellyTheme.colors.textMuted,
            modifier = Modifier.size(20.dp),
        )
        Text(
            label,
            style = ShellyType.itemTitle.copy(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = weight),
            color = tint,
            modifier = Modifier.weight(1f),
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConfirmKillSheet(session: MobileSession, laptopName: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val c = ShellyTheme.colors
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.modalCard) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("End ${session.name}?", style = ShellyType.heading, color = c.textPrimary)
            Text(killSessionBody(session.name, laptopName), style = ShellyType.mono, color = c.textMuted)
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.destructive).clickable(onClick = onConfirm).padding(vertical = 15.dp),
                horizontalArrangement = Arrangement.Center,
            ) { Text("End session", style = ShellyType.button, color = androidx.compose.ui.graphics.Color.White) }
            Text("Cancel", style = ShellyType.button, color = c.textMuted, modifier = Modifier.fillMaxWidth().clickable(onClick = onDismiss).padding(vertical = 6.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
    }
}

/** Stateless render of the populated Sessions screen — used by screenshot tests. */
@Composable
internal fun SessionsContentPreview(sessions: List<MobileSession>, loading: Boolean) {
    val counts = AgentState.values().associateWith { st -> sessions.count { it.state == st } }
    ShellyScreen(
        heroHeight = FilteredSessionsHeroHeight,
        hero = {
            HeroBody(
                eyebrow = sessionsEyebrow(sessions.size),
                wordmark = "SES",
                wordmarkSize = 132.sp,
                brandTrailing = { PaperHeroActions(includeTheme = true) },
                below = { FilterChips(counts, null) {} },
            )
        },
        content = {
            when {
                sessions.isEmpty() && loading -> CenteredHint(true, "Connecting to your computer…")
                sessions.isEmpty() -> CenteredHint(false, "No sessions running.\nStart one from your computer.")
                else -> SessionsDashboardPreviewList(sessions)
            }
        },
    )
}

@Composable
private fun SessionsDashboardPreviewList(sessions: List<MobileSession>) {
    Column(Modifier.fillMaxSize()) {
        sessions.forEachIndexed { index, session ->
            SessionRow(session = session, onClick = {}, showDivider = index < sessions.lastIndex)
        }
        Spacer(Modifier.height(16.dp))
        ViewAllButton()
    }
}

@Composable
private fun SessionsSearchScaffold(
    query: TextFieldValue,
    focusRequester: FocusRequester,
    matches: List<MobileSession>,
    totalSessions: Int,
    totalDevices: Int,
    onQueryChange: (TextFieldValue) -> Unit,
    onClose: () -> Unit,
    onRefresh: () -> Unit,
    onOpen: (MobileSession) -> Unit,
    onActions: (MobileSession) -> Unit,
    previewText: String? = null,
) {
    ShellyScreen(
        heroHeight = 196.dp,
        hero = {
            BrandRow {
                Row {
                    RefreshCircleButton(
                        onRefresh = onRefresh,
                        visualSize = 36.dp,
                        touchTargetSize = 48.dp,
                        iconSize = 18.dp,
                    )
                    HeroEscapeButton(onClick = onClose, contentDescription = "Close search")
                }
            }
            Spacer(Modifier.height(24.dp))
            SearchField(
                value = query,
                onValue = onQueryChange,
                focus = focusRequester,
                onClear = onClose,
                previewText = previewText,
            )
        },
        content = {
            SearchResultsContent(
                query = query.text,
                matches = matches,
                totalSessions = totalSessions,
                totalDevices = totalDevices,
                onOpen = onOpen,
                onActions = onActions,
            )
        },
    )
}

@Composable
private fun MatchCountLabel(count: Int) {
    val c = ShellyTheme.colors
    Text(
        "$count ${if (count == 1) "SESSION" else "SESSIONS"} MATCH",
        style = ShellyType.microLabel,
        color = if (c.isDark) c.textMuted else c.textPrimary,
    )
}

@Composable
private fun SearchResultsContent(
    query: String,
    matches: List<MobileSession>,
    totalSessions: Int,
    totalDevices: Int,
    onOpen: (MobileSession) -> Unit,
    onActions: (MobileSession) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Box(
            modifier = Modifier.fillMaxWidth().height(24.dp),
            contentAlignment = Alignment.TopStart,
        ) {
            if (query.isNotBlank()) MatchCountLabel(matches.size)
        }
        LazyColumn(Modifier.weight(1f)) {
            items(matches, key = { it.id }) { session ->
                SearchResultRow(
                    session = session,
                    showDivider = true,
                    onOpen = { onOpen(session) },
                    onActions = { onActions(session) },
                )
            }
        }
        Spacer(Modifier.height(24.dp))
        RecentSearchesFooter(totalSessions = totalSessions, totalDevices = totalDevices)
    }
}

@Composable
private fun SearchResultRow(
    session: MobileSession,
    showDivider: Boolean,
    onOpen: () -> Unit,
    onActions: () -> Unit,
) {
    val c = ShellyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onOpen, onLongClick = onActions)
            .then(if (showDivider) Modifier.drawBottomRule(ShellyTheme.colors.divider) else Modifier)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.width(10.dp), contentAlignment = Alignment.Center) {
            StatusDot(session.state)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                session.name,
                style = ShellyType.rowTitle,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                session.sessionPreviewText(),
                style = ShellyType.monoSmall,
                color = c.textMuted.copy(alpha = 0.55f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        IconCircleButton(
            icon = Icons.Default.MoreVert,
            contentDescription = "More actions for ${session.name}",
            onClick = onActions,
            visualSize = 32.dp,
            touchTargetSize = 48.dp,
            iconSize = 18.dp,
        )
    }
}

@Composable
private fun RecentSearchesFooter(totalSessions: Int, totalDevices: Int) {
    val c = ShellyTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .drawTopRule(ShellyTheme.colors.divider)
            .padding(top = 22.dp),
        verticalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ClockGlyph(color = c.textMuted.copy(alpha = if (c.isDark) 0.55f else 0.35f), size = 13.dp)
            Text(
                buildString {
                    append("SEARCHED $totalSessions ")
                    append(if (totalSessions == 1) "SESSION" else "SESSIONS")
                    if (totalDevices > 0) {
                        append(" · $totalDevices ")
                        append(if (totalDevices == 1) "DEVICE" else "DEVICES")
                    }
                },
                style = ShellyType.microLabel.copy(fontWeight = FontWeight(500), letterSpacing = 0.06.sp),
                color = (if (c.isDark) c.textMuted else c.textPrimary).copy(alpha = 0.35f),
            )
        }
    }
}

@Composable
private fun SessionsEmptyScaffold(
    laptopName: String = "your computer",
    onRefresh: () -> Unit = {},
    onToggleTheme: () -> Unit = {},
    onOpenCommandPalette: () -> Unit = {},
    onSearch: () -> Unit = {},
) {
    val c = ShellyTheme.colors
    ShellyScreen(
        hero = {
            HeroBody(
                eyebrow = "NOTHING RUNNING ON\n${laptopName.uppercase()}",
                wordmark = "ZERO",
                wordmarkSize = 132.sp,
                brandTrailing = {
                    PaperHeroActions(
                        onOpenCommands = onOpenCommandPalette,
                        onRefresh = onRefresh,
                        onToggleTheme = onToggleTheme,
                        onSearch = onSearch,
                        includeTheme = true,
                    )
                },
            )
        },
        content = { SessionsEmptyStateContent() },
    )
}

@Composable
private fun SessionsEmptyStateContent() {
    val c = ShellyTheme.colors
    Column(Modifier.fillMaxSize()) {
        Spacer(Modifier.height(4.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 18.dp)) {
            Text(
                "TO GET A SESSION GOING",
                style = ShellyType.microLabel,
                color = (if (c.isDark) c.textMuted else c.textPrimary).copy(alpha = 0.55f),
            )
            Text(
                "Start a terminal on your computer",
                style = ShellyType.heading.copy(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight(600)),
                color = c.textPrimary,
            )
        }
        SessionLaunchCard()
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 22.dp)) {
            Text(
                "IT WILL LAND HERE",
                style = ShellyType.microLabel,
                color = (if (c.isDark) c.textMuted else c.textPrimary).copy(alpha = 0.55f),
            )
            PlaceholderSessionRow()
        }
    }
}

@Composable
private fun SessionLaunchCard() {
    val c = ShellyTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(c.insetCard)
            .padding(horizontal = 18.dp, vertical = 16.dp),
    ) {
        Text(
            "RUN ON YOUR COMPUTER",
            style = ShellyType.microLabel,
            color = c.textMuted.copy(alpha = if (c.isDark) 0.8f else 0.72f),
        )
        Spacer(Modifier.height(9.dp))
        Text(
            "$ shelly",
            style = ShellyType.mono.copy(fontWeight = FontWeight(700), fontSize = 19.sp, lineHeight = 24.sp),
            color = c.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Box(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 13.dp)
                .height(1.dp)
                .background(c.divider),
        )
        Text(
            "Then run Claude, Codex, or anything.",
            style = ShellyType.mono.copy(fontSize = 13.sp, lineHeight = 18.sp),
            color = c.textMuted,
        )
    }
}

@Composable
private fun PlaceholderSessionRow() {
    val c = ShellyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .dashedRoundRectBorder(c.textPrimary.copy(alpha = if (c.isDark) 0.14f else 0.16f), 1.5.dp, 14.dp)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(
            Modifier
                .size(10.dp)
                .dashedCircleBorder(c.textPrimary.copy(alpha = if (c.isDark) 0.14f else 0.24f), 1.5.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                "your-project · ~/path",
                style = ShellyType.rowTitle.copy(fontWeight = FontWeight(600)),
                color = c.textPrimary.copy(alpha = 0.35f),
            )
            Text(
                "live the instant it starts",
                style = ShellyType.mono.copy(fontSize = 13.sp, lineHeight = 16.sp),
                color = c.textMuted.copy(alpha = 0.35f),
            )
        }
    }
}

@Composable
private fun SessionsGroupedScaffold() {
    val sessions = groupedPreviewSessions()
    val c = ShellyTheme.colors
    ShellyScreen(
        hero = {
            HeroBody(
                eyebrow = "TWO COMPUTERS PAIRED —\nTAP TO SWITCH DEVICE",
                wordmark = "SES",
                wordmarkSize = 132.sp,
                brandTrailing = { PaperHeroActions(includeTheme = true) },
            )
        },
        content = {
            Column(Modifier.fillMaxSize()) {
                DeviceSwitcher()
                sessions.forEachIndexed { index, session ->
                    SessionRow(session = session, onClick = {}, showDivider = index < sessions.lastIndex)
                }
                Spacer(Modifier.height(16.dp))
                OutlinedNewSessionButton()
            }
        },
    )
}

@Composable
private fun DeviceSwitcher() {
    Row(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
        DeviceTab(
            label = "MACBOOK-PRO",
            detail = "3 LIVE",
            active = true,
            laptop = true,
            modifier = Modifier.weight(1f).padding(end = 14.dp),
        )
        DeviceTab(
            label = "MAC-STUDIO",
            detail = "OFFLINE · 3",
            active = false,
            laptop = false,
            modifier = Modifier.weight(1f).padding(start = 14.dp),
        )
    }
}

@Composable
private fun DeviceTab(label: String, detail: String, active: Boolean, laptop: Boolean, modifier: Modifier = Modifier) {
    val c = ShellyTheme.colors
    val primary = if (active) c.textPrimary else c.textMuted
    Column(
        modifier
            .drawBehind {
                val y = size.height - 1.25.dp.toPx()
                drawLine(
                    color = if (active) c.accent else c.divider,
                    start = Offset(0f, y),
                    end = Offset(size.width, y),
                    strokeWidth = 2.5.dp.toPx(),
                )
            }
            .padding(bottom = 13.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DeviceGlyph(laptop = laptop, color = primary, size = 15.dp)
            Text(
                label,
                style = ShellyType.mono.copy(fontWeight = FontWeight(700), fontSize = 13.sp, lineHeight = 16.sp),
                color = primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            if (active) {
                Box(Modifier.size(7.dp).clip(RoundedCornerShape(100)).background(c.accent))
            } else {
                Box(Modifier.size(7.dp).border(1.5.dp, c.textMuted, RoundedCornerShape(100)))
            }
            Text(
                detail,
                style = ShellyType.microLabel.copy(fontWeight = FontWeight(500), letterSpacing = 0.04.sp),
                color = c.textMuted,
            )
        }
    }
}

@Composable
private fun OutlinedNewSessionButton() {
    val c = ShellyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .border(1.5.dp, c.textPrimary.copy(alpha = if (c.isDark) 0.14f else 0.12f), RoundedCornerShape(14.dp))
            .padding(vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Default.Add, null, tint = c.textPrimary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(9.dp))
        Text("New session", style = ShellyType.button, color = c.textPrimary)
    }
}

@Composable
internal fun DaemonUnreachableScaffold(
    unreachable: ConnectionState.Unreachable,
    laptopName: String = "your computer",
    onRetry: () -> Unit,
) {
    val now = rememberReconnectNow()
    ShellyScreen(
        hero = {
            HeroBody(
                eyebrow = "CAN'T REACH\n${laptopName.uppercase()}",
                wordmark = "SES",
                wordmarkSize = 132.sp,
                brandTrailing = { PaperHeroActions(includeTheme = false) },
            )
        },
        content = { DaemonUnreachableContent(unreachable = unreachable, now = now, onRetry = onRetry) },
    )
}

@Composable
private fun DaemonUnreachableContent(
    unreachable: ConnectionState.Unreachable,
    now: Long,
    onRetry: () -> Unit,
) {
    val c = ShellyTheme.colors
    val lastSeen = formatRelativeAgo(now - unreachable.droppedAtMillis)
    Column(Modifier.fillMaxSize()) {
        Spacer(Modifier.height(4.dp))
        Column(verticalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(bottom = 18.dp)) {
            WarningGlyph(color = c.textPrimary, size = 40.dp)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "Daemon unreachable",
                    style = ShellyType.heading.copy(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight(600)),
                    color = c.textPrimary,
                )
                Text(
                    "last seen $lastSeen",
                    style = ShellyType.mono.copy(fontWeight = FontWeight(500), lineHeight = 18.sp),
                    color = c.textMuted.copy(alpha = 0.6f),
                )
            }
        }
        CommandCheckRow("$ shelly doctor", "CHECK IT")
        Spacer(Modifier.weight(1f))
        PrimaryActionButton("Retry connection", retrying = true, onClick = onRetry)
    }
}

@Composable
private fun CommandCheckRow(command: String, action: String) {
    val c = ShellyTheme.colors
    val clipboard = LocalClipboardManager.current
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(c.insetCard)
            .clickable {
                clipboard.setText(AnnotatedString(command.removePrefix("$ ")))
            }
            .padding(horizontal = 16.dp, vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            command,
            style = ShellyType.mono.copy(fontWeight = FontWeight(500), fontSize = 14.sp, lineHeight = 18.sp),
            color = c.textPrimary,
            modifier = Modifier.weight(1f),
        )
        Text(
            action,
            style = ShellyType.microLabel.copy(fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.06.sp),
            color = c.textPrimary.copy(alpha = 0.45f),
        )
    }
}

@Composable
internal fun ReconnectingScaffold(
    reconnecting: ConnectionState.Reconnecting,
    sessions: List<MobileSession>,
    laptopName: String = "your computer",
    onRetry: () -> Unit,
) {
    val now = rememberReconnectNow()
    ShellyScreen(
        hero = { ReconnectingHero(reconnecting = reconnecting, now = now, laptopName = laptopName) },
        content = { ReconnectingContent(reconnecting = reconnecting, sessions = sessions, onRetry = onRetry) },
    )
}

@Composable
private fun ColumnScope.ReconnectingHero(reconnecting: ConnectionState.Reconnecting, now: Long, laptopName: String) {
    val c = ShellyTheme.colors
    val retryProgress = retryProgress(label = "reconnectingHeroProgress")
    val pulseAlpha = 1f - sin(retryProgress * PI).toFloat().coerceAtLeast(0f) * 0.22f
    val elapsedShort = formatDurationSeconds(now - reconnecting.droppedAtMillis)
    BrandRow {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "OFFLINE",
                style = ShellyType.brand.copy(fontWeight = FontWeight(500), letterSpacing = 0.sp),
                color = c.textPrimary,
                modifier = Modifier.graphicsLayer { alpha = pulseAlpha },
            )
            Text(elapsedShort, style = ShellyType.mono.copy(fontSize = 13.sp, lineHeight = 16.sp), color = c.textPrimary.copy(alpha = 0.7f))
        }
    }
    Spacer(Modifier.weight(1f).heightIn(min = 8.dp))
    Text("LOST THE DAEMON —\nRETRYING THE TUNNEL", style = ShellyType.eyebrow, color = c.textPrimary)
    Spacer(Modifier.height(18.dp))
    Text(
        "SYNC",
        style = ShellyType.wordmark.copy(fontSize = 96.sp, lineHeight = 96.sp),
        color = c.heroWordmark.copy(alpha = pulseAlpha),
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Visible,
        modifier = Modifier.wordmarkFootprint(96.sp),
    )
    Spacer(Modifier.height(18.dp))
    Text(
        "Reconnecting to $laptopName",
        style = ShellyType.rowTitle.copy(fontWeight = FontWeight(500), lineHeight = 24.sp),
        color = c.textPrimary,
        maxLines = 1,
        modifier = Modifier.drawBehind {
            val alpha = sin(retryProgress * PI).toFloat().coerceAtLeast(0f) * 0.22f
            if (alpha > 0.001f) {
                drawLine(
                    color = c.accent.copy(alpha = alpha),
                    start = Offset(0f, size.height + 5.dp.toPx()),
                    end = Offset(size.width * retryProgress, size.height + 5.dp.toPx()),
                    strokeWidth = 2.dp.toPx(),
                    cap = StrokeCap.Round,
                )
            }
        },
    )
    Spacer(Modifier.height(8.dp))
}

@Composable
private fun ReconnectingContent(
    reconnecting: ConnectionState.Reconnecting,
    sessions: List<MobileSession>,
    onRetry: () -> Unit,
) {
    val c = ShellyTheme.colors
    val held = sessions.take(MAX_HELD_SESSION_ROWS)
    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .padding(top = 20.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(c.insetCard)
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "WHAT WE’RE HOLDING FOR YOU",
                style = ShellyType.microLabel.copy(fontSize = 10.sp, lineHeight = 12.sp, letterSpacing = 0.06.sp),
                color = c.textMuted,
            )
            if (held.isEmpty()) {
                Text(
                    "No sessions were live when the link dropped.",
                    style = ShellyType.monoSmall.copy(fontSize = 11.sp, lineHeight = 15.sp),
                    color = c.textMuted.copy(alpha = 0.6f),
                )
            } else {
                held.forEach { session ->
                    HeldSessionRow(
                        title = session.name,
                        detail = session.sessionPreviewText(),
                        state = session.state,
                    )
                }
                if (sessions.size > held.size) {
                    Text(
                        "+${sessions.size - held.size} MORE HELD",
                        style = ShellyType.microLabel.copy(fontSize = 10.sp, lineHeight = 12.sp, letterSpacing = 0.06.sp),
                        color = c.textMuted.copy(alpha = 0.5f),
                    )
                }
            }
        }
        Spacer(Modifier.weight(1f))
        PrimaryActionButton("Retry now", compactRadius = 6.dp, showChevron = true, retrying = true, onClick = onRetry)
        Row(
            Modifier
                .padding(top = 12.dp)
                .drawTopRule(ShellyTheme.colors.divider)
                .padding(top = 14.dp)
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "ENCRYPTED",
                style = ShellyType.microLabel.copy(fontWeight = FontWeight(400), fontSize = 10.sp, lineHeight = 12.sp, letterSpacing = 0.06.sp),
                color = c.textMuted.copy(alpha = 0.5f),
            )
            Text(
                "P2P",
                style = ShellyType.microLabel.copy(fontWeight = FontWeight(400), fontSize = 10.sp, lineHeight = 12.sp, letterSpacing = 0.06.sp),
                color = c.textMuted.copy(alpha = 0.5f),
            )
        }
    }
}

/** Held-session rows are capped so a long live list never pushes the retry button off-screen. */
private const val MAX_HELD_SESSION_ROWS = 3

@Composable
private fun HeldSessionRow(title: String, detail: String, state: AgentState) {
    val c = ShellyTheme.colors
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.padding(top = 6.dp).width(8.dp), contentAlignment = Alignment.Center) {
            StatusDot(state, size = 8.dp)
        }
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = ShellyType.brand.copy(fontWeight = FontWeight(600), letterSpacing = 0.sp),
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                detail,
                style = ShellyType.monoSmall.copy(fontSize = 11.sp, lineHeight = 14.sp),
                color = c.textMuted.copy(alpha = 0.6f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun PrimaryActionButton(
    text: String,
    compactRadius: Dp = 14.dp,
    showChevron: Boolean = false,
    retrying: Boolean = false,
    onClick: () -> Unit = {},
) {
    val c = ShellyTheme.colors
    val progress = if (retrying) retryProgress(label = "retryButtonProgress") else 0f
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(compactRadius))
            .background(c.buttonPrimary)
            .clickable(onClick = onClick)
            .drawBehind {
                if (retrying && progress > 0.001f) {
                    drawRoundRect(
                        color = c.accent.copy(alpha = 0.28f),
                        topLeft = Offset(0f, size.height - 2.dp.toPx()),
                        size = Size(size.width * progress, 2.dp.toPx()),
                        cornerRadius = CornerRadius(2.dp.toPx(), 2.dp.toPx()),
                    )
                }
            }
            .padding(horizontal = if (showChevron) 20.dp else 16.dp, vertical = if (showChevron) 16.dp else 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(if (showChevron) 12.dp else 10.dp)) {
            Icon(
                Icons.Default.Refresh,
                null,
                tint = if (c.isDark) c.onButtonPrimary else c.accent,
                modifier = Modifier.size(if (showChevron) 22.dp else 20.dp),
            )
            Text(
                text,
                style = ShellyType.button.copy(fontSize = if (showChevron) 20.sp else 18.sp, lineHeight = if (showChevron) 24.sp else 24.sp),
                color = c.onButtonPrimary,
            )
        }
        if (showChevron) DoubleChevron(color = c.onButtonPrimary, size = 22.dp)
    }
}

@Composable
private fun PaperHeroActions(
    onOpenCommands: () -> Unit = {},
    onRefresh: () -> Unit = {},
    onToggleTheme: () -> Unit = {},
    onSearch: () -> Unit = {},
    includeTheme: Boolean,
) {
    val c = ShellyTheme.colors
    Row {
        CommandMenuButton(onOpenCommands)
        HeroActionButton(Icons.Default.Search, "Search", onSearch)
        RefreshCircleButton(onRefresh, touchTargetSize = 48.dp)
        if (includeTheme) {
            IconCircleButton(
                if (c.isDark) Icons.Default.LightMode else Icons.Default.DarkMode,
                "Toggle theme",
                onToggleTheme,
                touchTargetSize = 48.dp,
            )
        }
    }
}

@Composable
private fun HeroActionButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
) {
    IconCircleButton(
        icon = icon,
        contentDescription = contentDescription,
        onClick = onClick,
        touchTargetSize = 48.dp,
    )
}

@Composable
private fun CommandMenuButton(onClick: () -> Unit) {
    val c = ShellyTheme.colors
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.92f)
    Box(
        Modifier
            .size(48.dp)
            .semantics { contentDescription = "Open command menu" }
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(32.dp)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .clip(RoundedCornerShape(100))
                .background(c.surfaceSubtle),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "CMD",
                style = ShellyType.microLabel,
                color = c.textPrimary,
            )
        }
    }
}

@Composable
private fun LongPressBaseScaffold(sessions: List<MobileSession>) {
    val counts = AgentState.values().associateWith { st -> sessions.count { it.state == st } }
    ShellyScreen(
        heroHeight = FilteredSessionsHeroHeight,
        hero = {
            HeroBody(
                eyebrow = sessionsEyebrow(sessions.size),
                wordmark = "SES",
                wordmarkSize = 132.sp,
                brandTrailing = { PaperHeroActions(includeTheme = false) },
                below = { FilterChips(counts, null) {} },
            )
        },
        content = {
            Column(Modifier.fillMaxSize()) {
                sessions.forEachIndexed { index, session ->
                    SessionRow(session = session, onClick = {}, showDivider = index != 2 && index < sessions.lastIndex)
                }
                Spacer(Modifier.weight(1f))
                ViewAllButton()
            }
        },
    )
}

@Composable
private fun ViewAllButton() {
    val c = ShellyTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .drawBehind {
                drawLine(
                    c.textPrimary.copy(alpha = if (c.isDark) 0.14f else 1f),
                    Offset(0f, 0f),
                    Offset(size.width, 0f),
                    strokeWidth = 2.dp.toPx(),
                )
            }
            .padding(top = 18.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            "View all",
            style = ShellyType.heading.copy(fontWeight = FontWeight(700), fontSize = 22.sp, lineHeight = 28.sp),
            color = c.textPrimary,
            textDecoration = TextDecoration.Underline,
        )
        DoubleChevron(color = c.textMuted, size = 26.dp)
    }
}

private fun MobileSession.sheetSubtitle(laptopName: String): String {
    val ago = formatRelativeAgo(System.currentTimeMillis() - lastActivity.toLong())
    return "${state.sessionStateLabel().lowercase()} · $ago · $laptopName"
}

private fun Modifier.drawBottomRule(color: Color): Modifier = drawBehind {
    val y = size.height - 0.5.dp.toPx()
    drawLine(color, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
}

private fun Modifier.drawTopRule(color: Color): Modifier = drawBehind {
    drawLine(color, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx())
}

private fun Modifier.dashedRoundRectBorder(color: Color, width: Dp, radius: Dp): Modifier = drawBehind {
    val strokeWidth = width.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset(strokeWidth / 2f, strokeWidth / 2f),
        size = Size(size.width - strokeWidth, size.height - strokeWidth),
        cornerRadius = CornerRadius(radius.toPx(), radius.toPx()),
        style = Stroke(width = strokeWidth, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))),
    )
}

private fun Modifier.dashedCircleBorder(color: Color, width: Dp): Modifier = drawBehind {
    drawCircle(
        color = color,
        radius = (size.minDimension - width.toPx()) / 2f,
        center = Offset(size.width / 2f, size.height / 2f),
        style = Stroke(width = width.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx()))),
    )
}

@Composable
private fun retryProgress(label: String): Float {
    if (!ShellyTheme.motionEnabled) return 0f
    val transition = rememberInfiniteTransition(label = label)
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(
                durationMillis = 2200,
                easing = ShellyMotion.Linear,
            ),
            repeatMode = RepeatMode.Restart,
        ),
        label = "$label.value",
    )
    return progress
}

/**
 * Wall-clock now for the reconnect screens, re-read every second so elapsed/countdown labels tick.
 * Gated on [ShellyTheme.motionEnabled] so reduced-motion (and screenshot) renders take one stable
 * snapshot instead of an endless redraw loop.
 */
@Composable
private fun rememberReconnectNow(): Long {
    if (!ShellyTheme.motionEnabled) {
        return System.currentTimeMillis()
    }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

/** "4s" / "1m 4s" — floor to whole seconds, never negative. */
private fun formatDurationSeconds(millis: Long): String {
    val totalSeconds = (millis / 1000).coerceAtLeast(0)
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return if (minutes > 0) "${minutes}m ${seconds}s" else "${seconds}s"
}

/** "45s ago" / "2m ago" / "1h ago". */
private fun formatRelativeAgo(millis: Long): String {
    val totalSeconds = (millis / 1000).coerceAtLeast(0)
    val minutes = totalSeconds / 60
    val hours = minutes / 60
    return when {
        hours > 0 -> "${hours}h ago"
        minutes > 0 -> "${minutes}m ago"
        else -> "${totalSeconds}s ago"
    }
}

@Composable
private fun WarningGlyph(color: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val sx = this.size.width / 24f
        val sy = this.size.height / 24f
        val stroke = Stroke(width = 2f * sx, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val path = Path().apply {
            moveTo(12f * sx, 3f * sy)
            lineTo(22f * sx, 20f * sy)
            lineTo(2f * sx, 20f * sy)
            close()
        }
        drawPath(path, color = color, style = stroke)
        drawLine(color, Offset(12f * sx, 10f * sy), Offset(12f * sx, 14f * sy), strokeWidth = 2f * sx, cap = StrokeCap.Round)
        drawLine(color, Offset(12f * sx, 17f * sy), Offset(12.01f * sx, 17f * sy), strokeWidth = 2.2f * sx, cap = StrokeCap.Round)
    }
}

@Composable
private fun DeviceGlyph(laptop: Boolean, color: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val sx = this.size.width / 24f
        val sy = this.size.height / 24f
        val stroke = Stroke(width = 1.8f * sx, cap = StrokeCap.Round, join = StrokeJoin.Round)
        if (laptop) {
            drawRoundRect(
                color = color,
                topLeft = Offset(3f * sx, 4f * sy),
                size = Size(18f * sx, 12f * sy),
                cornerRadius = CornerRadius(2f * sx, 2f * sy),
                style = stroke,
            )
            drawLine(color, Offset(2f * sx, 20f * sy), Offset(22f * sx, 20f * sy), strokeWidth = 1.8f * sx, cap = StrokeCap.Round)
        } else {
            drawRoundRect(
                color = color,
                topLeft = Offset(3f * sx, 3f * sy),
                size = Size(18f * sx, 13f * sy),
                cornerRadius = CornerRadius(2f * sx, 2f * sy),
                style = stroke,
            )
            drawLine(color, Offset(12f * sx, 16f * sy), Offset(12f * sx, 20f * sy), strokeWidth = 1.8f * sx)
            drawLine(color, Offset(9f * sx, 20f * sy), Offset(15f * sx, 20f * sy), strokeWidth = 1.8f * sx, cap = StrokeCap.Round)
        }
    }
}

@Composable
private fun ClockGlyph(color: Color, size: Dp) {
    Canvas(Modifier.size(size)) {
        val sx = this.size.width / 24f
        val sy = this.size.height / 24f
        drawCircle(color, radius = 9f * sx, center = Offset(12f * sx, 12f * sy), style = Stroke(width = 2f * sx))
        val stroke = Stroke(width = 2f * sx, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val path = Path().apply {
            moveTo(12f * sx, 8f * sy)
            lineTo(12f * sx, 12f * sy)
            lineTo(15f * sx, 14f * sy)
        }
        drawPath(path, color = color, style = stroke)
    }
}

private fun previewSessions() = listOf(
    MobileSession("1", "shelly · pkg/cli", listOf("claude"), "/x", 0u, 12u, AgentState.AwaitingInput, "› Approve replacing src/cli/pair.rs ?", "opus-4-8"),
    MobileSession("2", "shelly · crates/daemon", listOf("cargo", "test"), "/x", 0u, 9u, AgentState.Working, "cargo test --workspace", null),
    MobileSession("3", "scratch · ~/notes", listOf("vim"), "/x", 0u, 8u, AgentState.Idle, "vim notes/2026-05-28-plan.md", null),
    MobileSession("4", "infra · scripts/dogfood", listOf("./gradlew"), "/x", 0u, 6u, AgentState.Working, "▌ Building Android release · gradlew", null),
    MobileSession("5", "dot · ~", listOf("zsh"), "/x", 0u, 3u, AgentState.Idle, "zsh · 1h ago", null),
    MobileSession("6", "ios-release · apps/ios", listOf("xcodebuild"), "/x", 0u, 1u, AgentState.Crashed, "xcodebuild: archive failed", null),
)

private fun groupedPreviewSessions() = listOf(
    MobileSession("1", "shelly · pkg/cli", listOf("claude"), "/x", 0u, 12u, AgentState.AwaitingInput, "› Approve replacing src/cli/pair.rs ?", "opus-4-8"),
    MobileSession("2", "shelly · crates/daemon", listOf("cargo", "test"), "/x", 0u, 9u, AgentState.Working, "cargo test --workspace", null),
    MobileSession("3", "scratch · ~/notes", listOf("vim"), "/x", 0u, 8u, AgentState.Idle, "vim notes/2026-05-28-plan.md", null),
)

@Composable
internal fun SessionsSearchPreview() {
    val focus = remember { FocusRequester() }
    val sessions = previewSessions().take(2)
    SessionsSearchScaffold(
        query = TextFieldValue("shelly"),
        focusRequester = focus,
        matches = sessions,
        totalSessions = 6,
        totalDevices = 2,
        onQueryChange = {},
        onClose = {},
        onRefresh = {},
        onOpen = {},
        onActions = {},
        previewText = "shelly|",
    )
}

@Composable
internal fun SessionsGroupedPreview() {
    SessionsGroupedScaffold()
}

@Composable
internal fun SessionsEmptyPreview() {
    SessionsEmptyScaffold()
}

@Composable
internal fun DaemonUnreachablePreview() {
    val now = System.currentTimeMillis()
    DaemonUnreachableScaffold(
        unreachable = ConnectionState.Unreachable(
            droppedAtMillis = now - 120_000L,
            attempt = 9,
            retryIntervalMillis = 15_000L,
            nextRetryAtMillis = now + 15_000L,
        ),
        onRetry = {},
    )
}

@Composable
internal fun ReconnectingPreview() {
    val now = System.currentTimeMillis()
    ReconnectingScaffold(
        reconnecting = ConnectionState.Reconnecting(
            droppedAtMillis = now - 4_000L,
            attempt = 3,
            nextRetryAtMillis = now + 2_000L,
        ),
        sessions = previewSessions().take(2),
        onRetry = {},
    )
}

@Composable
internal fun SessionsLongPressPreview() {
    val sessions = previewSessions()
    Box(Modifier.fillMaxSize()) {
        LongPressBaseScaffold(sessions)
        SessionActionsSheet(
            session = sessions.first(),
            laptopName = "dev-macbook",
            onDismiss = {},
            onAttach = {},
            onKill = {},
        )
    }
}
