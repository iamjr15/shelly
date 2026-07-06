import SwiftUI
import UIKit
import SwiftTerm

struct TerminalRenderer: UIViewRepresentable {
    @ObservedObject var controller: TerminalSessionController
    @Binding var ctrlPending: Bool

    func makeUIView(context: Context) -> ShellyTerminalView {
        let view = ShellyTerminalView()
        view.onInput = { data in
            Task {
                await controller.send(data)
            }
        }
        view.onResize = { cols, rows in
            controller.resize(cols: UInt16(max(cols, 1)), rows: UInt16(max(rows, 1)))
        }
        view.onCtrlConsumed = {
            ctrlPending = false
        }
        return view
    }

    func updateUIView(_ uiView: ShellyTerminalView, context: Context) {
        uiView.pendingCtrl = ctrlPending
        for chunk in controller.drainPendingOutput() {
            uiView.feed(data: chunk)
        }
    }
}

final class ShellyTerminalView: TerminalView, TerminalViewDelegate {
    var onInput: (Data) -> Void = { _ in }
    var onResize: (Int, Int) -> Void = { _, _ in }
    var onCtrlConsumed: () -> Void = {}
    var pendingCtrl = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        terminalDelegate = self
        backgroundColor = .black
        becomeFirstResponder()
    }

    convenience init() {
        self.init(frame: .zero)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func feed(data: Data) {
        let bytes = [UInt8](data)
        guard !bytes.isEmpty else {
            return
        }
        feed(byteArray: bytes[0..<bytes.count])
    }

    func scrolled(source: TerminalView, position: Double) {}

    func setTerminalTitle(source: TerminalView, title: String) {}

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        onResize(newCols, newRows)
    }

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        // Compose a pending accessory-bar Ctrl with the next single printable
        // byte (e.g. Ctrl+C -> 0x03); multi-byte sequences such as arrow keys
        // or composed IME input pass through untouched.
        if pendingCtrl, data.count == 1, let byte = data.first, (0x40...0x7e).contains(byte) {
            pendingCtrl = false
            onCtrlConsumed()
            onInput(Data([byte & 0x1f]))
            return
        }
        onInput(Data(data))
    }

    func clipboardCopy(source: TerminalView, content: Data) {
        UIPasteboard.general.string = String(data: content, encoding: .utf8)
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else {
            return
        }
        UIApplication.shared.open(url)
    }

    func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
}
