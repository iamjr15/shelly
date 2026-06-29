package app.shelly.android.features.onboarding

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun PrivacyScreen(
    onContinue: () -> Unit = {},
    onSkip: () -> Unit = {},
    inSettings: Boolean = false,
) {
    OnboardingShell(
        hero = {
            OnboardingHero(
                eyebrow = "WHERE YOUR KEYS AND\nBYTES ACTUALLY LIVE",
                wordmark = "SAFE",
                trailing = if (inSettings) "Settings" else "SKIP",
                onTrailingClick = onSkip,
                status = OnboardingStatus(
                    icon = OnboardingStatusIcon.Lock,
                    text = "end-to-end encrypted",
                ),
            )
        },
        content = {
            OnboardingStepRow(
                number = 1,
                title = "Keys never leave",
                detail = "Generated on-device, kept in the Android Keystore",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 2,
                title = "The relay is blind",
                detail = "It forwards sealed packets — never your terminal bytes",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 3,
                title = "Revoke in one command",
                detail = "shelly devices remove cuts a phone off instantly",
                showDivider = false,
            )
            Spacer(Modifier.weight(1f))
            OnboardingFooterLink(
                label = if (inSettings) "Done" else "Got it",
                onClick = onContinue,
                strongDivider = true,
            )
        },
    )
}

@Composable
internal fun PrivacyContentPreview() {
    PrivacyScreen()
}
