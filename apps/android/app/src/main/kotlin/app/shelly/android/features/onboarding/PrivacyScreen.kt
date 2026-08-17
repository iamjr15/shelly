package app.shelly.android.features.onboarding

import androidx.compose.runtime.Composable

private val PrivacySteps = listOf(
    OnboardingStepContent("Keys never leave", "Generated on-device, kept in the Android Keystore"),
    OnboardingStepContent("The relay is blind", "It forwards sealed packets — never your terminal bytes"),
    OnboardingStepContent("Revoke in one command", "shelly devices remove cuts a phone off instantly"),
)

@Composable
fun PrivacyScreen(
    onContinue: () -> Unit = {},
    onSkip: () -> Unit = {},
    inSettings: Boolean = false,
) {
    OnboardingStepsScreen(
        eyebrow = "WHERE YOUR KEYS AND\nBYTES ACTUALLY LIVE",
        wordmark = "SAFE",
        trailing = if (inSettings) "Settings" else "SKIP",
        onTrailingClick = onSkip,
        trailingAsEscape = inSettings,
        status = OnboardingStatus(
            icon = OnboardingStatusIcon.Lock,
            text = "end-to-end encrypted",
        ),
        steps = PrivacySteps,
        footerLabel = if (inSettings) "Done" else "Got it",
        onContinue = onContinue,
    )
}
