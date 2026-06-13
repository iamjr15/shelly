import CryptoKit
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var isUnlocked = false
    @Published private(set) var isPaired = false
    @Published private(set) var sessions: [MobileSession] = []
    @Published private(set) var targetSession: MobileSession?
    @Published var statusMessage: String?
    @Published var isRefreshing = false
    @Published var showsTelemetryConsentPrompt = false

    let securityGate = SecurityGate()

    private let service: ShellyCoreService
    private var lastApnsToken: Data?
    private var pendingPushSessionIdHash: String?
    private var sessionSubscriptionTask: Task<Void, Never>?

    init(service: ShellyCoreService = ShellyCoreService()) {
        self.service = service
    }

    func bootstrap() async {
        isPaired = service.restoreSavedPairing()
        await unlock(reason: "Unlock Shelly")
    }

    @discardableResult
    func handleScenePhase(_ phase: ScenePhase) -> Bool {
        switch phase {
        case .background:
            securityGate.markBackgrounded()
            return false
        case .active:
            if securityGate.shouldLockOnForeground {
                isUnlocked = false
                return true
            }
            return false
        default:
            return false
        }
    }

    func unlock(reason: String) async {
        let wasUnlocked = isUnlocked
        isUnlocked = await securityGate.unlockIfNeeded(reason: reason)
        if isUnlocked, isPaired, (!wasUnlocked || sessions.isEmpty || pendingPushSessionIdHash != nil) {
            await activatePairedSessionServices()
        }
    }

    func pair(qrPayload: String) async {
        guard await ensureUnlocked(reason: "Pair Shelly with this daemon") else {
            return
        }
        do {
            try await service.pair(qrPayload: qrPayload)
            isPaired = true
            statusMessage = "Paired"
            await activatePairedSessionServices()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func pair(code: String) async {
        guard await ensureUnlocked(reason: "Pair Shelly with this daemon") else {
            return
        }
        do {
            try await service.pair(code: code)
            isPaired = true
            statusMessage = "Paired"
            await activatePairedSessionServices()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func refreshSessions() async {
        guard isPaired else {
            sessions = []
            return
        }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            sessions = try await service.listSessions().sortedForDisplay()
            resolvePendingPushTarget()
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func hideSession(id: String) {
        sessions.removeAll { $0.id == id }
    }

    func makeTerminalController(for session: MobileSession) async -> TerminalSessionController? {
        guard await ensureUnlocked(reason: "Open terminal session") else {
            return nil
        }
        do {
            return try await service.attach(
                session: session,
                securityGate: securityGate,
                recordTelemetryExperience: { [weak self] in
                    self?.recordTelemetryExperience()
                }
            )
        } catch {
            statusMessage = error.localizedDescription
            return nil
        }
    }

    func registerPushToken(_ token: Data) async {
        lastApnsToken = token
        guard isPaired else {
            return
        }
        do {
            try await service.registerApnsToken(token)
        } catch {
            statusMessage = error.localizedDescription
        }
    }

    func handlePushSessionHash(_ hash: String) async {
        let normalized = hash.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isLowercaseHexHash(normalized) else {
            return
        }
        pendingPushSessionIdHash = normalized
        guard isUnlocked else {
            return
        }
        resolvePendingPushTarget()
        if isPaired {
            await refreshSessions()
        }
    }

    func consumeTargetSession() {
        targetSession = nil
    }

    func recordTelemetryExperience() {
        if MobileTelemetry.shouldShowConsentPrompt() {
            showsTelemetryConsentPrompt = true
        }
    }

    func answerTelemetryConsent(accepted: Bool) {
        showsTelemetryConsentPrompt = false
        if accepted {
            MobileTelemetry.setDiagnosticsEnabled(true)
        } else {
            MobileTelemetry.declineDiagnostics()
        }
    }

    func dismissTelemetryConsentPrompt() {
        if showsTelemetryConsentPrompt {
            answerTelemetryConsent(accepted: false)
        }
    }

    func unpair() {
        sessionSubscriptionTask?.cancel()
        sessionSubscriptionTask = nil
        pendingPushSessionIdHash = nil
        targetSession = nil
        service.clearPairing()
        isPaired = false
        sessions = []
        statusMessage = "Unpaired"
    }

    var pairedDaemonSummary: PairedDaemonRecord? {
        service.savedPairing
    }

    private func ensureUnlocked(reason: String) async -> Bool {
        if securityGate.isFresh {
            isUnlocked = true
            return true
        }
        await unlock(reason: reason)
        return isUnlocked
    }

    private func requestPushTokenRegistration() {
        NotificationCenter.default.post(name: .shellyShouldRegisterForRemoteNotifications, object: nil)
    }

    private func activatePairedSessionServices() async {
        await refreshSessions()
        startSessionSubscription()
        if let lastApnsToken {
            await registerPushToken(lastApnsToken)
        } else {
            requestPushTokenRegistration()
        }
    }

    private func startSessionSubscription() {
        sessionSubscriptionTask?.cancel()
        guard isPaired else {
            return
        }
        sessionSubscriptionTask = Task { [weak self] in
            guard let self else {
                return
            }
            do {
                try await service.subscribeSessions { [weak self] sessions in
                    self?.sessions = sessions
                    self?.resolvePendingPushTarget()
                }
            } catch is CancellationError {
            } catch {
                await MainActor.run {
                    self.statusMessage = error.localizedDescription
                }
            }
        }
    }

    private func resolvePendingPushTarget() {
        guard let pendingPushSessionIdHash else {
            return
        }
        guard let session = sessions.first(where: { sha256Hex($0.id) == pendingPushSessionIdHash }) else {
            return
        }
        self.pendingPushSessionIdHash = nil
        targetSession = session
    }
}

private func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
        .map { String(format: "%02x", $0) }
        .joined()
}

private func isLowercaseHexHash(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { byte in
        (48...57).contains(Int(byte)) || (97...102).contains(Int(byte))
    }
}
