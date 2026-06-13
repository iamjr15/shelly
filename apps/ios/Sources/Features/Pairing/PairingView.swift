import AVFoundation
import SwiftUI

struct PairingView: View {
    private enum PairMethod: Hashable {
        case scan
        case code
    }

    @EnvironmentObject private var model: AppModel
    @State private var method: PairMethod = .scan
    @State private var manualCode = ""
    @State private var isPairing = false

    /// Crockford base32 alphabet (no `I`/`L`/`O`/`U`); matches the protocol code helper.
    private static let codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private static let codeLength = 5

    var body: some View {
        VStack(spacing: 18) {
            Picker("Pairing method", selection: $method) {
                Text("Scan QR").tag(PairMethod.scan)
                Text("Enter code").tag(PairMethod.code)
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Pairing method")

            switch method {
            case .scan:
                scannerSection
            case .code:
                codeSection
            }

            Spacer()
        }
        .padding()
        .navigationTitle("Pair")
    }

    private var scannerSection: some View {
        QRScannerView { payload in
            Task {
                await pairWithQr(payload)
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(alignment: .bottom) {
            Text("Scan Shelly QR")
                .font(.headline)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(.thinMaterial)
        }
        .accessibilityLabel("Scan Shelly QR")
    }

    private var codeSection: some View {
        VStack(spacing: 18) {
            Text("Enter the 5-character code shown on your desktop.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            TextField("ABC12", text: $manualCode)
                .font(.system(.largeTitle, design: .monospaced))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .textContentType(.oneTimeCode)
                .padding()
                .overlay {
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(.quaternary)
                }
                .onChange(of: manualCode) { _, newValue in
                    manualCode = Self.sanitize(newValue)
                }
                .accessibilityLabel("Pairing code")

            Button {
                Task {
                    await pairWithCode()
                }
            } label: {
                if isPairing {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Label("Pair", systemImage: "keyboard")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isPairing || manualCode.count != Self.codeLength)
        }
    }

    /// Canonicalizes typed input to the Crockford alphabet, applying the same
    /// `I`/`L` -> `1` and `O` -> `0` aliases as `normalize_code`, and caps the
    /// length so the field can only ever hold a valid 5-character code.
    private static func sanitize(_ input: String) -> String {
        var result = ""
        for character in input.uppercased() {
            let mapped: Character
            switch character {
            case "I", "L":
                mapped = "1"
            case "O":
                mapped = "0"
            default:
                mapped = character
            }
            guard codeAlphabet.contains(mapped) else {
                continue
            }
            result.append(mapped)
            if result.count == codeLength {
                break
            }
        }
        return result
    }

    private func pairWithQr(_ payload: String) async {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isPairing else {
            return
        }
        isPairing = true
        await model.pair(qrPayload: trimmed)
        isPairing = false
    }

    private func pairWithCode() async {
        guard manualCode.count == Self.codeLength, !isPairing else {
            return
        }
        isPairing = true
        await model.pair(code: manualCode)
        isPairing = false
    }
}

struct QRScannerView: UIViewControllerRepresentable {
    let onPayload: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let controller = QRScannerViewController()
        controller.onPayload = onPayload
        return controller
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onPayload: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmitPayload = false
    private var isConfigured = false
    private var wantsSessionRunning = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        requestCameraAccessAndConfigure()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        didEmitPayload = false
        wantsSessionRunning = true
        startSessionIfReady()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        wantsSessionRunning = false
        if session.isRunning {
            session.stopRunning()
        }
    }

    private func requestCameraAccessAndConfigure() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureCamera()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.configureCamera()
                    } else {
                        self?.showUnavailableLabel("Camera access is required for QR pairing")
                    }
                }
            }
        case .denied, .restricted:
            showUnavailableLabel("Camera access is required for QR pairing")
        @unknown default:
            showUnavailableLabel("Camera unavailable")
        }
    }

    private func configureCamera() {
        guard !isConfigured else {
            return
        }
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else {
            showUnavailableLabel()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            showUnavailableLabel()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.insertSublayer(preview, at: 0)
        previewLayer = preview
        isConfigured = true
        startSessionIfReady()
    }

    private func startSessionIfReady() {
        guard wantsSessionRunning, isConfigured, !session.isRunning else {
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    private func showUnavailableLabel(_ message: String = "Camera unavailable") {
        let label = UILabel()
        label.text = message
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didEmitPayload,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue
        else {
            return
        }
        didEmitPayload = true
        onPayload?(value)
    }
}
