# Shelly Android — Paper → Compose implementation guide (for codex)

You implement Shelly's Android screens **pixel-perfect** from the Paper design file, using the existing
design system. Read this whole file first, then the referenced source files, then the Paper design,
then implement and verify with the screenshot harness.

## Hard rules
1. **Pixel-perfect to Paper.** Pull the exact design from the **paper MCP** (don't guess). Match
   structure, spacing, fonts, sizes, colors, radii, opacities. Use the paper MCP tools:
   `get_guide({topic:"paper-mcp-instructions"})` once, then `get_basic_info`, `find_nodes`,
   `get_children`, `get_jsx({format:"inline-styles"})`, `get_computed_styles`, `get_screenshot`.
   Read exact values from `get_jsx`/`get_computed_styles`, never from screenshots.
2. **Reuse the design system. Do NOT reinvent tokens or re-add Material chrome** (no Scaffold,
   TopAppBar, SegmentedButton, OutlinedTextField, Card, etc.). Compose with the components below.
3. **Both modes.** The screen must look right in dark AND light (theme drives colors via
   `ShellyTheme.colors`; never hardcode hex unless the Paper value is mode-independent, e.g. the
   orange accent or a camera viewport).
4. **Keep all functional logic** (ViewModel calls, camera, biometric, navigation lambdas). Only
   the presentation changes. Preserve each screen's existing public composable signature unless it
   must change; if it changes, update the caller in `ui/ShellyApp.kt`.
5. **Verify with the harness before claiming done** (see below). The build must pass and the PNG
   must visually match the Paper artboard.
6. Do **NOT** run any `adb`, device, or `gradlew install*` commands. JVM harness only.

## Design system (study these files)
- `app/src/main/kotlin/app/shelly/android/ui/components/Components.kt`
  - `ShellyScreen(modifier, heroHeight = 313.dp, hero: @Composable ColumnScope.() -> Unit, content: @Composable ColumnScope.() -> Unit)`
    = black screen bg, 16dp inset, rounded 24dp card stack: hero (313dp) over a content card that
    fills the rest. Hero padding 24h / 24top / 28bottom; content padding 24h / 18top / 24bottom.
  - `ColumnScope.HeroBody(eyebrow, wordmark, wordmarkSize = ShellyType.wordmark.fontSize, brandTrailing, below)`
    = brand row (▲ SHELLY + trailing) pinned top, flexible min-8dp spacer, then eyebrow → wordmark
    (cap-height boxed, all-caps) → optional below(). Wordmark size is per-screen (Sessions/Pairing
    use 132.sp; longer words are smaller — match Paper).
  - `BrandRow(trailing)`, `TriangleLogo`, `IconCircleButton(icon, contentDescription, onClick)` (32dp
    circle, surfaceSubtle bg), `StatusDot(state)`, `DoubleChevron`, `Chevron`, `SessionRow`, `StateChip`.
- `app/src/main/kotlin/app/shelly/android/ui/theme/Theme.kt` — `ShellyTheme.colors: ShellyColors`:
  `screen, hero, heroWordmark, content, insetCard, modalCard, textPrimary, textMuted, accent`
  (orange `#E85D29`), `onAccent, divider, surfaceSubtle, statusAwaiting/Working/Idle/Crashed,
  buttonPrimary, onButtonPrimary, destructive, isDark`. Also `ShellyDimens` (screenInset 16, cardRadius
  24, heroHeight 313, paddings 24). `ShellyTheme(darkTheme) { ... }` wraps content.
- `app/src/main/kotlin/app/shelly/android/ui/theme/Type.kt` — `ShellyType`: `wordmark, brand, eyebrow,
  rowTitle, itemTitle, heading, mono, monoSmall, microLabel, button, chip`. Variable Inter + JetBrains
  Mono. For tight display type use `.copy(...)` + the existing `platformStyle(includeFontPadding=false)`.
- **Reference screen (already pixel-perfect): `features/sessions/SessionsScreen.kt`.** Copy its
  conventions exactly, including the stateless `SessionsContentPreview` at the bottom (a `@Composable
  internal fun` that renders the populated screen with passed-in data and no-op lambdas, for the harness).

## Screenshot harness (how to verify)
- Shared renderer: `app/src/test/kotlin/app/shelly/android/screenshots/ScreenshotHarness.kt`
  → `ScreenshotHarness.render(name, dark, content)` writes `apps/android/screenshots/<name>.png`.
- For each screen add a stateless `@Composable internal fun <Screen>ContentPreview(...)` **in the
  screen's own file** (mock data, no-op lambdas, camera/io disabled), then add a **new test class**
  `app/src/test/kotlin/app/shelly/android/screenshots/<Screen>ScreenshotTest.kt`:
  ```kotlin
  @RunWith(RobolectricTestRunner::class)
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  @Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
  class <Screen>ScreenshotTest {
      @Test fun <screen>_dark() = ScreenshotHarness.render("<screen>_dark", true) { <Screen>ContentPreview(...) }
      @Test fun <screen>_light() = ScreenshotHarness.render("<screen>_light", false) { <Screen>ContentPreview(...) }
  }
  ```
- Run: `cd apps/android && SHELLY_ANDROID_BIOMETRIC_BYPASS=true ./gradlew :app:testDebugUnitTest --tests "*<Screen>ScreenshotTest*"`.
  Then open the PNG(s) and compare against the Paper `get_screenshot` of the artboard. Iterate until they match.
- Don't edit `ScreenshotTests.kt` or other screens' test classes (avoid conflicts) — only your own.

## Paper artboard map (dark id / light id · name)
Sessions 4IE-0 / 2KC-0 (DONE) · Pairing 5JB-0 / 2RS-0 · Terminal — 2OE-0 (light only base; states: Attaching 3RC-0, Locked 3SW-0, Exited 3UJ-0, Claude TUI 334-0) ·
Locked 53B-0 / 2LP-0 · Empty 5KJ-0 / 2WI-0 ·
Settings 4KW-0 / 2PR-0 · Appearance 4VE-0 / 3YA-0 · Notifications 4WP-0 / 40B-0 · Security 4Y0-0 / 42C-0 · About 4ZJ-0 / 44D-0 · Daemon detail 4TX-0 / 3W9-0 · Licenses 50U-0 / 46E-0 ·
Welcome 526-0 / 2J8-0 · How it works 5SS-0 / 2VD-0 · Privacy 5XD-0 / 48F-0 · Get started 5YG-0 / 49D-0 ·
Search 5VK-0 / 3I9-0 · Grouped 5PL-0 / 3FF-0 · Daemon unreachable 5RP-0 / 3OD-0 · Reconnecting 54J-0 / 35V-0 · Long-press 55R-0 / 3L2-0 ·
Command palette 5TQ-0 / 2ZO-0 ·
Unpair 593-0 / 37G-0 · Telemetry 5ZL-0 / 4AB-0 · Alert 622-0 / 4D0-0 · Notification permission 64N-0 / 4FP-0 ·
Pairing Connecting 5N7-0 / 3C7-0 · Pairing Camera denied 5LX-0 / 3AT-0 · Pairing error 5OD-0 / 3E3-0

Open the file with paper MCP `get_basic_info` to confirm ids; artboards are 412×892. Implement the
**dark** artboard as the source of truth and confirm the **light** mode render also matches the light artboard.

## Done = build passes + both PNGs match Paper + functional logic preserved + caller (ShellyApp) still compiles.
Report: files changed, harness result, PNG paths, and any intentional deviation.
