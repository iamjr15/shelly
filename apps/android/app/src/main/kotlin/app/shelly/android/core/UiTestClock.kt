package app.shelly.android.core

/** Wall-clock source for UI that renders the current time. */
internal object UiTestClock {
    var nowMillis: () -> Long = { System.currentTimeMillis() }
}
