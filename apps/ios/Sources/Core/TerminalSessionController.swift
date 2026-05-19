import Foundation
import Combine

@MainActor
final class TerminalSessionController: ObservableObject {
    @Published private(set) var fallbackText = ""
    @Published private(set) var outputRevision: UInt64 = 0
    @Published private(set) var status = "Connecting"
    @Published private(set) var agentState: MobileSession.State
    @Published private(set) var exitedCode: Int32?

    let session: MobileSession

    private var attachedSession: AttachedSession
    private let attachFromSeq: (UInt64?) async throws -> AttachedSession
    private let recordLastSeenSeq: (UInt64) -> Void
    private let recordTelemetryExperience: () -> Void
    private let securityGate: SecurityGate
    private let sink: TerminalByteSink
    private var pendingChunks: [Data] = []
    private var subscribeTask: Task<Void, Never>?
    private var isDetached = false
    private var awaitingInputObserved = false
    private var inputSentAfterAwaiting = false
    private var outputLinesAfterResponse = 0
    private var telemetryExperienceRecorded = false

    init(
        session: MobileSession,
        attachedSession: AttachedSession,
        securityGate: SecurityGate,
        attachFromSeq: @escaping (UInt64?) async throws -> AttachedSession,
        recordLastSeenSeq: @escaping (UInt64) -> Void,
        recordTelemetryExperience: @escaping () -> Void
    ) {
        self.session = session
        self.attachedSession = attachedSession
        self.securityGate = securityGate
        self.attachFromSeq = attachFromSeq
        self.recordLastSeenSeq = recordLastSeenSeq
        self.recordTelemetryExperience = recordTelemetryExperience
        self.agentState = session.state
        self.sink = TerminalByteSink()
        self.sink.controller = self
    }

    deinit {
        subscribeTask?.cancel()
    }

    func start() {
        status = "Attached"
        startSubscription()
    }

    private func startSubscription() {
        subscribeTask?.cancel()
        let attachedSession = attachedSession
        let sink = sink
        subscribeTask = Task {
            do {
                try await attachedSession.subscribe(sink: sink)
            } catch {
                await MainActor.run {
                    if !self.isDetached {
                        self.status = error.localizedDescription
                    }
                }
            }
        }
    }

    func send(_ data: Data) async {
        guard !data.isEmpty else {
            return
        }
        guard await securityGate.unlockIfNeeded(reason: "Send terminal input") else {
            status = "Locked"
            return
        }
        do {
            try await attachedSession.sendInput(bytes: data)
            if awaitingInputObserved || agentState == .awaitingInput {
                inputSentAfterAwaiting = true
                outputLinesAfterResponse = 0
            }
        } catch {
            status = error.localizedDescription
        }
    }

    func resize(cols: UInt16, rows: UInt16) {
        Task {
            do {
                try await attachedSession.resize(cols: cols, rows: rows)
            } catch {
                await MainActor.run {
                    self.status = error.localizedDescription
                }
            }
        }
    }

    func detach() {
        isDetached = true
        subscribeTask?.cancel()
        let attachedSession = attachedSession
        recordLastSeenSeq(attachedSession.lastSeenSeq())
        Task {
            try? await attachedSession.detach()
        }
    }

    func drainPendingOutput() -> [Data] {
        let chunks = pendingChunks
        pendingChunks.removeAll(keepingCapacity: true)
        return chunks
    }

    fileprivate func receiveInitialBytes(_ bytes: Data) {
        status = "Attached"
        recordCurrentSeq()
        append(bytes)
    }

    fileprivate func receiveOutput(_ bytes: Data) {
        recordCurrentSeq()
        trackTelemetryExperienceOutput(bytes)
        append(bytes)
    }

    fileprivate func updateAgentState(_ state: AgentStateFfi) {
        agentState = MobileSession.State(state)
        if agentState == .awaitingInput {
            awaitingInputObserved = true
        }
    }

    fileprivate func markLag(_ skippedBytes: UInt64) {
        recordCurrentSeq()
        status = "Resyncing after missing \(skippedBytes) updates"
        Task {
            await resync()
        }
    }

    fileprivate func markExited(_ code: Int32) {
        recordCurrentSeq()
        exitedCode = code
        status = "Exited \(code)"
    }

    private func append(_ bytes: Data) {
        pendingChunks.append(bytes)
        outputRevision &+= 1
        if let text = String(data: bytes, encoding: .utf8) {
            fallbackText.append(text)
            if fallbackText.count > 16_384 {
                fallbackText.removeFirst(fallbackText.count - 16_384)
            }
        }
    }

    private func recordCurrentSeq() {
        recordLastSeenSeq(attachedSession.lastSeenSeq())
    }

    private func trackTelemetryExperienceOutput(_ bytes: Data) {
        guard inputSentAfterAwaiting, !telemetryExperienceRecorded else {
            return
        }
        outputLinesAfterResponse += bytes.reduce(0) { count, byte in
            count + (byte == 0x0a ? 1 : 0)
        }
        if outputLinesAfterResponse >= 10 {
            telemetryExperienceRecorded = true
            recordTelemetryExperience()
        }
    }

    private func resync() async {
        guard !isDetached else {
            return
        }
        let seq = attachedSession.lastSeenSeq()
        recordLastSeenSeq(seq)
        do {
            try? await attachedSession.detach()
            attachedSession = try await attachFromSeq(seq)
            status = "Attached"
            startSubscription()
        } catch {
            status = error.localizedDescription
        }
    }
}

final class TerminalByteSink: ByteStreamSink, @unchecked Sendable {
    weak var controller: TerminalSessionController?

    func onInitialBytes(bytes: Data) {
        Task { @MainActor [weak controller] in
            controller?.receiveInitialBytes(bytes)
        }
    }

    func onOutput(bytes: Data) {
        Task { @MainActor [weak controller] in
            controller?.receiveOutput(bytes)
        }
    }

    func onAgentState(state: AgentStateFfi) {
        Task { @MainActor [weak controller] in
            controller?.updateAgentState(state)
        }
    }

    func onLag(skippedBytes: UInt64) {
        Task { @MainActor [weak controller] in
            controller?.markLag(skippedBytes)
        }
    }

    func onSessionExited(code: Int32) {
        Task { @MainActor [weak controller] in
            controller?.markExited(code)
        }
    }
}
