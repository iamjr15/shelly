import Foundation
import Combine
import LocalAuthentication

@MainActor
final class SecurityGate: ObservableObject {
    private let freshnessWindow: TimeInterval = 5 * 60

    @Published private(set) var lastSuccessfulUnlock: Date?
    /// Set when the device cannot evaluate the unlock policy at all (no passcode);
    /// nil whenever authentication is merely declined or pending.
    private(set) var unavailabilityReason: String?
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
        context.localizedFallbackTitle = "Use Passcode"
        var error: NSError?
        // Device-owner policy prefers biometrics but falls back to the passcode,
        // so passcode-only devices and biometry lockout can still unlock.
        let policy: LAPolicy = .deviceOwnerAuthentication
        guard context.canEvaluatePolicy(policy, error: &error) else {
            unavailabilityReason = error?.localizedDescription ?? "Set a device passcode to use Shelly."
            return false
        }
        unavailabilityReason = nil

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
