import Foundation
import UIKit

struct MobileSession: Identifiable, Hashable {
    enum State: String, Codable, Hashable {
        case idle
        case working
        case awaitingInput
        case crashed

        var sortRank: Int {
            switch self {
            case .awaitingInput: 0
            case .working: 1
            case .idle: 2
            case .crashed: 3
            }
        }
    }

    let id: String
    let name: String
    let command: [String]
    let cwd: String
    let createdAt: UInt64
    let lastActivity: UInt64
    let state: State
    let lastLine: String?
    let model: String?
}

extension Array where Element == MobileSession {
    func sortedForDisplay() -> [MobileSession] {
        sorted {
            if $0.state.sortRank != $1.state.sortRank {
                return $0.state.sortRank < $1.state.sortRank
            }
            return $0.lastActivity > $1.lastActivity
        }
    }
}

struct PairedDaemonRecord: Codable, Equatable {
    let daemonNodeId: String
    let relayUrl: String?
    let addrs: [String]
    let deviceNodeId: String
    let deviceSecretKey: Data
    let pairedAt: Date
}

@MainActor
final class FieldworkCoreService {
    private let keychain: KeychainStore
    private var client: FieldworkClient?
    private var lastSeenSeqBySession: [String: UInt64] = [:]

    private(set) var savedPairing: PairedDaemonRecord?

    init(keychain: KeychainStore = KeychainStore()) {
        self.keychain = keychain
    }

    func restoreSavedPairing() -> Bool {
        guard let record: PairedDaemonRecord = try? keychain.load(PairedDaemonRecord.self) else {
            savedPairing = nil
            client = try? makeClient(record: nil)
            return false
        }
        savedPairing = record
        client = try? makeClient(record: record)
        return client != nil
    }

    func pair(qrPayload: String) async throws {
        let freshClient = try makeClient(record: nil)
        client = freshClient
        let info = try await freshClient.pairWithQr(qrPayload: qrPayload)
        try persistPairing(info)
    }

    func pair(code: String) async throws {
        let freshClient = try makeClient(record: nil)
        client = freshClient
        let info = try await freshClient.pairWithCode(code: code)
        try persistPairing(info)
    }

    private func persistPairing(_ info: DaemonInfo) throws {
        let record = PairedDaemonRecord(
            daemonNodeId: info.daemonNodeId,
            relayUrl: info.relayUrl,
            addrs: info.addrs,
            deviceNodeId: info.deviceNodeId,
            deviceSecretKey: info.deviceSecretKey,
            pairedAt: Date()
        )
        try keychain.save(record)
        savedPairing = record
        client = try makeClient(record: record)
    }

    func listSessions() async throws -> [MobileSession] {
        let client = try requireClient()
        return try await client.listSessions().map(MobileSession.init(summary:))
    }

    func subscribeSessions(onUpdate: @escaping @MainActor ([MobileSession]) -> Void) async throws {
        let client = try requireClient()
        let sink = SessionListCallback { summaries in
            let sessions = summaries.map(MobileSession.init(summary:)).sortedForDisplay()
            Task { @MainActor in
                onUpdate(sessions)
            }
        }
        try await client.subscribeSessions(sink: sink)
    }

    func attach(
        session: MobileSession,
        securityGate: SecurityGate,
        recordTelemetryExperience: @escaping () -> Void
    ) async throws -> TerminalSessionController {
        let client = try requireClient()
        let initialSeq = lastSeenSeqBySession[session.id]
        let attached: AttachedSession
        if let initialSeq {
            attached = try await client.attachSessionFrom(id: session.id, lastSeenSeq: initialSeq)
        } else {
            attached = try await client.attachSession(id: session.id)
        }
        let controller = TerminalSessionController(
            session: session,
            attachedSession: attached,
            securityGate: securityGate,
            attachFromSeq: { lastSeenSeq in
                if let lastSeenSeq {
                    return try await client.attachSessionFrom(id: session.id, lastSeenSeq: lastSeenSeq)
                }
                return try await client.attachSession(id: session.id)
            },
            recordLastSeenSeq: { [weak self] seq in
                self?.lastSeenSeqBySession[session.id] = seq
            },
            recordTelemetryExperience: recordTelemetryExperience
        )
        controller.start()
        return controller
    }

    func registerApnsToken(_ token: Data) async throws {
        let client = try requireClient()
        let hex = token.map { String(format: "%02x", $0) }.joined()
        try await client.registerPushToken(platform: .apns, token: hex)
    }

    func clearPairing() {
        try? keychain.delete()
        savedPairing = nil
        lastSeenSeqBySession.removeAll()
        client = try? makeClient(record: nil)
    }

    private func requireClient() throws -> FieldworkClient {
        if let client {
            return client
        }
        let restored = restoreSavedPairing()
        guard restored, let client else {
            throw FieldworkAppError.notPaired
        }
        return client
    }

    private func makeClient(record: PairedDaemonRecord?) throws -> FieldworkClient {
        let daemon = record.map {
            DaemonConfig(daemonNodeId: $0.daemonNodeId, relayUrl: $0.relayUrl, addrs: $0.addrs)
        }
        let config = ClientConfig(
            deviceName: UIDevice.current.name,
            platform: .ios,
            deviceSecretKey: record?.deviceSecretKey,
            pairedDaemon: daemon,
            relayControlUrl: Self.relayControlUrl
        )
        return try FieldworkClient(config: config)
    }

    /// Relay control URL injected at build time via the `FieldworkRelayControlURL`
    /// Info.plist key (sourced from `FIELDWORK_RELAY_CONTROL_URL`). Absent or empty
    /// disables the typed-code path; QR pairing keeps working without a relay.
    private static var relayControlUrl: String? {
        guard
            let value = Bundle.main.object(forInfoDictionaryKey: "FieldworkRelayControlURL") as? String
        else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private final class SessionListCallback: SessionListSink {
    private let callback: @Sendable ([SessionSummaryFfi]) -> Void

    init(callback: @escaping @Sendable ([SessionSummaryFfi]) -> Void) {
        self.callback = callback
    }

    func onUpdate(sessions: [SessionSummaryFfi]) {
        callback(sessions)
    }
}

enum FieldworkAppError: LocalizedError {
    case notPaired

    var errorDescription: String? {
        switch self {
        case .notPaired:
            "No paired daemon is stored on this device."
        }
    }
}

private extension MobileSession {
    init(summary: SessionSummaryFfi) {
        id = summary.id
        name = summary.name
        command = summary.command
        cwd = summary.cwd
        createdAt = summary.createdAt
        lastActivity = summary.lastActivity
        state = State(summary.state)
        lastLine = summary.lastLine
        model = summary.model
    }
}

extension MobileSession.State {
    init(_ state: AgentStateFfi) {
        switch state {
        case .awaitingInput:
            self = .awaitingInput
        case .working:
            self = .working
        case .crashed:
            self = .crashed
        case .idle:
            self = .idle
        }
    }
}
