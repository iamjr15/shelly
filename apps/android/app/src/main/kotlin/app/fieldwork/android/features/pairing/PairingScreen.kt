package app.fieldwork.android.features.pairing

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
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.core.content.ContextCompat
import app.fieldwork.android.BuildConfig
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/** Crockford base32 alphabet shared with the daemon/protocol (no I/L/O/U confusables). */
private const val CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
private const val CODE_LEN = 5

private enum class PairMethod { SCAN, CODE }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(
    padding: PaddingValues,
    pairing: Boolean,
    onPair: (String) -> Unit,
    onPairWithCode: (String) -> Unit,
) {
    val context = LocalContext.current
    // A debug code preselects the Enter-code tab so manual smoke runs skip the camera.
    val debugCode = remember { debugPairingCode() }
    var method by remember {
        mutableStateOf(if (debugCode.isNotEmpty()) PairMethod.CODE else PairMethod.SCAN)
    }
    var code by remember { mutableStateOf(debugCode) }
    var cameraGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        cameraGranted = it
    }

    LaunchedEffect(method) {
        if (method == PairMethod.SCAN && !cameraGranted) launcher.launch(Manifest.permission.CAMERA)
    }

    Scaffold(
        modifier = Modifier.padding(padding),
        topBar = { TopAppBar(title = { Text("Pair") }) },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp),
        ) {
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                SegmentedButton(
                    selected = method == PairMethod.SCAN,
                    onClick = { method = PairMethod.SCAN },
                    shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                    icon = { Icon(Icons.Default.QrCodeScanner, contentDescription = null) },
                ) {
                    Text("Scan QR")
                }
                SegmentedButton(
                    selected = method == PairMethod.CODE,
                    onClick = { method = PairMethod.CODE },
                    shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                    icon = { Icon(Icons.Default.Keyboard, contentDescription = null) },
                ) {
                    Text("Enter code")
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            when (method) {
                PairMethod.SCAN -> {
                    if (cameraGranted) {
                        QrCamera(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(320.dp),
                            onPayload = { if (!pairing) onPair(it.trim()) },
                        )
                    } else {
                        Text("Camera permission is required to scan the pairing QR.")
                    }
                }
                PairMethod.CODE -> {
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = normalizeCodeInput(it) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        label = { Text("Pairing code") },
                        supportingText = { Text("$CODE_LEN characters from the desktop") },
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.Characters,
                            keyboardType = KeyboardType.Ascii,
                            imeAction = ImeAction.Done,
                        ),
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Button(
                        onClick = { onPairWithCode(code) },
                        enabled = code.length == CODE_LEN && !pairing,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.Keyboard, contentDescription = null)
                        Text("Pair")
                    }
                }
            }
        }
    }
}

/** Uppercases, applies Crockford aliases (I/L->1, O->0), drops non-alphabet chars, caps at CODE_LEN. */
private fun normalizeCodeInput(input: String): String {
    val builder = StringBuilder(CODE_LEN)
    for (raw in input) {
        if (builder.length >= CODE_LEN) break
        val ch = when (raw.uppercaseChar()) {
            'I', 'L' -> '1'
            'O' -> '0'
            else -> raw.uppercaseChar()
        }
        if (ch in CODE_ALPHABET) builder.append(ch)
    }
    return builder.toString()
}

private fun debugPairingCode(): String =
    if (BuildConfig.DEBUG) normalizeCodeInput(BuildConfig.FIELDWORK_DEBUG_PAIRING_CODE) else ""

@Composable
private fun QrCamera(modifier: Modifier = Modifier, onPayload: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }

    DisposableEffect(Unit) {
        onDispose { executor.shutdown() }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val providerFuture = ProcessCameraProvider.getInstance(ctx)
            providerFuture.addListener(
                {
                    val provider = providerFuture.get()
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
                val value = codes.firstOrNull { it.valueType == Barcode.TYPE_TEXT }?.rawValue
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
