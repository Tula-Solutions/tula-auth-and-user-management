import SwiftUI
import TulaAuth
import TulaAuthUI

// The SwiftUI samples of the documentation (docs/swift.md). Each `// #region name` …
// `// #endregion` block is copied into the page by `bun run docs:generate`, and
// `bun run docs:check` fails when the page and this file differ.
//
// This file is compiled with the package's tests (`swift build --build-tests`, `swift test`)
// and nothing in it is run or drawn: it shows that the views and modifiers the page names
// exist with these arguments, not what they look like.

/// Google's own SDK, which the app calls: the screens never do. The ID token, or `nil` when
/// the sheet was closed.
private func myGoogleSheet(nonce _: String) async throws -> String? { nil }

// #region sign-in-screen
struct SignInScreen: View {
    let tula: TulaClient

    var body: some View {
        TulaAuthView(client: tula, mode: .signIn) {
            // The client is signed in: show the app.
        }
    }
}
// #endregion

// #region styles
/// A field drawn with a line under it. The configuration hands over the text field
/// already labelled, identified and bound to the focus.
struct Underlined: TulaAuthFieldStyle {
    func makeBody(configuration: TulaAuthFieldConfiguration) -> some View {
        VStack(alignment: .leading) {
            Text(configuration.label)
            configuration.input
            Divider()
            // Every problem is said in words, never by a colour alone.
            ForEach(configuration.errors, id: \.self) { Text($0) }
        }
    }
}

/// The main button, drawn the app's way. The label and its action stay the screens'.
struct Pill: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Capsule().fill(.tint))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
// #endregion

@MainActor
enum DocsSnippets {
    #if canImport(AuthenticationServices)
        static func ways(key: String, url: String) throws -> some View {
            // #region ways
            let tula = try TulaClient(
                publishableKey: key, baseURL: url,
                passkeys: SystemPasskeySheet(), apple: SystemAppleSheet(), browser: SystemBrowserSession())

            let screen = TulaAuthView(
                client: tula,
                options: TulaAuthOptions(
                    redirectURL: "https://app.example.com/oauth/callback",
                    google: { nonce in try await myGoogleSheet(nonce: nonce) })  // the ID token, or nil when closed
            ) { /* signed in */  }
            // #endregion
            return screen
        }
    #endif

    static func account(tula: TulaClient) -> some View {
        // #region account
        TulaAccountView(client: tula) {
            // Nobody is signed in any more: show the sign-in.
        }
        // #endregion
    }

    static func themed(tula: TulaClient) -> some View {
        // #region theme
        var theme = TulaTheme.defaults
        theme.light.primary = "#0f766e"
        theme.dark.primary = "#5eead4"
        theme.radius = "12px"

        let screen = TulaAuthView(client: tula, theme: theme)
        // #endregion
        return screen
    }

    static func worded(tula: TulaClient) -> some View {
        // #region strings
        var strings = TulaStrings.english
        strings.signInTitle = "Welcome back"
        strings.errors["auth.invalid_credentials"] = "That did not match. Try again."

        let screen = TulaAuthView(client: tula, strings: strings)
        // #endregion
        return screen
    }

    static func slots(tula: TulaClient) -> some View {
        // #region slots
        TulaAuthView(client: tula)
            .tulaAuthHeader { context in Image("Logo").accessibilityLabel(context.appName ?? "") }
            .tulaAuthFooter { Text("Terms apply.") }
            .tulaAuthPrimaryButtonStyle(Pill())
            .tulaAuthFieldStyle(Underlined())
        // #endregion
    }
}
