import SwiftUI

struct TerminalScreen: View {
    @EnvironmentObject private var model: AppModel
    let session: MobileSession

    @State private var controller: TerminalSessionController?
    @State private var isAttaching = true
    @State private var ctrlPending = false

    var body: some View {
        VStack(spacing: 0) {
            if let controller {
                TerminalRenderer(controller: controller)
                    .ignoresSafeArea(.keyboard, edges: .bottom)
                AccessoryBar(ctrlPending: $ctrlPending) { key in
                    Task {
                        await sendAccessory(key, controller: controller)
                    }
                }
            } else if isAttaching {
                ProgressView("Attaching")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Unable to Attach", systemImage: "terminal")
            }
        }
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let controller {
                    HStack(spacing: 8) {
                        Image(systemName: controller.agentState.symbolName)
                            .foregroundStyle(controller.agentState.tint)
                        Text(controller.status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task {
            guard controller == nil else {
                return
            }
            isAttaching = true
            controller = await model.makeTerminalController(for: session)
            isAttaching = false
        }
        .onDisappear {
            controller?.detach()
        }
    }

    private func sendAccessory(_ key: AccessoryKey, controller: TerminalSessionController) async {
        if key == .ctrl {
            ctrlPending.toggle()
            return
        }

        var data = key.bytes
        if ctrlPending, let first = data.first, first >= 0x40 {
            data = Data([first & 0x1f])
            ctrlPending = false
        }
        await controller.send(data)
    }
}

private enum AccessoryKey: String, CaseIterable, Identifiable {
    case escape = "Esc"
    case ctrl = "Ctrl"
    case tab = "Tab"
    case pipe = "|"
    case slash = "/"
    case up = "↑"
    case down = "↓"
    case left = "←"
    case right = "→"

    var id: String { rawValue }

    var bytes: Data {
        switch self {
        case .escape: Data([0x1b])
        case .ctrl: Data()
        case .tab: Data([0x09])
        case .pipe: Data("|".utf8)
        case .slash: Data("/".utf8)
        case .up: Data([0x1b, 0x5b, 0x41])
        case .down: Data([0x1b, 0x5b, 0x42])
        case .right: Data([0x1b, 0x5b, 0x43])
        case .left: Data([0x1b, 0x5b, 0x44])
        }
    }
}

private struct AccessoryBar: View {
    @Binding var ctrlPending: Bool
    let send: (AccessoryKey) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AccessoryKey.allCases) { key in
                    Button {
                        send(key)
                    } label: {
                        Text(key.rawValue)
                            .font(.system(.subheadline, design: .monospaced).weight(.medium))
                            .frame(minWidth: key == .ctrl ? 54 : 42, minHeight: 36)
                    }
                    .buttonStyle(.bordered)
                    .tint(key == .ctrl && ctrlPending ? .orange : .accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }
}
