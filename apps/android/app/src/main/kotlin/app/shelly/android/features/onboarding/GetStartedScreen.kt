package app.shelly.android.features.onboarding

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun GetStartedScreen(
    onPairLaptop: () -> Unit = {},
) {
    OnboardingShell(
        hero = {
            OnboardingHero(
                eyebrow = "YOU'RE SET — LET'S\nPAIR YOUR LAPTOP",
                wordmark = "GO",
                trailing = "STEP 4 / 4",
                onTrailingClick = {},
                status = OnboardingStatus(
                    icon = OnboardingStatusIcon.Scanner,
                    text = "scan to pair",
                ),
            )
        },
        content = {
            OnboardingStepRow(
                number = 1,
                title = "Pair once",
                detail = "Scan the QR or type the 5-char code",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 2,
                title = "Attach anything",
                detail = "Any shell, agent, or TUI your laptop\nruns",
                showDivider = true,
            )
            OnboardingStepRow(
                number = 3,
                title = "Work from your phone",
                detail = "Offline-ok, 2-second resume",
                showDivider = false,
            )
            Spacer(Modifier.weight(1f))
            OnboardingFooterLink(
                label = "Pair your laptop",
                onClick = onPairLaptop,
                strongDivider = true,
            )
        },
    )
}

@Composable
internal fun GetStartedContentPreview() {
    GetStartedScreen()
}
