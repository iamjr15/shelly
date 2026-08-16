package app.shelly.android.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.snap
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.shelly.android.BuildConfig
import app.shelly.android.core.AndroidBiometricGate
import app.shelly.android.core.ConnectionState
import app.shelly.android.core.MobileSession
import app.shelly.android.core.MobileTelemetry
import app.shelly.android.core.PairedDaemonRecord
import app.shelly.android.core.ShellyAlertMessage
import app.shelly.android.core.ShellyUiState
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.core.displayName
import app.shelly.android.features.lock.LockedScreen
import app.shelly.android.features.modals.AlertSheet
import app.shelly.android.features.modals.NotificationPermissionSheet
import app.shelly.android.features.modals.TelemetrySheet
import app.shelly.android.features.modals.UnpairSheet
import app.shelly.android.features.onboarding.GetStartedScreen
import app.shelly.android.features.onboarding.HowItWorksScreen
import app.shelly.android.features.onboarding.PrivacyScreen
import app.shelly.android.features.onboarding.WelcomeScreen
import app.shelly.android.features.pairing.PairingScreen
import app.shelly.android.features.pairing.PairingUiState
import app.shelly.android.features.palette.CommandPaletteScreen
import app.shelly.android.features.sessions.DaemonUnreachablePreview
import app.shelly.android.features.sessions.DaemonUnreachableScaffold
import app.shelly.android.features.sessions.ReconnectingPreview
import app.shelly.android.features.sessions.ReconnectingScaffold
import app.shelly.android.features.sessions.SessionsGroupedPreview
import app.shelly.android.features.sessions.SessionsScreen
import app.shelly.android.features.settings.AboutScreen
import app.shelly.android.features.settings.AppearanceScreen
import app.shelly.android.features.settings.DaemonDetailScreen
import app.shelly.android.features.settings.LicensesScreen
import app.shelly.android.features.settings.licenseDependencyCount
import app.shelly.android.features.settings.NotificationsScreen
import app.shelly.android.features.settings.OpenSourceLicensesScreen
import app.shelly.android.features.settings.SecurityScreen
import app.shelly.android.features.settings.SettingsScreen
import app.shelly.android.features.terminal.TerminalScreen
import app.shelly.android.ui.theme.ShellyMotion
import app.shelly.android.ui.theme.ShellyTheme
import kotlinx.coroutines.launch
import kotlin.math.max

private const val SHELLY_REPOSITORY_URL = "https://github.com/iamjr15/shelly"
private const val PROTOCOL_VERSION_FALLBACK = "v3"

@Composable
fun ShellyApp(
    viewModel: ShellyViewModel,
    biometricGate: AndroidBiometricGate,
    shouldRequestNotifications: () -> Boolean = { true },
    onRequestNotifications: () -> Unit = {},
) {
    val context = LocalContext.current
    val uiPrefs = remember(context) { ShellyUiPreferences(context) }
    val state by viewModel.state.collectAsState()
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    val systemDark = isSystemInDarkTheme()

    var onboarded by rememberSaveable { mutableStateOf(uiPrefs.readOnboarded()) }
    var onboardingStack by rememberSaveable(
        stateSaver = listSaver<List<ShellyOnboardingStep>, String>(
            save = { stack -> stack.map(ShellyOnboardingStep::name) },
            restore = { names -> names.map(ShellyOnboardingStep::valueOf) },
        ),
    ) { mutableStateOf(listOf(ShellyOnboardingStep.Welcome)) }
    val settings = remember(uiPrefs) { ShellySettings(uiPrefs) }
    var route by rememberSaveable { mutableStateOf(ShellyRoute.Sessions) }
    var commandPaletteVisible by rememberSaveable { mutableStateOf(false) }
    var searchRequestToken by rememberSaveable { mutableStateOf(0) }
    var showUnpairSheet by rememberSaveable { mutableStateOf(false) }
    var notificationPromptVisible by rememberSaveable { mutableStateOf(false) }
    var notificationPromptSeenThisLaunch by rememberSaveable { mutableStateOf(false) }
    var telemetryEnabled by rememberSaveable { mutableStateOf(MobileTelemetry.isDiagnosticsEnabled(context)) }
    var unlockUnavailableMessage by remember { mutableStateOf(biometricGate.unlockUnavailableMessage()) }

    val surface = shellySurfaceFor(
        onboarded = onboarded,
        state = state,
        route = route,
    )
    var lastAlertMessage by remember { mutableStateOf<ShellyAlertMessage?>(null) }

    val onToggleTelemetry = {
        val next = !telemetryEnabled
        MobileTelemetry.setDiagnosticsEnabled(context, next)
        telemetryEnabled = next
    }

    // Keep the biometric gate's idle timeout + enabled flag in sync with settings. Runs during
    // composition (before the unlock effect below) so a disabled lock never prompts on cold start.
    remember(settings.autoLock, settings.biometricLock) {
        biometricGate.configure(settings.autoLock.millis, settings.biometricLock)
    }

    LaunchedEffect(onboarded, state.paired, state.restoringPairing) {
        if (shouldUseBiometricGate(onboarded, state) && !state.unlocked) {
            viewModel.setUnlocked(biometricGate.unlock("Unlock Shelly"))
        }
    }
    LaunchedEffect(onboarded, state.paired, state.unlocked) {
        if (
            onboarded &&
            state.paired &&
            state.unlocked &&
            !notificationPromptSeenThisLaunch &&
            shouldRequestNotifications()
        ) {
            notificationPromptSeenThisLaunch = true
            notificationPromptVisible = true
        }
    }
    LaunchedEffect(state.paired, state.unlocked) {
        if (!state.paired || !state.unlocked) {
            route = ShellyRoute.Sessions
            commandPaletteVisible = false
            showUnpairSheet = false
        }
    }
    LaunchedEffect(state.message) {
        state.message?.let { lastAlertMessage = it }
    }
    DisposableEffect(lifecycleOwner, biometricGate, viewModel, onboarded) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> {
                    if (settings.blockOnBackground) {
                        AndroidBiometricGate.markBackgrounded()
                    }
                    viewModel.onAppBackgrounded()
                }
                Lifecycle.Event.ON_RESUME -> {
                    unlockUnavailableMessage = biometricGate.unlockUnavailableMessage()
                    viewModel.onAppForegrounded()
                    if (
                        shouldUseBiometricGate(onboarded, viewModel.state.value) &&
                        biometricGate.shouldLockOnResume
                    ) {
                        viewModel.setUnlocked(false)
                        scope.launch { viewModel.setUnlocked(biometricGate.unlock("Unlock Shelly")) }
                    }
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    ShellyTheme(
        darkTheme = settings.themeMode.resolvedDark(systemDark),
        animationsEnabled = !settings.reduceMotion,
    ) {
        val c = ShellyTheme.colors
        // Scale every sp text globally by the chosen text-size (on top of the system fontScale).
        CompositionLocalProvider(
            LocalDensity provides Density(
                LocalDensity.current.density,
                LocalDensity.current.fontScale * settings.textSize.scale,
            ),
        ) {
            Box(Modifier.fillMaxSize().background(c.screen)) {
                val motionEnabled = ShellyTheme.motionEnabled
                AnimatedContent(
                    targetState = surface,
                    transitionSpec = {
                        shellyHorizontalTransform(
                            forward = targetState.motionDepth >= initialState.motionDepth,
                            motionEnabled = motionEnabled,
                        )
                    },
                    modifier = Modifier.fillMaxSize(),
                    label = "shellySurfaceTransition",
                ) { targetSurface ->
                    when (targetSurface) {
                        ShellySurface.Onboarding -> OnboardingFlow(
                            step = onboardingStack.last(),
                            canGoBack = onboardingStack.size > 1,
                            onPush = { step -> onboardingStack = onboardingStack + step },
                            onBack = {
                                if (onboardingStack.size > 1) {
                                    onboardingStack = onboardingStack.dropLast(1)
                                }
                            },
                            onComplete = {
                                uiPrefs.writeOnboarded(true)
                                onboarded = true
                                route = ShellyRoute.Sessions
                            },
                        )
                        ShellySurface.Locked -> LockedScreen(
                            onUnlock = {
                                unlockUnavailableMessage = biometricGate.unlockUnavailableMessage()
                                scope.launch { viewModel.setUnlocked(biometricGate.unlock("Unlock Shelly")) }
                            },
                            unavailableMessage = unlockUnavailableMessage,
                        )
                        ShellySurface.RestoringPairing -> CenterSpinner()
                        ShellySurface.Pairing -> PairingScreen(
                            pairing = state.loading,
                            onPair = viewModel::pair,
                            onPairWithCode = viewModel::pairWithCode,
                            onCancelPairing = viewModel::cancelPairing,
                            uiState = state.pairingError?.let {
                                PairingUiState.Error(message = it.message, detail = it.detail)
                            } ?: PairingUiState.Idle,
                        )
                        ShellySurface.Terminal -> {
                            val activeSessionId = state.activeTerminalSessionId
                            if (activeSessionId == null || state.terminalTabs.isEmpty()) {
                                CenterSpinner()
                            } else {
                                TerminalScreen(
                                    sessions = state.sessions,
                                    tabs = state.terminalTabs,
                                    activeSessionId = activeSessionId,
                                    viewModel = viewModel,
                                    biometricGate = biometricGate,
                                    onSelectTab = viewModel::openTerminalSession,
                                    onCloseTab = viewModel::closeTerminalTab,
                                    onNewSession = { viewModel.createSession() },
                                    onBack = viewModel::closeTerminalSession,
                                )
                            }
                        }
                        is ShellySurface.Routed -> RoutedContent(
                            route = targetSurface.route,
                            settings = settings,
                            telemetryEnabled = telemetryEnabled,
                            viewModel = viewModel,
                            biometricGate = biometricGate,
                            connectionState = state.connectionState,
                            sessions = state.sessions,
                            pairedDaemon = state.pairedDaemon,
                            laptopName = state.pairedDaemon.displayName(),
                            onRoute = { route = it },
                            onToggleTelemetry = onToggleTelemetry,
                            onOpenPalette = { commandPaletteVisible = true },
                            searchRequestToken = searchRequestToken,
                            onUnpair = { showUnpairSheet = true },
                        )
                    }
                }

                if (commandPaletteVisible && onboarded && state.paired && state.unlocked && state.activeTerminalSessionId == null) {
                    CommandPaletteScreen(
                        modifier = Modifier.fillMaxSize(),
                        onDismiss = { commandPaletteVisible = false },
                        onAttachSession = {
                            commandPaletteVisible = false
                            attachFirstSession(state.sessions, biometricGate, viewModel, scope)
                        },
                        onNewSession = {
                            commandPaletteVisible = false
                            scope.launch {
                                if (biometricGate.unlock("Create new session")) {
                                    viewModel.createSession()
                                }
                            }
                        },
                        onSearchSessions = {
                            commandPaletteVisible = false
                            route = ShellyRoute.Sessions
                            searchRequestToken += 1
                        },
                        onLockNow = {
                            commandPaletteVisible = false
                            viewModel.setUnlocked(false)
                        },
                        onOpenSettings = {
                            commandPaletteVisible = false
                            route = ShellyRoute.Settings
                        },
                        onShowGroupedSessions = {
                            commandPaletteVisible = false
                            route = ShellyRoute.SessionsGrouped
                        },
                        onShowReconnecting = {
                            commandPaletteVisible = false
                            route = ShellyRoute.SessionsReconnecting
                        },
                        onShowDaemonUnreachable = {
                            commandPaletteVisible = false
                            route = ShellyRoute.SessionsDaemonUnreachable
                        },
                    )
                }

                ShellyModalOverlay(visible = showUnpairSheet, onDismiss = { showUnpairSheet = false }) {
                    UnpairSheet(
                        daemonLabel = state.pairedDaemon.displayName(),
                        liveSessions = state.sessions.size,
                        onConfirm = {
                            showUnpairSheet = false
                            route = ShellyRoute.Sessions
                            viewModel.unpair()
                        },
                        onDismiss = { showUnpairSheet = false },
                    )
                }
                ShellyModalOverlay(
                    visible = state.telemetryConsentPromptVisible,
                    onDismiss = {
                        viewModel.answerTelemetryConsent(false)
                        telemetryEnabled = MobileTelemetry.isDiagnosticsEnabled(context)
                    },
                ) {
                    TelemetrySheet(
                        onConfirm = {
                            viewModel.answerTelemetryConsent(true)
                            telemetryEnabled = MobileTelemetry.isDiagnosticsEnabled(context)
                        },
                        onDismiss = {
                            viewModel.answerTelemetryConsent(false)
                            telemetryEnabled = MobileTelemetry.isDiagnosticsEnabled(context)
                        },
                    )
                }
                ShellyModalOverlay(visible = notificationPromptVisible, onDismiss = { notificationPromptVisible = false }) {
                    NotificationPermissionSheet(
                        onConfirm = {
                            notificationPromptVisible = false
                            onRequestNotifications()
                        },
                        onDismiss = { notificationPromptVisible = false },
                    )
                }
                ShellyModalOverlay(visible = state.message != null, onDismiss = viewModel::clearMessage) {
                    lastAlertMessage?.let { message ->
                        AlertSheet(
                            message = message,
                            onConfirm = {
                                viewModel.clearMessage()
                                if (state.paired && state.unlocked) {
                                    viewModel.refreshSessions()
                                }
                            },
                            onDismiss = viewModel::clearMessage,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RoutedContent(
    route: ShellyRoute,
    settings: ShellySettings,
    telemetryEnabled: Boolean,
    viewModel: ShellyViewModel,
    biometricGate: AndroidBiometricGate,
    connectionState: ConnectionState,
    sessions: List<MobileSession>,
    pairedDaemon: PairedDaemonRecord?,
    laptopName: String,
    onRoute: (ShellyRoute) -> Unit,
    onToggleTelemetry: () -> Unit,
    onOpenPalette: () -> Unit,
    searchRequestToken: Int,
    onUnpair: () -> Unit,
) {
    val context = LocalContext.current
    when (route) {
        ShellyRoute.Sessions -> SessionsScreen(
            viewModel = viewModel,
            biometricGate = biometricGate,
            onOpenSession = viewModel::openTerminalSession,
            onOpenSettings = { onRoute(ShellyRoute.Settings) },
            onToggleTheme = settings::cycleTheme,
            onOpenCommandPalette = onOpenPalette,
            searchRequestToken = searchRequestToken,
        )
        ShellyRoute.Settings -> {
            BackHandler { onRoute(ShellyRoute.Sessions) }
            SettingsScreen(
                padding = PaddingValues(0.dp),
                viewModel = viewModel,
                themeModeLabel = settings.themeMode.label.uppercase(),
                notificationsLabel = if (settings.pushEnabled) "ON" else "OFF",
                securityLabel = settings.autoLock.label.uppercase(),
                aboutVersionLabel = "V${BuildConfig.VERSION_NAME}",
                onBackToSessions = { onRoute(ShellyRoute.Sessions) },
                onOpenAppearance = { onRoute(ShellyRoute.Appearance) },
                onOpenNotifications = { onRoute(ShellyRoute.Notifications) },
                onOpenSecurity = { onRoute(ShellyRoute.Security) },
                onOpenAbout = { onRoute(ShellyRoute.About) },
                onOpenDaemonDetail = { onRoute(ShellyRoute.DaemonDetail) },
                onUnpair = onUnpair,
            )
        }
        ShellyRoute.Appearance -> {
            BackHandler { onRoute(ShellyRoute.Settings) }
            AppearanceScreen(
                onBack = { onRoute(ShellyRoute.Settings) },
                themeModeLabel = settings.themeMode.label,
                textSizeLabel = settings.textSize.label,
                reduceMotionOn = settings.reduceMotion,
                onOpenTheme = settings::cycleTheme,
                onOpenTextSize = settings::cycleTextSize,
                onToggleReduceMotion = settings::toggleReduceMotion,
            )
        }
        ShellyRoute.Notifications -> {
            BackHandler { onRoute(ShellyRoute.Settings) }
            NotificationsScreen(
                onBack = { onRoute(ShellyRoute.Settings) },
                pushOn = settings.pushEnabled,
                awaitingInputOn = settings.notifyAwaitingInput,
                sessionCrashedOn = settings.notifySessionCrashed,
                buildFinishedOn = settings.notifyBuildFinished,
                onTogglePush = {
                    settings.togglePush()
                    viewModel.setPushEnabled(settings.pushEnabled)
                },
                onToggleAwaitingInput = settings::toggleNotifyAwaiting,
                onToggleSessionCrashed = settings::toggleNotifySessionCrashed,
                onToggleBuildFinished = settings::toggleNotifyBuildFinished,
            )
        }
        ShellyRoute.Security -> {
            BackHandler { onRoute(ShellyRoute.Settings) }
            SecurityScreen(
                onBack = { onRoute(ShellyRoute.Settings) },
                telemetryEnabled = telemetryEnabled,
                biometricLockOn = settings.biometricLock,
                autoLockLabel = settings.autoLock.label,
                blockOnBackgroundOn = settings.blockOnBackground,
                onToggleBiometricLock = settings::toggleBiometricLock,
                onCycleAutoLock = settings::cycleAutoLock,
                onToggleBlockOnBackground = settings::toggleBlockOnBackground,
                onToggleTelemetry = onToggleTelemetry,
            )
        }
        ShellyRoute.Privacy -> {
            BackHandler { onRoute(ShellyRoute.About) }
            PrivacyScreen(
                onContinue = { onRoute(ShellyRoute.About) },
                onSkip = { onRoute(ShellyRoute.About) },
                inSettings = true,
            )
        }
        ShellyRoute.About -> {
            BackHandler { onRoute(ShellyRoute.Settings) }
            AboutScreen(
                onBack = { onRoute(ShellyRoute.Settings) },
                version = BuildConfig.VERSION_NAME,
                build = BuildConfig.VERSION_CODE.toString(),
                protocol = protocolLabel(pairedDaemon),
                dependencyCount = licenseDependencyCount,
                onOpenPrivacy = { onRoute(ShellyRoute.Privacy) },
                onOpenSource = { openUrl(context, SHELLY_REPOSITORY_URL) },
                onOpenLicenses = { onRoute(ShellyRoute.Licenses) },
            )
        }
        ShellyRoute.DaemonDetail -> {
            BackHandler { onRoute(ShellyRoute.Settings) }
            DaemonDetailScreen(
                onBack = { onRoute(ShellyRoute.Settings) },
                hostName = pairedDaemon.displayName(),
                pairedAge = pairedAgeLabel(pairedDaemon?.pairedAtMillis),
                daemon = pairedDaemon?.daemonVersion?.takeIf { it.isNotBlank() }
                    ?.let { "shellyd $it" } ?: "shellyd",
                protocol = protocolLabel(pairedDaemon),
                transport = if (pairedDaemon?.relayUrl != null) "iroh QUIC (relay)" else "iroh QUIC",
                onUnpair = onUnpair,
            )
        }
        ShellyRoute.Licenses -> {
            BackHandler { onRoute(ShellyRoute.About) }
            LicensesScreen(
                onBack = { onRoute(ShellyRoute.About) },
                dependencyCount = licenseDependencyCount,
                onOpenLicense = { onRoute(ShellyRoute.OpenSourceLicenses) },
            )
        }
        ShellyRoute.OpenSourceLicenses -> {
            BackHandler { onRoute(ShellyRoute.Licenses) }
            OpenSourceLicensesScreen(
                padding = PaddingValues(0.dp),
                onBack = { onRoute(ShellyRoute.Licenses) },
            )
        }
        ShellyRoute.SessionsGrouped -> {
            BackHandler { onRoute(ShellyRoute.Sessions) }
            SessionsGroupedPreview()
        }
        ShellyRoute.SessionsReconnecting -> {
            BackHandler { onRoute(ShellyRoute.Sessions) }
            when (val connection = connectionState) {
                is ConnectionState.Reconnecting -> ReconnectingScaffold(
                    reconnecting = connection,
                    sessions = sessions,
                    laptopName = laptopName,
                    onRetry = viewModel::retryConnectionNow,
                )
                // Reached via the debug command palette without a live drop — show sample data.
                else -> ReconnectingPreview()
            }
        }
        ShellyRoute.SessionsDaemonUnreachable -> {
            BackHandler { onRoute(ShellyRoute.Sessions) }
            when (val connection = connectionState) {
                is ConnectionState.Unreachable -> DaemonUnreachableScaffold(
                    unreachable = connection,
                    laptopName = laptopName,
                    onRetry = viewModel::retryConnectionNow,
                )
                // Reached via the debug command palette without a live drop — show sample data.
                else -> DaemonUnreachablePreview()
            }
        }
    }
}

@Composable
private fun OnboardingFlow(
    step: ShellyOnboardingStep,
    canGoBack: Boolean,
    onPush: (ShellyOnboardingStep) -> Unit,
    onBack: () -> Unit,
    onComplete: () -> Unit,
) {
    BackHandler(enabled = canGoBack, onBack = onBack)
    val motionEnabled = ShellyTheme.motionEnabled
    AnimatedContent(
        targetState = step,
        transitionSpec = {
            shellyHorizontalTransform(
                forward = targetState.ordinal >= initialState.ordinal,
                motionEnabled = motionEnabled,
            )
        },
        modifier = Modifier.fillMaxSize(),
        label = "onboardingStepTransition",
    ) { targetStep ->
        when (targetStep) {
            ShellyOnboardingStep.Welcome -> WelcomeScreen(
                onContinue = { onPush(ShellyOnboardingStep.HowItWorks) },
                onPairLaptop = { onPush(ShellyOnboardingStep.HowItWorks) },
                onHowItWorks = { onPush(ShellyOnboardingStep.HowItWorks) },
                onPrivacy = { onPush(ShellyOnboardingStep.Privacy) },
            )
            ShellyOnboardingStep.HowItWorks -> HowItWorksScreen(
                onContinue = { onPush(ShellyOnboardingStep.Privacy) },
                onSkip = { onPush(ShellyOnboardingStep.Privacy) },
            )
            ShellyOnboardingStep.Privacy -> PrivacyScreen(
                onContinue = { onPush(ShellyOnboardingStep.GetStarted) },
                onSkip = { onPush(ShellyOnboardingStep.GetStarted) },
            )
            ShellyOnboardingStep.GetStarted -> GetStartedScreen(onPairLaptop = onComplete)
        }
    }
}

@Composable
private fun CenterSpinner() {
    val c = ShellyTheme.colors
    Box(Modifier.fillMaxSize().background(c.content), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = c.accent)
    }
}

@Composable
private fun ShellyModalOverlay(
    visible: Boolean,
    onDismiss: () -> Unit,
    content: @Composable () -> Unit,
) {
    BackHandler(enabled = visible, onBack = onDismiss)
    val motionEnabled = ShellyTheme.motionEnabled
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
        AnimatedVisibility(
            visible = visible,
            enter = fadeIn(animationSpec = ShellyMotion.fastSpec()),
            exit = fadeOut(animationSpec = ShellyMotion.fastSpec()),
        ) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.58f))
                    .clickable(onClick = onDismiss),
            )
        }
        AnimatedVisibility(
            visible = visible,
            enter = slideInVertically(
                animationSpec = if (motionEnabled) ShellyMotion.routeTween() else snap(),
                initialOffsetY = { it / 3 },
            ) + fadeIn(animationSpec = ShellyMotion.fastSpec()),
            exit = slideOutVertically(
                animationSpec = if (motionEnabled) ShellyMotion.routeTween() else snap(),
                targetOffsetY = { it / 3 },
            ) + fadeOut(animationSpec = ShellyMotion.fastSpec()),
            modifier = Modifier.align(Alignment.BottomCenter),
        ) {
            Box(
                Modifier
                    .padding(bottom = 28.dp)
                    .clip(RoundedCornerShape(24.dp)),
            ) {
                content()
            }
        }
    }
}

internal sealed interface ShellySurface {
    val motionDepth: Int

    data object Onboarding : ShellySurface {
        override val motionDepth = 0
    }

    data object RestoringPairing : ShellySurface {
        override val motionDepth = 1
    }

    data object Pairing : ShellySurface {
        override val motionDepth = 1
    }

    data class Routed(val route: ShellyRoute) : ShellySurface {
        override val motionDepth = 2 + route.motionDepth
    }

    data object Terminal : ShellySurface {
        override val motionDepth = 10
    }

    data object Locked : ShellySurface {
        override val motionDepth = 11
    }
}

internal fun shellySurfaceFor(
    onboarded: Boolean,
    state: ShellyUiState,
    route: ShellyRoute,
): ShellySurface = when {
    !onboarded -> ShellySurface.Onboarding
    state.restoringPairing -> ShellySurface.RestoringPairing
    !state.paired -> ShellySurface.Pairing
    !state.unlocked -> ShellySurface.Locked
    // Terminal keeps priority: never interrupt an attached session with a connection screen.
    state.activeTerminalSessionId != null -> ShellySurface.Terminal
    state.connectionState is ConnectionState.Unreachable ->
        ShellySurface.Routed(ShellyRoute.SessionsDaemonUnreachable)
    state.connectionState is ConnectionState.Reconnecting ->
        ShellySurface.Routed(ShellyRoute.SessionsReconnecting)
    else -> ShellySurface.Routed(route)
}

internal fun shouldUseBiometricGate(onboarded: Boolean, state: ShellyUiState): Boolean =
    onboarded && !state.restoringPairing && state.paired

private val ShellyRoute.motionDepth: Int
    get() = when (this) {
        ShellyRoute.Sessions,
        ShellyRoute.SessionsGrouped,
        ShellyRoute.SessionsReconnecting,
        ShellyRoute.SessionsDaemonUnreachable,
        -> 0
        ShellyRoute.Settings -> 1
        ShellyRoute.Appearance,
        ShellyRoute.Notifications,
        ShellyRoute.Security,
        ShellyRoute.Privacy,
        ShellyRoute.About,
        ShellyRoute.DaemonDetail,
        -> 2
        ShellyRoute.Licenses -> 3
        ShellyRoute.OpenSourceLicenses -> 4
    }

private fun <S> AnimatedContentTransitionScope<S>.shellyHorizontalTransform(
    forward: Boolean,
    motionEnabled: Boolean,
) = if (!motionEnabled) {
    fadeIn(animationSpec = snap()).togetherWith(fadeOut(animationSpec = snap())).using(SizeTransform(clip = false))
} else {
    (
        fadeIn(animationSpec = ShellyMotion.fastTween()) +
            slideIntoContainer(
                towards = if (forward) {
                    AnimatedContentTransitionScope.SlideDirection.Left
                } else {
                    AnimatedContentTransitionScope.SlideDirection.Right
                },
                animationSpec = ShellyMotion.routeTween(),
            )
        ).togetherWith(
        fadeOut(animationSpec = ShellyMotion.fastTween()) +
            slideOutOfContainer(
                towards = if (forward) {
                    AnimatedContentTransitionScope.SlideDirection.Left
                } else {
                    AnimatedContentTransitionScope.SlideDirection.Right
                },
                animationSpec = ShellyMotion.routeTween(),
            ),
    ).using(SizeTransform(clip = false))
}

private fun attachFirstSession(
    sessions: List<MobileSession>,
    biometricGate: AndroidBiometricGate,
    viewModel: ShellyViewModel,
    scope: kotlinx.coroutines.CoroutineScope,
) {
    val session = sessions.firstOrNull()
    if (session == null) {
        viewModel.refreshSessions()
        return
    }
    scope.launch {
        if (biometricGate.unlock("Open terminal session")) {
            viewModel.openTerminalSession(session)
        }
    }
}

private fun pairedAgeLabel(pairedAtMillis: Long?): String {
    val pairedAt = pairedAtMillis ?: return "unknown"
    val ageMillis = max(0L, System.currentTimeMillis() - pairedAt)
    val days = ageMillis / (24L * 60L * 60L * 1000L)
    val hours = ageMillis / (60L * 60L * 1000L)
    return when {
        days > 0 -> "${days}d"
        hours > 0 -> "${hours}h"
        else -> "today"
    }
}

private fun protocolLabel(record: PairedDaemonRecord?): String =
    record?.protocolVersion?.takeIf { it != 0 }?.let { "v$it" } ?: PROTOCOL_VERSION_FALLBACK

private fun openUrl(context: Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }.recoverCatching { error ->
        if (error !is ActivityNotFoundException) throw error
    }
}
