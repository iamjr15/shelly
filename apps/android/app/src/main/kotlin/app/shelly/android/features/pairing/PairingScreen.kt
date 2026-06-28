package app.shelly.android.features.pairing

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColor
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.updateTransition
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.shelly.android.BuildConfig
import app.shelly.android.ui.components.HeroBody
import app.shelly.android.ui.components.ShellyScreen
import app.shelly.android.ui.theme.ShellyMotion
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType
import app.shelly.android.ui.theme.shellyPressScale
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.sin

sealed interface PairingUiState {
    data object Idle : PairingUiState
    data object Connecting : PairingUiState
    data object CameraDenied : PairingUiState
    data class Error(
        val message: String = "That pairing code expired or was already used.",
        val detail: String = "Run `shelly pair` on your laptop for a fresh code.",
    ) : PairingUiState
}

@Suppress("UNUSED_PARAMETER")
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PairingScreen(
    padding: PaddingValues,
    pairing: Boolean,
    onPair: (String) -> Unit,
    onPairWithCode: (String) -> Unit,
    uiState: PairingUiState = PairingUiState.Idle,
) {
    val context = LocalContext.current
    val debugCode = remember { debugPairingCode() }
    var code by remember {
        mutableStateOf(TextFieldValue(debugCode, selection = TextRange(debugCode.length)))
    }
    var cameraGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        cameraGranted = it
    }

    LaunchedEffect(Unit) {
        if (!cameraGranted) launcher.launch(Manifest.permission.CAMERA)
    }

    val resolvedState = when {
        pairing -> PairingUiState.Connecting
        !cameraGranted -> PairingUiState.CameraDenied
        else -> uiState
    }

    PairingContent(
        code = code,
        onCodeChange = { value ->
            val normalized = normalizePairingCodeInput(value.text)
            code = TextFieldValue(normalized, selection = TextRange(normalized.length))
        },
        cameraGranted = cameraGranted,
        showCamera = true,
        pairing = pairing,
        uiState = resolvedState,
        onPair = { payload ->
            val trimmed = payload.trim()
            if (!pairing && trimmed.isNotEmpty()) onPair(trimmed)
        },
        onPairWithCode = onPairWithCode,
    )
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun PairingContent(
    code: TextFieldValue,
    onCodeChange: (TextFieldValue) -> Unit,
    cameraGranted: Boolean,
    showCamera: Boolean,
    pairing: Boolean,
    uiState: PairingUiState,
    onPair: (String) -> Unit,
    onPairWithCode: (String) -> Unit,
) {
    val c = ShellyTheme.colors
    val codeFocusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    val requestCodeFocus: () -> Unit = {
        codeFocusRequester.requestFocus()
        keyboardController?.show()
    }
    val submitCode: () -> Unit = {
        if (isCompletePairingCode(code.text) && !pairing) {
            onPairWithCode(code.text)
        } else {
            requestCodeFocus()
        }
    }

    val hero = pairingHeroSpec(uiState)

    ShellyScreen(
        hero = {
            Crossfade(
                targetState = hero,
                animationSpec = ShellyMotion.standardTween(),
                label = "pairingHeroCrossfade",
                modifier = Modifier.weight(1f),
            ) { targetHero ->
                Column(Modifier.fillMaxSize()) {
                    HeroBody(
                        eyebrow = targetHero.eyebrow,
                        wordmark = targetHero.wordmark,
                        wordmarkSize = 132.sp,
                        brandTrailing = {
                            Text(
                                targetHero.trailing,
                                style = ShellyType.monoSmall.copy(
                                    fontWeight = FontWeight(600),
                                    letterSpacing = 0.04.em,
                                ),
                                color = c.textPrimary,
                            )
                        },
                    )
                }
            }
        },
        content = {
            Spacer(Modifier.height(2.dp))
            Crossfade(
                targetState = uiState,
                animationSpec = ShellyMotion.standardTween(),
                label = "pairingStateCrossfade",
                modifier = Modifier.weight(1f).fillMaxWidth(),
            ) { targetState ->
                Column(Modifier.fillMaxSize()) {
                when (targetState) {
                    PairingUiState.Connecting -> ConnectingBody()
                    PairingUiState.Idle -> ManualPairingBody(
                        code = code,
                        onCodeChange = onCodeChange,
                        codeFocusRequester = codeFocusRequester,
                        requestCodeFocus = requestCodeFocus,
                        submitCode = submitCode,
                        cameraGranted = cameraGranted,
                        showCamera = showCamera,
                        onPair = onPair,
                    )
                    PairingUiState.CameraDenied -> ManualPairingBody(
                        code = code,
                        onCodeChange = onCodeChange,
                        codeFocusRequester = codeFocusRequester,
                        requestCodeFocus = requestCodeFocus,
                        submitCode = submitCode,
                        cameraGranted = false,
                        showCamera = false,
                        onPair = onPair,
                        viewport = PairingViewport.CameraDenied,
                        codeLabel = "ENTER THE 5-CHAR CODE",
                    )
                    is PairingUiState.Error -> ManualPairingBody(
                        code = code,
                        onCodeChange = onCodeChange,
                        codeFocusRequester = codeFocusRequester,
                        requestCodeFocus = requestCodeFocus,
                        submitCode = submitCode,
                        cameraGranted = false,
                        showCamera = false,
                        onPair = onPair,
                        viewport = PairingViewport.Error(targetState.message, targetState.detail),
                        codeLabel = "ENTER THE NEW CODE",
                        hint = "use the fresh 5-char code from your laptop",
                    )
                }
                }
            }
        },
    )
}

private data class PairingHeroSpec(
    val eyebrow: String,
    val wordmark: String,
    val trailing: String,
)

private fun pairingHeroSpec(uiState: PairingUiState): PairingHeroSpec = when (uiState) {
    PairingUiState.Idle -> PairingHeroSpec(
        eyebrow = "RUN SHELLY PAIR ON YOUR\nLAPTOP · POINT YOUR PHONE",
        wordmark = "PAIR",
        trailing = "STEP 1 / 2",
    )
    PairingUiState.Connecting -> PairingHeroSpec(
        eyebrow = "SECURING THE TUNNEL —\nALMOST THERE",
        wordmark = "LINK",
        trailing = "PAIRING",
    )
    PairingUiState.CameraDenied -> PairingHeroSpec(
        eyebrow = "CAMERA'S BLOCKED —\nTYPE THE CODE INSTEAD",
        wordmark = "PAIR",
        trailing = "PAIRING",
    )
    is PairingUiState.Error -> PairingHeroSpec(
        eyebrow = "THAT CODE EXPIRED —\nGET A FRESH ONE",
        wordmark = "VOID",
        trailing = "PAIRING",
    )
}

private sealed interface PairingViewport {
    data object Camera : PairingViewport
    data object CameraDenied : PairingViewport
    data class Error(val message: String, val detail: String) : PairingViewport
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun ColumnScope.ManualPairingBody(
    code: TextFieldValue,
    onCodeChange: (TextFieldValue) -> Unit,
    codeFocusRequester: FocusRequester,
    requestCodeFocus: () -> Unit,
    submitCode: () -> Unit,
    cameraGranted: Boolean,
    showCamera: Boolean,
    onPair: (String) -> Unit,
    viewport: PairingViewport = PairingViewport.Camera,
    codeLabel: String = "CAN'T SCAN? ENTER THE CODE",
    hint: String = "shelly pair shows the QR + code",
) {
    Crossfade(
        targetState = viewport,
        animationSpec = ShellyMotion.standardTween(),
        label = "pairingViewportCrossfade",
    ) { targetViewport ->
        when (targetViewport) {
            PairingViewport.Camera -> CameraViewport(
                cameraGranted = cameraGranted,
                showCamera = showCamera,
                onPayload = onPair,
            )
            PairingViewport.CameraDenied -> CameraDeniedViewport()
            is PairingViewport.Error -> ErrorViewport(targetViewport.message, targetViewport.detail)
        }
    }
    Spacer(Modifier.height(16.dp))
    CodeLabelRow(label = codeLabel)
    PairingCodeCells(
        code = code,
        onCodeChange = onCodeChange,
        focusRequester = codeFocusRequester,
        requestFocus = requestCodeFocus,
        submit = submitCode,
    )
    CodeHintRow(hint = hint)
    Spacer(Modifier.weight(1f))
    PairButton(
        onClick = submitCode,
        modifier = Modifier.offset(y = 2.dp),
    )
}

@Composable
private fun ColumnScope.ConnectingBody() {
    ConnectingViewport()
    LinkChecklist()
    Spacer(Modifier.weight(1f))
    GhostPairingAction("Cancel pairing")
}

@Composable
private fun CameraViewport(
    cameraGranted: Boolean,
    showCamera: Boolean,
    onPayload: (String) -> Unit,
) {
    val c = ShellyTheme.colors
    val scanProgress: Float
    val bracketProgress: Float
    if (ShellyTheme.motionEnabled) {
        val scanner = rememberInfiniteTransition(label = "pairingScanner")
        val animatedScanProgress by scanner.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = androidx.compose.animation.core.tween(
                    durationMillis = 1900,
                    easing = ShellyMotion.Linear,
                ),
                repeatMode = RepeatMode.Restart,
            ),
            label = "pairingScanProgress",
        )
        val animatedBracketProgress by scanner.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = androidx.compose.animation.core.tween(
                    durationMillis = 2200,
                    easing = ShellyMotion.Linear,
                ),
                repeatMode = RepeatMode.Restart,
            ),
            label = "pairingBracketBreath",
        )
        scanProgress = animatedScanProgress
        bracketProgress = animatedBracketProgress
    } else {
        scanProgress = 0f
        bracketProgress = 0f
    }
    val bracketAlpha = 1f - sin(bracketProgress * PI).toFloat().coerceAtLeast(0f) * 0.16f
    Box(
        Modifier
            .fillMaxWidth()
            .height(200.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(Color(0xFF0B0D0C))
            .cameraGradient()
            .semantics {
                contentDescription = if (cameraGranted) {
                    "QR pairing camera"
                } else {
                    "$PAIRING_CAMERA_DENIED_BODY $PAIRING_CAMERA_DENIED_ACTION."
                }
            },
    ) {
        if (showCamera && cameraGranted) {
            QrCamera(
                modifier = Modifier.fillMaxSize(),
                onPayload = onPayload,
            )
            ScannerLine(
                progress = scanProgress,
                color = c.accent,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Reticle(
            color = c.accent.copy(alpha = bracketAlpha),
            modifier = Modifier
                .align(Alignment.Center)
                .size(140.dp),
        )
    }
}

@Composable
private fun ScannerLine(progress: Float, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val alpha = sin(progress * PI).toFloat().coerceAtLeast(0f) * 0.26f
        if (alpha <= 0.001f) return@Canvas
        val y = size.height * (0.22f + 0.56f * progress)
        drawLine(
            color = color.copy(alpha = alpha),
            start = Offset(size.width * 0.18f, y),
            end = Offset(size.width * 0.82f, y),
            strokeWidth = 1.dp.toPx(),
            cap = StrokeCap.Round,
        )
    }
}

private fun Modifier.cameraGradient(): Modifier = this.then(
    Modifier.drawWithCache {
        val center = Offset(size.width * 0.3f, size.height * 0.4f)
        val radius = maxOf(
            hypot(center.x, center.y),
            hypot(size.width - center.x, center.y),
            hypot(center.x, size.height - center.y),
            hypot(size.width - center.x, size.height - center.y),
        )
        val brush = Brush.radialGradient(
            colorStops = arrayOf(
                0f to Color(0xFF2A332F),
                0.6f to Color(0xFF14191A),
                1f to Color(0xFF0B0D0C),
            ),
            center = center,
            radius = radius,
        )
        onDrawBehind { drawRect(brush) }
    },
)

@Composable
private fun Reticle(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val strokeWidth = 2.5.dp.toPx()
        val inset = strokeWidth / 2f
        val arm = 26.dp.toPx()
        val w = size.width
        val h = size.height
        val style = Stroke(
            width = strokeWidth,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )

        fun drawBracket(points: List<Offset>) {
            val path = Path().apply {
                moveTo(points.first().x, points.first().y)
                points.drop(1).forEach { lineTo(it.x, it.y) }
            }
            drawPath(path, color = color, style = style)
        }

        drawBracket(listOf(Offset(inset, arm), Offset(inset, inset), Offset(arm, inset)))
        drawBracket(listOf(Offset(w - arm, inset), Offset(w - inset, inset), Offset(w - inset, arm)))
        drawBracket(listOf(Offset(inset, h - arm), Offset(inset, h - inset), Offset(arm, h - inset)))
        drawBracket(listOf(Offset(w - arm, h - inset), Offset(w - inset, h - inset), Offset(w - inset, h - arm)))
    }
}

@Composable
private fun ConnectingViewport() {
    PairingStatusViewport(gap = 16.dp) {
        ProgressRing()
        Text(
            "Handshaking with your laptop",
            style = ShellyType.button.copy(
                fontSize = 16.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight(600),
                letterSpacing = 0.em,
            ),
            color = Color(0xFFF0EDE6),
        )
        Text(
            "node_01k9c4f3hg",
            style = ShellyType.monoSmall.copy(
                fontWeight = FontWeight(500),
                lineHeight = 15.sp,
            ),
            color = Color(0xFF9AA29B),
        )
    }
}

@Composable
private fun CameraDeniedViewport() {
    PairingStatusViewport(gap = 12.dp) {
        CameraOffGlyph(Modifier.size(46.dp))
        Text(
            "Camera access is off",
            style = ShellyType.button.copy(
                fontSize = 16.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight(600),
                letterSpacing = 0.em,
            ),
            color = Color(0xFFF0EDE6),
        )
        PairingStatusPill("ENABLE IN SETTINGS")
    }
}

@Composable
private fun ErrorViewport(message: String, detail: String) {
    PairingStatusViewport(gap = 12.dp) {
        ErrorClockGlyph(Modifier.size(44.dp))
        Text(
            message,
            style = ShellyType.button.copy(
                fontSize = 15.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight(600),
                letterSpacing = 0.em,
            ),
            color = Color(0xFFF0EDE6),
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        Text(
            detail,
            style = ShellyType.monoSmall.copy(
                fontWeight = FontWeight(500),
                lineHeight = 15.sp,
            ),
            color = Color(0xFF9AA29B),
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
    }
}

@Composable
private fun PairingStatusViewport(
    gap: androidx.compose.ui.unit.Dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(200.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(Color(0xFF0B0D0C))
            .cameraGradient(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(gap),
            content = content,
        )
    }
}

@Composable
private fun ProgressRing(modifier: Modifier = Modifier) {
    val accent = ShellyTheme.colors.accent
    val rotation = if (ShellyTheme.motionEnabled) {
        val spin = rememberInfiniteTransition(label = "pairingProgressRing")
        val animatedRotation by spin.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(
                animation = androidx.compose.animation.core.tween(
                    durationMillis = 1050,
                    easing = ShellyMotion.Linear,
                ),
                repeatMode = RepeatMode.Restart,
            ),
            label = "pairingProgressRotation",
        )
        animatedRotation
    } else {
        0f
    }
    Canvas(modifier.size(60.dp).rotate(rotation)) {
        val strokeWidth = 5.dp.toPx()
        drawCircle(
            color = accent.copy(alpha = 0.22f),
            radius = 26.dp.toPx(),
            center = Offset(size.width / 2f, size.height / 2f),
            style = Stroke(width = strokeWidth),
        )
        drawArc(
            color = accent,
            startAngle = -90f,
            sweepAngle = 123f,
            useCenter = false,
            topLeft = Offset(4.dp.toPx(), 4.dp.toPx()),
            size = androidx.compose.ui.geometry.Size(52.dp.toPx(), 52.dp.toPx()),
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round),
        )
    }
}

@Composable
private fun CameraOffGlyph(modifier: Modifier = Modifier) {
    val accent = ShellyTheme.colors.accent
    Canvas(modifier) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        val stroke = Stroke(
            width = 1.6f * sx,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )
        val videoPath = Path().apply {
            moveTo(23f * sx, 7f * sy)
            lineTo(16f * sx, 12f * sy)
            lineTo(23f * sx, 17f * sy)
            close()
        }
        drawPath(videoPath, color = accent, style = stroke)
        drawRoundRect(
            color = accent,
            topLeft = Offset(1f * sx, 5f * sy),
            size = androidx.compose.ui.geometry.Size(15f * sx, 14f * sy),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(2f * sx, 2f * sy),
            style = stroke,
        )
        drawLine(
            color = accent,
            start = Offset(2f * sx, 2f * sy),
            end = Offset(22f * sx, 22f * sy),
            strokeWidth = 1.8f * sx,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun ErrorClockGlyph(modifier: Modifier = Modifier) {
    val accent = ShellyTheme.colors.accent
    Canvas(modifier) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        val stroke = Stroke(
            width = 1.8f * sx,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )
        val center = Offset(12f * sx, 12f * sy)
        drawCircle(
            color = accent,
            radius = 10f * sx,
            center = center,
            style = stroke,
        )
        val hand = Path().apply {
            moveTo(12f * sx, 7f * sy)
            lineTo(12f * sx, 12f * sy)
            lineTo(15f * sx, 14f * sy)
        }
        drawPath(hand, color = accent, style = stroke)
    }
}

@Composable
private fun PairingStatusPill(text: String) {
    val c = ShellyTheme.colors
    Row(
        Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(c.accent.copy(alpha = 0.16f))
            .border(1.dp, c.accent, RoundedCornerShape(999.dp))
            .padding(horizontal = 14.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = ShellyType.monoSmall.copy(
                fontSize = 12.sp,
                lineHeight = 14.sp,
                fontWeight = FontWeight(700),
                letterSpacing = 0.04.em,
            ),
            color = c.accent,
        )
    }
}

@Composable
private fun LinkChecklist() {
    Column {
        LinkChecklistRow("Node found", "12ms", completed = true, active = false)
        LinkChecklistRow("Keys verified", "Ed25519", completed = true, active = false)
        LinkChecklistRow("Opening tunnel…", "iroh", completed = false, active = true)
    }
}

@Composable
private fun LinkChecklistRow(
    label: String,
    trailing: String,
    completed: Boolean,
    active: Boolean,
) {
    val c = ShellyTheme.colors
    val pulse = if (active && ShellyTheme.motionEnabled) {
        val transition = rememberInfiniteTransition(label = "pairingChecklistPulse")
        val alpha by transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.68f,
            animationSpec = infiniteRepeatable(
                animation = androidx.compose.animation.core.tween(
                    durationMillis = 900,
                    easing = ShellyMotion.EmphasizedEasing,
                ),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "pairingChecklistAlpha",
        )
        alpha
    } else {
        1f
    }
    Row(
        Modifier
            .fillMaxWidth()
            .graphicsLayer { alpha = pulse }
            .padding(vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ChecklistStatusIcon(completed = completed)
        Text(
            label,
            style = ShellyType.rowTitle.copy(
                fontWeight = FontWeight(if (active) 600 else 500),
                lineHeight = 22.sp,
            ),
            color = c.textPrimary,
            modifier = Modifier.weight(1f),
        )
        Text(
            trailing,
            style = ShellyType.monoSmall.copy(fontWeight = FontWeight(if (active) 700 else 500)),
            color = if (active) c.accent else {
                (if (c.isDark) c.textMuted else c.textPrimary).copy(alpha = 0.4f)
            },
        )
    }
}

@Composable
private fun ChecklistStatusIcon(completed: Boolean) {
    val c = ShellyTheme.colors
    Canvas(Modifier.size(20.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        if (completed) {
            drawCircle(
                color = c.textPrimary,
                radius = 10f * sx,
                center = Offset(12f * sx, 12f * sy),
            )
            val check = Path().apply {
                moveTo(8f * sx, 12f * sy)
                lineTo(11f * sx, 15f * sy)
                lineTo(16f * sx, 9f * sy)
            }
            drawPath(
                path = check,
                color = c.accent,
                style = Stroke(
                    width = 2.2f * sx,
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                ),
            )
        } else {
            drawCircle(
                color = c.accent,
                radius = 10f * sx,
                center = Offset(12f * sx, 12f * sy),
                style = Stroke(width = 2.2f * sx),
            )
        }
    }
}

@Composable
private fun GhostPairingAction(text: String, modifier: Modifier = Modifier) {
    val c = ShellyTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .offset(y = 2.dp)
            .padding(15.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = ShellyType.button.copy(
                fontSize = 16.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight(600),
                letterSpacing = 0.em,
            ),
            color = c.textPrimary.copy(alpha = 0.55f),
        )
    }
}

@Composable
private fun ColumnScope.CodeLabelRow(label: String = "CAN'T SCAN? ENTER THE CODE") {
    val c = ShellyTheme.colors
    val labelBase = if (c.isDark) c.textMuted else c.textPrimary
    Row(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            label,
            style = ShellyType.microLabel,
            color = labelBase.copy(alpha = 0.6f),
        )
        Text(
            "$PAIRING_CODE_LENGTH CHARS",
            style = ShellyType.monoSmall.copy(
                fontSize = 11.sp,
                lineHeight = 14.sp,
                fontWeight = FontWeight(500),
                letterSpacing = 0.04.em,
            ),
            color = labelBase.copy(alpha = 0.4f),
        )
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun PairingCodeCells(
    code: TextFieldValue,
    onCodeChange: (TextFieldValue) -> Unit,
    focusRequester: FocusRequester,
    requestFocus: () -> Unit,
    submit: () -> Unit,
) {
    BasicTextField(
        value = code,
        onValueChange = onCodeChange,
        singleLine = true,
        textStyle = ShellyType.mono.copy(
            color = Color.Transparent,
            fontSize = 28.sp,
            lineHeight = 34.sp,
            fontWeight = FontWeight(600),
        ),
        cursorBrush = SolidColor(Color.Transparent),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Characters,
            keyboardType = KeyboardType.Ascii,
            imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(onDone = { submit() }),
        modifier = Modifier
            .fillMaxWidth()
            .focusRequester(focusRequester),
        decorationBox = { innerTextField ->
            Box(Modifier.fillMaxWidth()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(onClick = requestFocus),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    repeat(PAIRING_CODE_LENGTH) { index ->
                        val char = code.text.getOrNull(index)?.toString()
                        val active = index == code.text.length && code.text.length < PAIRING_CODE_LENGTH
                        PairingCodeCell(
                            char = char,
                            active = active,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
                Box(Modifier.size(0.dp)) {
                    innerTextField()
                }
            }
        },
    )
}

@Composable
private fun PairingCodeCell(
    char: String?,
    active: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = ShellyTheme.colors
    val target = PairingCodeCellState(active = active, filled = char != null)
    val transition = updateTransition(targetState = target, label = "pairingCodeCell")
    val borderColor by transition.animateColor(
        transitionSpec = { ShellyMotion.standardTween() },
        label = "pairingCodeCellBorder",
    ) { state ->
        when {
            state.active -> c.accent
            state.filled -> if (c.isDark) c.textPrimary.copy(alpha = 0.14f) else c.textPrimary
            else -> c.divider
        }
    }
    val borderWidth by transition.animateDp(
        transitionSpec = { ShellyMotion.standardTween() },
        label = "pairingCodeCellBorderWidth",
    ) { state ->
        if (state.active) 2.dp else 1.5.dp
    }
    val caretAlpha = if (active && char == null && ShellyTheme.motionEnabled) {
        val caret = rememberInfiniteTransition(label = "pairingCaret")
        val alpha by caret.animateFloat(
            initialValue = 1f,
            targetValue = 0.2f,
            animationSpec = infiniteRepeatable(
                animation = androidx.compose.animation.core.tween(
                    durationMillis = 760,
                    easing = ShellyMotion.EmphasizedEasing,
                ),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "pairingCaretAlpha",
        )
        alpha
    } else if (active && char == null) {
        1f
    } else {
        0f
    }

    Box(
        modifier
            .height(64.dp)
            .clip(RoundedCornerShape(12.dp))
            .border(borderWidth, borderColor, RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            char != null -> Text(
                char,
                style = ShellyType.mono.copy(
                    fontSize = 28.sp,
                    lineHeight = 34.sp,
                    fontWeight = FontWeight(600),
                ),
                color = c.textPrimary,
            )
            active -> Text(
                "|",
                style = ShellyType.mono.copy(
                    fontSize = 28.sp,
                    lineHeight = 34.sp,
                    fontWeight = FontWeight(600),
                ),
                color = c.accent.copy(alpha = caretAlpha),
            )
        }
    }
}

private data class PairingCodeCellState(
    val active: Boolean,
    val filled: Boolean,
)

@Composable
private fun ColumnScope.CodeHintRow(hint: String = "shelly pair shows the QR + code") {
    val c = ShellyTheme.colors
    val hintBase = if (c.isDark) c.textMuted else c.textPrimary
    Row(
        Modifier.padding(top = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(15.dp), contentAlignment = Alignment.Center) {
            MonitorGlyph(hintBase.copy(alpha = 0.55f))
        }
        Text(
            hint,
            style = ShellyType.monoSmall.copy(fontWeight = FontWeight(500)),
            color = hintBase.copy(alpha = 0.55f),
        )
    }
}

@Composable
private fun MonitorGlyph(color: Color) {
    Canvas(Modifier.size(15.dp)) {
        val strokeWidth = 1.25.dp.toPx()
        val style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val left = size.width * 0.125f
        val top = size.height * 0.17f
        val right = size.width * 0.875f
        val bottom = size.height * 0.67f
        val radius = 1.25.dp.toPx()
        drawRoundRect(
            color = color,
            topLeft = Offset(left, top),
            size = androidx.compose.ui.geometry.Size(right - left, bottom - top),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius, radius),
            style = style,
        )
        val standY = size.height * 0.86f
        drawLine(
            color = color,
            start = Offset(size.width * 0.34f, standY),
            end = Offset(size.width * 0.66f, standY),
            strokeWidth = strokeWidth,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun PairButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = ShellyTheme.colors
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.975f)
    Row(
        modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(RoundedCornerShape(14.dp))
            .background(c.buttonPrimary)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 16.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
    ) {
        Icon(
            Icons.Default.Check,
            contentDescription = null,
            tint = c.onButtonPrimary,
            modifier = Modifier.size(20.dp),
        )
        Text(
            "Pair this phone",
            style = ShellyType.button.copy(
                fontSize = 18.sp,
                lineHeight = 24.sp,
                letterSpacing = 0.em,
            ),
            color = c.onButtonPrimary,
        )
    }
}

@Composable
internal fun PairingContentPreview(uiState: PairingUiState = PairingUiState.Idle) {
    var code by remember {
        mutableStateOf(TextFieldValue("K29", selection = TextRange(3)))
    }
    PairingContent(
        code = code,
        onCodeChange = { value ->
            val normalized = normalizePairingCodeInput(value.text)
            code = TextFieldValue(normalized, selection = TextRange(normalized.length))
        },
        cameraGranted = false,
        showCamera = false,
        pairing = false,
        uiState = uiState,
        onPair = {},
        onPairWithCode = {},
    )
}

@Composable
internal fun PairingConnectingContentPreview() {
    PairingContentPreview(uiState = PairingUiState.Connecting)
}

@Composable
internal fun PairingCameraDeniedContentPreview() {
    PairingContentPreview(uiState = PairingUiState.CameraDenied)
}

@Composable
internal fun PairingErrorContentPreview() {
    PairingContentPreview(
        uiState = PairingUiState.Error(
            message = "That pairing code expired or was already used.",
            detail = "Run `shelly pair` on your laptop for a fresh code.",
        ),
    )
}

private fun debugPairingCode(): String =
    if (BuildConfig.DEBUG) normalizePairingCodeInput(BuildConfig.SHELLY_DEBUG_PAIRING_CODE) else ""

@Composable
private fun QrCamera(modifier: Modifier = Modifier, onPayload: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val disposed = remember { booleanArrayOf(false) }
    val providerRef = remember { arrayOfNulls<ProcessCameraProvider>(1) }

    DisposableEffect(Unit) {
        onDispose {
            disposed[0] = true
            providerRef[0]?.unbindAll()
            executor.shutdown()
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val previewView = PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
            }
            val providerFuture = ProcessCameraProvider.getInstance(ctx)
            providerFuture.addListener(
                {
                    val provider = providerFuture.get()
                    if (disposed[0]) return@addListener
                    providerRef[0] = provider
                    val preview = androidx.camera.core.Preview.Builder().build().also {
                        it.setSurfaceProvider(previewView.surfaceProvider)
                    }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                        .also { it.setAnalyzer(executor, QrAnalyzer(onPayload)) }
                    provider.unbindAll()
                    provider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                },
                ContextCompat.getMainExecutor(context),
            )
            previewView
        },
    )
}

private class QrAnalyzer(private val onPayload: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val scanner = BarcodeScanning.getClient()
    private var emitted = false

    @SuppressLint("UnsafeOptInUsageError")
    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage == null || emitted) {
            imageProxy.close()
            return
        }
        val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
        scanner.process(image)
            .addOnSuccessListener { codes ->
                val value = codes.firstNotNullOfOrNull { it.rawValue?.takeIf(String::isNotBlank) }
                if (!value.isNullOrBlank()) {
                    emitted = true
                    onPayload(value)
                }
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }
}
