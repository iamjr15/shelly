import SwiftUI

@main
struct FieldworkApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task {
                    await model.bootstrap()
                }
                .onChange(of: scenePhase) { _, phase in
                    if model.handleScenePhase(phase) {
                        Task {
                            await model.unlock(reason: "Unlock Fieldwork")
                        }
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: .fieldworkDidRegisterApnsToken)) { notification in
                    guard let token = notification.object as? Data else {
                        return
                    }
                    Task {
                        await model.registerPushToken(token)
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: .fieldworkDidReceivePushSessionHash)) { notification in
                    guard let hash = notification.object as? String else {
                        return
                    }
                    Task {
                        await model.handlePushSessionHash(hash)
                    }
                }
                .confirmationDialog(
                    "Help improve Fieldwork?",
                    isPresented: Binding(
                        get: { model.showsTelemetryConsentPrompt },
                        set: { isPresented in
                            if !isPresented {
                                model.dismissTelemetryConsentPrompt()
                            }
                        }
                    ),
                    titleVisibility: .visible
                ) {
                    Button("Sure") {
                        model.answerTelemetryConsent(accepted: true)
                    }
                    Button("No thanks", role: .cancel) {
                        model.answerTelemetryConsent(accepted: false)
                    }
                } message: {
                    Text("Crash reports only. No code, prompts, terminal output, or file paths.")
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selectedTab = AppTab.sessions

    var body: some View {
        Group {
            if model.isUnlocked {
                TabView(selection: $selectedTab) {
                    NavigationStack {
                        if model.isPaired {
                            SessionsListView()
                        } else {
                            PairingView()
                        }
                    }
                    .tabItem {
                        Label("Sessions", systemImage: "terminal")
                    }
                    .tag(AppTab.sessions)

                    NavigationStack {
                        SettingsView()
                    }
                    .tabItem {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .tag(AppTab.settings)
                }
                .task(id: model.targetSession?.id) {
                    if model.targetSession != nil {
                        selectedTab = .sessions
                    }
                }
            } else {
                LockedOverlay {
                    Task {
                        await model.unlock(reason: "Unlock Fieldwork")
                    }
                }
            }
        }
    }
}

private enum AppTab {
    case sessions
    case settings
}

private struct LockedOverlay: View {
    let unlock: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.shield")
                .font(.system(size: 48, weight: .semibold))
                .foregroundStyle(.tint)
            Text("Fieldwork Locked")
                .font(.title2.weight(.semibold))
            Button(action: unlock) {
                Label("Unlock", systemImage: "faceid")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
        .padding(28)
        .frame(maxWidth: 360)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
    }
}
