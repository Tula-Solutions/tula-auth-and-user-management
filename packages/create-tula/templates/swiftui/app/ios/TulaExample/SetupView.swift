import SwiftUI

/// Asks a developer where their API is and for their publishable key, once.
struct SetupView: View {
    let refusal: String?
    let onDone: (ExampleConfiguration) -> Void

    @State private var baseURL = ""
    @State private var publishableKey = ""

    var body: some View {
        Form {
            Section {
                TextField("https://auth.example.com", text: $baseURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .accessibilityLabel("API URL")
            } header: {
                Text("API URL")
            } footer: {
                Text("A local stack is http://127.0.0.1:3003 in a simulator.")
            }
            Section {
                TextField("tula_pk_…", text: $publishableKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel("Publishable key")
            } header: {
                Text("Publishable key")
            } footer: {
                Text("The environment's publishable key. A secret key never belongs in an app, and is refused.")
            }
            if let refusal {
                Section {
                    Text("Error: \(refusal)")
                        .accessibilityIdentifier("example.refusal")
                }
            }
            Button("Continue") {
                onDone(
                    ExampleConfiguration(
                        baseURL: baseURL.trimmingCharacters(in: .whitespacesAndNewlines),
                        publishableKey: publishableKey.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            .disabled(baseURL.isEmpty || publishableKey.isEmpty)
        }
    }
}
