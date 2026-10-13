import SwiftUI
import TulaAuth
import TulaAuthUI

// The example: an app whose sign-in, sign-up and password reset are `TulaAuthView`, and
// nothing else of its own. What it adds is what every app adds: where the API is, and what
// to show once somebody is signed in.

@main
struct TulaExampleApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// Where the API is, and the environment's publishable key.
///
/// Neither is in the repository. They come from the process's environment (an Xcode scheme's
/// "Environment Variables", and what the UI tests launch the app with), or from the setup
/// screen, which keeps them in the app's defaults. A publishable key is not a secret: it is
/// made to ship in an app. A secret key is refused by the client.
struct ExampleConfiguration: Equatable {
    var baseURL: String
    var publishableKey: String

    static let urlKey = "TULA_API_URL"
    static let keyKey = "TULA_PUBLISHABLE_KEY"

    /// From the environment, then from what the setup screen saved; `nil` when neither has
    /// both values.
    static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment, defaults: UserDefaults = .standard
    ) -> ExampleConfiguration? {
        let url = environment[urlKey] ?? defaults.string(forKey: urlKey) ?? ""
        let key = environment[keyKey] ?? defaults.string(forKey: keyKey) ?? ""
        return url.isEmpty || key.isEmpty ? nil : ExampleConfiguration(baseURL: url, publishableKey: key)
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(baseURL, forKey: ExampleConfiguration.urlKey)
        defaults.set(publishableKey, forKey: ExampleConfiguration.keyKey)
    }

    static func forget(in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: urlKey)
        defaults.removeObject(forKey: keyKey)
    }
}

/// The configuration and the client made from it. A client holds the session, so there is
/// one for as long as the configuration stays.
struct Configured {
    let configuration: ExampleConfiguration
    let client: TulaClient

    init?(_ configuration: ExampleConfiguration?) {
        guard
            let configuration,
            let client = try? TulaClient(
                publishableKey: configuration.publishableKey, baseURL: configuration.baseURL)
        else {
            return nil
        }
        self.configuration = configuration
        self.client = client
    }
}

struct RootView: View {
    @State private var configured = Configured(ExampleConfiguration.load())
    @State private var refusal: String?

    var body: some View {
        if let configured {
            SessionView(client: configured.client) {
                ExampleConfiguration.forget()
                self.configured = nil
            }
        } else {
            SetupView(refusal: refusal) { typed in
                do {
                    _ = try TulaClient(publishableKey: typed.publishableKey, baseURL: typed.baseURL)
                    typed.save()
                    refusal = nil
                    configured = Configured(typed)
                } catch let error as TulaConfigurationError {
                    // A fixed sentence that repeats nothing it was given.
                    refusal = error.description
                } catch {
                    refusal = "The client could not be made."
                }
            }
        }
    }
}
