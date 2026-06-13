import SwiftUI
import UIKit

#if canImport(SwiftTerm)
import SwiftTerm

struct TerminalRenderer: UIViewRepresentable {
    @ObservedObject var controller: TerminalSessionController

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
        return view
    }

    func updateUIView(_ uiView: ShellyTerminalView, context: Context) {
        for chunk in controller.drainPendingOutput() {
            uiView.feed(data: chunk)
        }
    }
}

final class ShellyTerminalView: TerminalView, TerminalViewDelegate {
    var onInput: (Data) -> Void = { _ in }
    var onResize: (Int, Int) -> Void = { _, _ in }

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

#else

struct TerminalRenderer: View {
    @ObservedObject var controller: TerminalSessionController

    var body: some View {
        ScrollView {
            Text(controller.fallbackText)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(.green)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        }
        .background(.black)
    }
}

#endif
