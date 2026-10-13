import ExpoModulesCore
import TulaAuth
import TulaAuthUI
import UIKit

// `TulaScreens`: Tula's SwiftUI screens and the session of the Swift client under them, for
// an Expo app (ADR 0063). Everything that decides something is in `TulaScreensHost.swift`;
// this file names the module's functions, events, views and props.
//
// The client owns the tokens and the refresh. JavaScript is told the session's state (a
// status and two ids) and may ask for an access token for the app's own backend; the
// refresh token never leaves the Keychain, and nothing of a token is in an event.

/// The one event of the module: the session's state, when it changes.
private let sessionEvent = "onSessionChange"

/// What a failed call is, in JavaScript: a code and one fixed sentence around it.
private func crossing(_ error: Error) -> Exception {
    let code = TulaScreensFailure(error).code
    return Exception(name: "TulaScreensException", description: "Tula: the call failed (\(code)).", code: code)
}

public final class TulaScreensModule: Module {
    private var watching: Task<Void, Never>?

    public func definition() -> ModuleDefinition {
        Name("TulaScreens")

        Events(sessionEvent)

        Function("configure") { (options: [String: Any]) in
            do {
                try TulaScreensHost.shared.configure(options)
            } catch {
                throw crossing(error)
            }
        }

        AsyncFunction("load") { () async throws -> [String: Any] in
            do {
                return tulaStateBody(try await TulaScreensHost.shared.require().session.load())
            } catch {
                throw crossing(error)
            }
        }

        AsyncFunction("getState") { () async throws -> [String: Any] in
            do {
                return tulaStateBody(try await TulaScreensHost.shared.require().session.state)
            } catch {
                throw crossing(error)
            }
        }

        AsyncFunction("getToken") { () async throws -> String? in
            do {
                return try await TulaScreensHost.shared.require().session.getToken()
            } catch {
                throw crossing(error)
            }
        }

        AsyncFunction("signOut") { () async throws in
            do {
                try await TulaScreensHost.shared.require().session.signOut()
            } catch {
                throw crossing(error)
            }
        }

        OnStartObserving {
            self.watching?.cancel()
            guard let client = TulaScreensHost.shared.client else {
                return
            }
            self.watching = Task { [weak self] in
                for await state in await client.session.updates() {
                    self?.sendEvent(sessionEvent, tulaStateBody(state))
                }
            }
        }

        OnStopObserving {
            self.watching?.cancel()
            self.watching = nil
        }

        View(TulaAuthScreenView.self) {
            Events("onSignedIn")

            Prop("mode") { (view: TulaAuthScreenView, mode: String?) in
                view.mode = mode == "sign-up" ? .signUp : .signIn
            }

            Prop("theme") { (view: TulaAuthScreenView, theme: [String: Any]?) in
                view.theme = tulaTheme(theme)
            }

            Prop("redirectUrl") { (view: TulaAuthScreenView, redirectUrl: String?) in
                view.redirectURL = redirectUrl
            }

            OnViewDidUpdateProps { (view: TulaAuthScreenView) in
                view.render()
            }
        }

        View(TulaAccountScreenView.self) {
            Events("onSignedOut")

            Prop("theme") { (view: TulaAccountScreenView, theme: [String: Any]?) in
                view.theme = tulaTheme(theme)
            }

            OnViewDidUpdateProps { (view: TulaAccountScreenView) in
                view.render()
            }
        }
    }
}

/// Sign-in, sign-up and password reset: `TulaAuthUI`'s `TulaAuthView` on the module's
/// client. It draws nothing until the module was configured.
final class TulaAuthScreenView: ExpoView {
    /// Sent once per completed sign-in or sign-up. It carries nothing.
    let onSignedIn = EventDispatcher()

    var mode: TulaAuthMode = .signIn
    /// The theme, as untrusted strings: `TulaAuthView` checks every value.
    var theme: TulaTheme = .defaults
    /// Where a provider's page comes back to. The server judges it, never this view.
    var redirectURL: String?

    private let holder = TulaScreenHolder()

    func render() {
        let told = onSignedIn
        holder.show(
            tulaAuthScreen(mode: mode, theme: theme, redirectURL: redirectURL) { told([:]) },
            // A change of either starts the screen over, as a new `TulaAuthView` would.
            identity: "\(mode == .signUp ? "sign-up" : "sign-in")\n\(redirectURL ?? "")",
            in: self)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        holder.fill(self)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            holder.detach()
        } else {
            holder.attach(to: self)
        }
    }
}

/// The signed-in user's account: `TulaAuthUI`'s `TulaAccountView` on the module's client.
final class TulaAccountScreenView: ExpoView {
    /// Sent for a sign-out the server was told of, never for one that failed.
    let onSignedOut = EventDispatcher()

    /// The theme, as untrusted strings: `TulaAccountView` checks every value.
    var theme: TulaTheme = .defaults

    private let holder = TulaScreenHolder()

    func render() {
        let told = onSignedOut
        holder.show(tulaAccountScreen(theme: theme) { told([:]) }, identity: "account", in: self)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        holder.fill(self)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            holder.detach()
        } else {
            holder.attach(to: self)
        }
    }
}
