package app.shelly.android.features.onboarding

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun PrivacyScreen(
    onContinue: () -> Unit = {},
    onSkip: () -> Unit = {},
) {
    OnboardingShell(
        hero = {
            OnboardingHero(
                eyebrow = "WHERE YOUR KEYS AND\nBYTES ACTUALLY LIVE",
                wordmark = "SAFE",
                trailing = "SKIP",
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
                detail = "Generated on-device, kept in the\nAndroid Keystore",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 2,
                title = "The relay is blind",
                detail = "It forwards sealed packets — never your\nterminal bytes",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 3,
                title = "Revoke in one command",
                detail = "shelly devices remove cuts a phone off\ninstantly",
                showDivider = false,
            )
            Spacer(Modifier.weight(1f))
            OnboardingFooterLink(
                label = "Got it",
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
