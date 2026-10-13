import SwiftUI
import TulaAuth
import TulaAuthUI

/// What the app shows for each state of the session: the Tula screens while signed out, and
/// its own content once somebody is signed in.
struct SessionView: View {
    let client: TulaClient
    let onForget: () -> Void

    @State private var state: AuthState = .loading
    @State private var loadFailed = false

    var body: some View {
        Group {
            switch state {
            case .loading:
                VStack(spacing: 12) {
                    ProgressView()
                    Text(loadFailed ? "Your session could not be read. Trying again…" : "Loading…")
                }
            case .signedOut:
                // The few lines an app writes. Theme it, word it and replace its parts:
                // docs/swift.md, "Screens".
                TulaAuthView(client: client)
            case .signedIn(_, let user):
                AccountView(client: client, user: user, onForget: onForget)
            }
        }
        .task {
            // The session's states, from now on: a sign-in by the screens above arrives
            // here, and so does a sign-out.
            for await next in await client.session.updates() {
                state = next
            }
        }
        .task {
            while !Task.isCancelled {
                do {
                    _ = try await client.session.load()
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

/// The signed-in app: who is signed in, and the way out.
struct AccountView: View {
    let client: TulaClient
    let user: CurrentUser?
    let onForget: () -> Void

    @State private var signingOut = false
    @State private var signOutFailed = false

    var body: some View {
        VStack(spacing: 16) {
            Text("You are signed in")
                .font(.title2.bold())
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("example.signedIn")
            if let email = user?.email {
                Text(email).accessibilityIdentifier("example.email")
            }
            if signOutFailed {
                // A failed sign-out is not a sign-out: the server was not told, so the
                // session may still be active.
                Text("Error: could not sign out. Your session may still be active. Try again.")
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("example.signOutFailed")
            }
            Button(signingOut ? "Signing out…" : "Sign out") {
                signingOut = true
                signOutFailed = false
                Task {
                    do {
                        try await client.session.signOut()
                    } catch {
                        signOutFailed = true
                    }
                    signingOut = false
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(signingOut)
            .accessibilityIdentifier("example.signOut")
            Button("Use another API or key", action: onForget)
        }
        .padding()
    }
}
