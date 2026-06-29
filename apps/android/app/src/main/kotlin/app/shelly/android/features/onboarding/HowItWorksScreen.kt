package app.shelly.android.features.onboarding

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun HowItWorksScreen(
    onContinue: () -> Unit = {},
    onSkip: () -> Unit = {},
) {
    OnboardingShell(
        hero = {
            OnboardingHero(
                eyebrow = "WHAT HAPPENS THE MOMENT\nYOU PAIR A LAPTOP",
                wordmark = "HOW",
                trailing = "SKIP",
                onTrailingClick = onSkip,
            )
        },
        content = {
            OnboardingStepRow(
                number = 1,
                title = "Pair once",
                detail = "QR handshake — keys never leave your\ntwo devices",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 2,
                title = "The daemon streams",
                detail = "Every shell, agent, and TUI — live to\nyour phone",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 3,
                title = "You attach",
                detail = "Tap in and type. Offline-ok, 2-sec\nresume",
                showDivider = false,
            )
            Spacer(Modifier.weight(1f))
            OnboardingFooterLink(
                label = "I’m ready",
                onClick = onContinue,
                strongDivider = true,
            )
        },
    )
}

@Composable
internal fun HowItWorksContentPreview() {
    HowItWorksScreen()
}
