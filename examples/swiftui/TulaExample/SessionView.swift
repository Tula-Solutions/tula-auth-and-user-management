import SwiftUI
import TulaAuth
import TulaAuthUI

/// What the app shows: the Tula screens while nobody is signed in, and the account screen
/// once somebody is.
///
/// **The app goes from one to the other when a screen says so** (`onSignedIn`,
/// `onSignedOut`), and not when the session's state changes. A sign-in that sets up an
/// authenticator app on the way shows its backup codes after the client is already signed
/// in: an app that followed the state would take that screen away, and the codes with it.
struct SessionView: View {
    let client: TulaClient
    let onForget: () -> Void

    private enum Phase {
        /// The stored session is being read.
        case loading
        /// Nobody is signed in: the Tula sign-in screens.
        case signedOut
        /// Somebody is: the account.
        case signedIn
    }

    @State private var phase: Phase = .loading
    @State private var loadFailed = false

    var body: some View {
        Group {
            switch phase {
            case .loading:
                VStack(spacing: 12) {
                    ProgressView()
                    Text(loadFailed ? "Your session could not be read. Trying again…" : "Loading…")
                }
            case .signedOut:
                // The few lines an app writes. Theme it, word it and replace its parts:
                // docs/swift.md, "Screens".
                //
                // It is in a navigation stack as it is in most apps, with one screen to
                // push over it: a view that is left for another closes its attempt, and is
                // on its first screen when it is come back to.
                NavigationStack {
                    VStack(spacing: 0) {
                        TulaAuthView(client: client) {
                            phase = .signedIn
                        }
                        NavigationLink {
                            AboutView()
                        } label: {
                            Text("About this example")
                                .font(.body)
                                .underline()
                                .foregroundColor(.primary)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("example.about")
                    }
                }
            case .signedIn:
                AccountView(client: client, onForget: onForget) {
                    phase = .signedOut
                }
            }
        }
        .task {
            while !Task.isCancelled {
                do {
                    let state = try await client.session.load()
                    if case .signedIn = state {
                        phase = .signedIn
                    } else {
                        phase = .signedOut
                    }
                    return
                } catch {
                    // A Keychain that could not be read is not "signed out": say so and ask
                    // again.
                    loadFailed = true
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }
}

/// A screen of the app's own, pushed over the sign-in.
struct AboutView: View {
    var body: some View {
        Text("This example signs in with the Tula screens. Go back to sign in.")
            .multilineTextAlignment(.center)
            .padding()
            .accessibilityIdentifier("example.aboutText")
            .navigationTitle("About")
    }
}

/// The signed-in app: a line of its own, and the Tula account screen under it.
///
/// The account screen signs out itself, and says so when the server could not be told: it
/// calls `onSignedOut` only for a sign-out that went through.
struct AccountView: View {
    let client: TulaClient
    let onForget: () -> Void
    let onSignedOut: () -> Void

    @State private var email: String?

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 4) {
                Text("You are signed in")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                    // As many lines as a large text size needs, never cut off.
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("example.signedIn")
                if let email {
                    // A sentence, on as many lines as it needs: an address alone is read out
                    // letter by letter and is cut off at a large text size.
                    Text("Signed in as \(email)")
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("example.email")
                }
            }
            .padding(.top)
            // The example gives its client no passkey sheet, so the account screen says in
            // words that passkeys cannot be created here. An app that offers them passes
            // `SystemPasskeySheet()` when it makes its client (docs/swift.md, "Passkeys").
            TulaAccountView(client: client) {
                onSignedOut()
            }
            Button(action: onForget) {
                Text("Use another API or key")
                    .underline()
                    // The text colour, not the tint: the tint's contrast is too low for
                    // body text on this background.
                    .foregroundColor(.primary)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("example.forget")
        }
        .task {
            for await state in await client.session.updates() {
                if case .signedIn(_, let user) = state {
                    email = user?.email ?? email
                }
            }
        }
    }
}
