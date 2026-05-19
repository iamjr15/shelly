import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("telemetryOptIn") private var telemetryOptIn = false
    @State private var confirmUnpair = false

    var body: some View {
        List {
            Section("Daemon") {
                if let daemon = model.pairedDaemonSummary {
                    LabeledContent("Node") {
                        Text(String(daemon.daemonNodeId.prefix(12)) + "...")
                            .font(.system(.body, design: .monospaced))
                    }
                    LabeledContent("Device") {
                        Text(String(daemon.deviceNodeId.prefix(12)) + "...")
                            .font(.system(.body, design: .monospaced))
                    }
                    LabeledContent("Paired") {
                        Text(daemon.pairedAt, style: .date)
                    }
                    Button(role: .destructive) {
                        confirmUnpair = true
                    } label: {
                        Label("Unpair", systemImage: "trash")
                    }
                } else {
                    Text("No paired daemon")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Privacy") {
                Toggle("Share crash reports", isOn: $telemetryOptIn)
                    .onChange(of: telemetryOptIn) { _, _ in
                        MobileTelemetry.setCrashReportingEnabled(telemetryOptIn)
                    }
            }

            Section("About") {
                LabeledContent("Version", value: "1.0")
                NavigationLink {
                    OpenSourceLicensesView()
                } label: {
                    Text("Open Source Licenses")
                }
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Unpair this device?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) {
                model.unpair()
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}
