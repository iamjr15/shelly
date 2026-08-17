package app.shelly.android.features.onboarding

import androidx.compose.runtime.Composable

private val HowItWorksSteps = listOf(
    OnboardingStepContent("Pair once", "QR handshake — keys never leave your\ntwo devices"),
    OnboardingStepContent("The daemon streams", "Every shell, agent, and TUI — live to\nyour phone"),
    OnboardingStepContent("You attach", "Tap in and type. Offline-ok, 2-sec\nresume"),
)

@Composable
fun HowItWorksScreen(
    onContinue: () -> Unit = {},
    onSkip: () -> Unit = {},
) {
    OnboardingStepsScreen(
        eyebrow = "WHAT HAPPENS THE MOMENT\nYOU PAIR A COMPUTER",
        wordmark = "HOW",
        trailing = "SKIP",
        onTrailingClick = onSkip,
        steps = HowItWorksSteps,
        footerLabel = "I’m ready",
        onContinue = onContinue,
    )
}
