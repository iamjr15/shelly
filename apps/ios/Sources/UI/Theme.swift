import SwiftUI

extension MobileSession.State {
    var label: String {
        switch self {
        case .awaitingInput: "Awaiting"
        case .working: "Working"
        case .idle: "Idle"
        case .crashed: "Crashed"
        }
    }

    var symbolName: String {
        switch self {
        case .awaitingInput: "exclamationmark.circle.fill"
        case .working: "bolt.circle.fill"
        case .idle: "circle"
        case .crashed: "xmark.octagon.fill"
        }
    }

    var tint: Color {
        switch self {
        case .awaitingInput: .orange
        case .working: .blue
        case .idle: .secondary
        case .crashed: .red
        }
    }
}

extension View {
    func fieldworkPanel() -> some View {
        padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
