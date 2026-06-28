package app.shelly.android.features.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun WelcomeScreen(
    onContinue: () -> Unit = {},
    onPairLaptop: () -> Unit = {},
    onHowItWorks: () -> Unit = {},
    onPrivacy: () -> Unit = {},
) {
    OnboardingShell(
        hero = {
            WelcomeHero()
        },
        content = {
            Spacer(Modifier.height(2.dp))
            Column(
                verticalArrangement = Arrangement.spacedBy(20.dp),
                modifier = Modifier.height(124.dp),
            ) {
                WelcomeMenuRow("Pair your laptop", onPairLaptop)
                WelcomeMenuRow("How it works", onHowItWorks)
                WelcomeMenuRow("Privacy", onPrivacy)
            }
            Spacer(Modifier.height(24.dp))
            Spacer(Modifier.weight(1f))
            OnboardingFooterLink(
                label = "Get started",
                onClick = onContinue,
                strongDivider = false,
                welcomeWeight = true,
            )
        },
    )
}

@Composable
internal fun WelcomeContentPreview() {
    WelcomeScreen()
}
