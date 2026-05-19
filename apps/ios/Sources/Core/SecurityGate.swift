import Foundation
import Combine
import LocalAuthentication

@MainActor
final class SecurityGate: ObservableObject {
    private let freshnessWindow: TimeInterval = 5 * 60

    @Published private(set) var lastSuccessfulUnlock: Date?
    private var backgroundedAt: Date?

    var isFresh: Bool {
        guard let lastSuccessfulUnlock else {
            return false
        }
        return Date().timeIntervalSince(lastSuccessfulUnlock) < freshnessWindow
    }

    var shouldLockOnForeground: Bool {
        guard let backgroundedAt else {
            return !isFresh
        }
        return Date().timeIntervalSince(backgroundedAt) >= freshnessWindow || !isFresh
    }

    func markBackgrounded() {
        backgroundedAt = Date()
    }

    func unlockIfNeeded(reason: String) async -> Bool {
        if isFresh {
            return true
        }

        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var error: NSError?
        let policy: LAPolicy = .deviceOwnerAuthenticationWithBiometrics
        guard context.canEvaluatePolicy(policy, error: &error) else {
            return false
        }

        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(policy, localizedReason: reason) { success, _ in
                Task { @MainActor in
                    if success {
                        self.lastSuccessfulUnlock = Date()
                        self.backgroundedAt = nil
                    }
                    continuation.resume(returning: success)
                }
            }
        }
    }
}
