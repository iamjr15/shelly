import SwiftUI

struct SessionsListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedSession: MobileSession?

    var body: some View {
        List {
            if model.sessions.isEmpty {
                EmptySessionsView()
                    .listRowBackground(Color.clear)
            } else {
                ForEach(model.sessions) { session in
                    Button {
                        selectedSession = session
                    } label: {
                        SessionRow(session: session)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .leading) {
                        Button {
                            hide(session)
                        } label: {
                            Label("Hide", systemImage: "eye.slash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Sessions")
        .refreshable {
            await model.refreshSessions()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        await model.refreshSessions()
                    }
                } label: {
                    if model.isRefreshing {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .accessibilityLabel("Refresh")
            }
        }
        .navigationDestination(item: $selectedSession) { session in
            TerminalScreen(session: session)
        }
        .task(id: model.targetSession?.id) {
            guard let target = model.targetSession else {
                return
            }
            selectedSession = target
            model.consumeTargetSession()
        }
        .alert("Shelly", isPresented: statusBinding) {
            Button("OK", role: .cancel) {
                model.statusMessage = nil
            }
        } message: {
            Text(model.statusMessage ?? "")
        }
    }

    private var statusBinding: Binding<Bool> {
        Binding(
            get: { model.statusMessage != nil },
            set: { if !$0 { model.statusMessage = nil } }
        )
    }

    private func hide(_ session: MobileSession) {
        model.hideSession(id: session.id)
    }
}

private struct SessionRow: View {
    let session: MobileSession

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: session.state.symbolName)
                    .foregroundStyle(session.state.tint)
                    .frame(width: 20)
                Text(session.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(session.state.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(session.state.tint)
            }

            Text(session.lastLine ?? session.command.joined(separator: " "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            HStack(spacing: 8) {
                if let model = session.model {
                    Label(model, systemImage: "cpu")
                }
                Label(URL(filePath: session.cwd).lastPathComponent, systemImage: "folder")
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
    }
}

private struct EmptySessionsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "terminal")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No Sessions")
                .font(.headline)
            Text("Create one on your laptop with `shelly new`; it will appear here automatically.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .shellyPanel()
    }
}
