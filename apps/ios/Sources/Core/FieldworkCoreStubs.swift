#if FIELDWORK_STUBS
import Foundation

enum MobilePlatform: Hashable {
    case ios
    case android
}

enum PushPlatform: Hashable {
    case apns
    case fcm
}

enum AgentStateFfi: Hashable {
    case idle
    case working
    case awaitingInput
    case crashed
}

struct DaemonConfig: Hashable {
    let daemonNodeId: String
    let relayUrl: String?
    let addrs: [String]
}

struct ClientConfig: Hashable {
    let deviceName: String
    let platform: MobilePlatform
    let deviceSecretKey: Data?
    let pairedDaemon: DaemonConfig?
}

struct DaemonInfo {
    let daemonNodeId: String
    let relayUrl: String?
    let addrs: [String]
    let deviceNodeId: String
    let deviceSecretKey: Data
}

struct SessionSummaryFfi {
    let id: String
    let name: String
    let command: [String]
    let cwd: String
    let createdAt: UInt64
    let lastActivity: UInt64
    let state: AgentStateFfi
    let lastLine: String?
    let model: String?
}

protocol ByteStreamSink: AnyObject, Sendable {
    func onInitialBytes(bytes: Data)
    func onOutput(bytes: Data)
    func onAgentState(state: AgentStateFfi)
    func onLag(skippedBytes: UInt64)
    func onSessionExited(code: Int32)
}

protocol SessionListSink: AnyObject, Sendable {
    func onUpdate(sessions: [SessionSummaryFfi])
}

final class FieldworkClient: @unchecked Sendable {
    private let config: ClientConfig
    private let initError: Error?

    init(config: ClientConfig) throws {
        self.config = config
        self.initError = nil
    }

    private init(error: Error) {
        self.config = ClientConfig(deviceName: "Stub", platform: .ios, deviceSecretKey: nil, pairedDaemon: nil)
        self.initError = error
    }

    static func stub(error: Error) -> FieldworkClient {
        FieldworkClient(error: error)
    }

    func pairWithQr(qrPayload: String) async throws -> DaemonInfo {
        if let initError {
            throw initError
        }
        return DaemonInfo(
            daemonNodeId: "stub-daemon",
            relayUrl: nil,
            addrs: ["127.0.0.1:0"],
            deviceNodeId: "stub-device",
            deviceSecretKey: Data(repeating: 1, count: 32)
        )
    }

    func listSessions() async throws -> [SessionSummaryFfi] {
        if let initError {
            throw initError
        }
        return [
            SessionSummaryFfi(
                id: "018f0000-0000-7000-8000-000000000001",
                name: "claude",
                command: ["claude"],
                cwd: "/Users/me/project",
                createdAt: 0,
                lastActivity: 1,
                state: .awaitingInput,
                lastLine: "Approve changes?",
                model: "Claude"
            ),
            SessionSummaryFfi(
                id: "018f0000-0000-7000-8000-000000000002",
                name: "bash",
                command: ["bash"],
                cwd: "/Users/me",
                createdAt: 0,
                lastActivity: 0,
                state: .idle,
                lastLine: "$",
                model: nil
            )
        ]
    }

    func subscribeSessions(sink: SessionListSink) async throws {
        sink.onUpdate(sessions: try await listSessions())
    }

    func attachSession(id: String) async throws -> AttachedSession {
        try await attachSessionFrom(id: id, lastSeenSeq: nil)
    }

    func attachSessionFrom(id: String, lastSeenSeq: UInt64?) async throws -> AttachedSession {
        if let initError {
            throw initError
        }
        return AttachedSession()
    }

    func registerPushToken(platform: PushPlatform, token: String) async throws {}
}

final class AttachedSession: @unchecked Sendable {
    func sendInput(bytes: Data) async throws {}
    func resize(cols: UInt16, rows: UInt16) async throws {}
    func detach() async throws {}
    func initialSeq() -> UInt64 { 0 }
    func lastSeenSeq() -> UInt64 { 0 }
    func subscribe(sink: ByteStreamSink) async throws {
        sink.onInitialBytes(bytes: Data("fieldwork stub terminal\r\n$ ".utf8))
    }
}
#endif
