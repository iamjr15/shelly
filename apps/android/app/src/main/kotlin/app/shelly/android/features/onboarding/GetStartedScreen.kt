package app.shelly.android.features.onboarding

import androidx.compose.runtime.Composable

private val GetStartedSteps = listOf(
    OnboardingStepContent("Pair once", "Scan the QR or type the 5-char code"),
    OnboardingStepContent("Attach anything", "Any shell, agent, or TUI your computer\nruns"),
    OnboardingStepContent("Work from your phone", "Offline-ok, 2-second resume"),
)

@Composable
fun GetStartedScreen(
    onPairLaptop: () -> Unit = {},
) {
    OnboardingStepsScreen(
        eyebrow = "YOU'RE SET — LET'S\nPAIR YOUR COMPUTER",
        wordmark = "GO",
        trailing = "STEP 4 / 4",
        onTrailingClick = null,
        status = OnboardingStatus(
            icon = OnboardingStatusIcon.Scanner,
            text = "scan to pair",
        ),
        steps = GetStartedSteps,
        footerLabel = "Pair your computer",
        onContinue = onPairLaptop,
    )
}
