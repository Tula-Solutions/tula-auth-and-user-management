import AuthenticationServices
import Foundation
import SwiftUI
import TulaAuth
import TulaAuthUI
import UIKit

// What the Expo module of `@tula-tech/expo-screens` is made of, with nothing of Expo in
// it (ADR 0063): the one client of the process, what JavaScript is told of its session, the
// theme a screen is drawn with, and the UIKit view that holds a SwiftUI screen. The module
// (`TulaScreensModule.swift`) is the binding and holds no rule of its own.

/// The module's own codes, beside the client's. The JavaScript side has the sentence of each.
enum TulaScreensCode {
    /// A call before `configure`.
    static let notConfigured = "screens.not_configured"
    /// A second `configure` with other options: one client for the life of the process.
    static let alreadyConfigured = "screens.already_configured"
    /// Options the native client refuses.
    static let invalidOptions = "screens.invalid_options"
    /// Anything that is not a code of the closed set: see `crossing`.
    static let `internal` = "internal"

    private static let own: Set<String> = [notConfigured, alreadyConfigured, invalidOptions, `internal`]

    /// The Swift client's own codes: what it says of a call no server answered.
    private static let client: Set<String> = [
        TulaClientErrorCode.networkFailed,
        TulaClientErrorCode.networkTimeout,
        TulaClientErrorCode.responseInvalid,
        TulaClientErrorCode.storageFailed,
        TulaClientErrorCode.flowBusy,
        TulaClientErrorCode.deviceKeyFailed,
        TulaClientErrorCode.passkeyUnsupported,
        TulaClientErrorCode.passkeyAlreadyOnDevice,
        TulaClientErrorCode.passkeyFailed,
        TulaClientErrorCode.providerUnsupported,
        TulaClientErrorCode.providerFailed,
    ]

    /// The code that crosses to JavaScript for `raw`: `raw` itself when it is one of a
    /// closed set, and `internal` for everything else.
    ///
    /// A `TulaError`'s code is the server's own string. The set is the module's codes, the
    /// client's and the codes of the contract this version was generated from
    /// (`ErrorCode`); a code a newer server made up, and anything else a server put where
    /// a code goes, is not passed on (ADR 0063).
    static func crossing(_ raw: String) -> String {
        if own.contains(raw) || client.contains(raw) {
            return raw
        }
        if case .unknown = ErrorCode(rawValue: raw) {
            return `internal`
        }
        return raw
    }
}

/// An error as it crosses to JavaScript: a code of the closed set and nothing else. Nothing
/// of what was thrown is kept: a server's own words and a framework's error text never
/// cross.
struct TulaScreensFailure: Error, Hashable {
    let code: String

    /// The code of anything a call of the client threw.
    init(_ error: Error) {
        let raw = (error as? TulaScreensFailure)?.code ?? (error as? TulaError)?.code ?? TulaScreensCode.internal
        code = TulaScreensCode.crossing(raw)
    }

    init(code raw: String) {
        code = TulaScreensCode.crossing(raw)
    }
}

/// What the session is, as JavaScript is told: a status and two ids. Never a token.
func tulaStateBody(_ state: AuthState) -> [String: Any] {
    switch state {
    case .loading:
        return ["status": "loading"]
    case .signedOut:
        return ["status": "signed-out"]
    case let .signedIn(sessionId, user):
        var body: [String: Any] = ["status": "signed-in", "sessionId": sessionId]
        if let user {
            body["userId"] = user.id
        }
        return body
    }
}

/// The theme a screen is drawn with: the default, with the values JavaScript sent in place
/// of the default's. JavaScript sends only values it checked with the contract's grammar,
/// and the screens check every value again before they draw one (`TulaResolvedTheme`): what
/// this function builds is still untrusted strings. A key that is not a token, and a value
/// that is no string, are left out.
func tulaTheme(_ overrides: [String: Any]?) -> TulaTheme {
    var theme = TulaTheme.defaults
    guard let overrides else {
        return theme
    }
    func scheme(_ from: TulaThemeScheme, _ source: Any?) -> TulaThemeScheme {
        guard let given = source as? [String: Any] else {
            return from
        }
        var scheme = from
        func set(_ path: WritableKeyPath<TulaThemeScheme, String>, _ key: String) {
            if let value = given[key] as? String {
                scheme[keyPath: path] = value
            }
        }
        set(\.background, "background")
        set(\.surface, "surface")
        set(\.input, "input")
        set(\.text, "text")
        set(\.textMuted, "textMuted")
        set(\.primary, "primary")
        set(\.primaryHover, "primaryHover")
        set(\.primaryText, "primaryText")
        set(\.link, "link")
        set(\.border, "border")
        set(\.borderStrong, "borderStrong")
        set(\.danger, "danger")
        set(\.dangerSurface, "dangerSurface")
        set(\.success, "success")
        set(\.focus, "focus")
        set(\.overlay, "overlay")
        set(\.shadow, "shadow")
        return scheme
    }
    func set(_ path: WritableKeyPath<TulaTheme, String>, _ key: String) {
        if let value = overrides[key] as? String {
            theme[keyPath: path] = value
        }
    }
    theme.light = scheme(theme.light, overrides["light"])
    theme.dark = scheme(theme.dark, overrides["dark"])
    set(\.radius, "radius")
    set(\.radiusSmall, "radiusSmall")
    set(\.fontFamily, "fontFamily")
    set(\.fontFamilyMono, "fontFamilyMono")
    set(\.fontSize, "fontSize")
    set(\.fontSizeSmall, "fontSizeSmall")
    set(\.fontSizeTitle, "fontSizeTitle")
    set(\.spacing, "spacing")
    return theme
}

/// The window a sheet or the browser is shown over: the app's key window.
@MainActor
private func tulaAnchor() -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let windows = scenes.flatMap(\.windows)
    return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
}

/// The one client of the process, and what it was made with.
///
/// Two clients over one Keychain entry would each refresh the same token. So `configure`
/// makes the client once; the same options again (a JavaScript reload) change nothing, and
/// other options are refused.
final class TulaScreensHost: @unchecked Sendable {
    static let shared = TulaScreensHost()

    private let lock = NSLock()
    private var held: TulaClient?
    private var madeWith: [String] = []

    /// The client, when the module was configured.
    var client: TulaClient? {
        lock.lock()
        defer { lock.unlock() }
        return held
    }

    /// The client, or the code that says there is none yet.
    func require() throws -> TulaClient {
        guard let client else {
            throw TulaScreensFailure(code: TulaScreensCode.notConfigured)
        }
        return client
    }

    func configure(_ options: [String: Any]) throws {
        guard
            let publishableKey = options["publishableKey"] as? String,
            let baseURL = options["baseUrl"] as? String
        else {
            throw TulaScreensFailure(code: TulaScreensCode.invalidOptions)
        }
        let sessionProfile = options["sessionProfile"] as? String
        // Each switch is read by its name into a value of that name: never by a position.
        func flag(_ name: String) -> Bool {
            options[name] as? Bool == true
        }
        let deviceBinding = flag("deviceBinding")
        let passkeys = flag("passkeys")
        let apple = flag("apple")
        let browser = flag("browser")
        let identity =
            [publishableKey, baseURL, sessionProfile ?? ""]
            + [deviceBinding, passkeys, apple, browser].map { $0 ? "1" : "0" }
        lock.lock()
        defer { lock.unlock() }
        if held != nil {
            if madeWith == identity {
                return
            }
            throw TulaScreensFailure(code: TulaScreensCode.alreadyConfigured)
        }
        do {
            // The default storage is the Keychain: the refresh token is kept there and
            // nowhere else.
            held = try TulaClient(
                publishableKey: publishableKey,
                baseURL: baseURL,
                sessionProfile: sessionProfile,
                deviceKeys: deviceBinding ? KeychainDeviceKeyStore() : nil,
                passkeys: passkeys ? SystemPasskeySheet(anchor: { tulaAnchor() }) : nil,
                apple: apple ? SystemAppleSheet(anchor: { tulaAnchor() }) : nil,
                browser: browser ? SystemBrowserSession(anchor: { tulaAnchor() }) : nil
            )
        } catch {
            throw TulaScreensFailure(code: TulaScreensCode.invalidOptions)
        }
        madeWith = identity
    }
}

/// A SwiftUI screen inside a UIKit view: what the module's two React Native views hold.
///
/// The screen is made again whenever what it was made with changes; its model is SwiftUI
/// state, so a change of `identity` (the mode, the redirect URL) starts the screen over,
/// which discards an open flow, and a change of theme alone keeps it.
@MainActor
final class TulaScreenHolder {
    private var controller: UIHostingController<AnyView>?

    /// Put `screen` into `view`, in place of what was there.
    func show<Screen: View>(_ screen: Screen, identity: String, in view: UIView) {
        let root = AnyView(screen.id(identity))
        if let controller {
            controller.rootView = root
            return
        }
        let made = UIHostingController(rootView: root)
        made.view.backgroundColor = .clear
        made.view.frame = view.bounds
        made.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(made.view)
        controller = made
        attach(to: view)
    }

    /// Give the screen the whole of the view it is in, whenever that view is laid out.
    func fill(_ view: UIView) {
        controller?.view.frame = view.bounds
    }

    /// Make the hosting controller a child of the view controller the view is shown by, so
    /// that the keyboard and the safe area reach the screen. Called when the view enters a
    /// window; without a parent the screen is still drawn.
    func attach(to view: UIView) {
        guard let controller, controller.parent == nil, view.window != nil else {
            return
        }
        var responder: UIResponder? = view
        while let next = responder?.next {
            if let parent = next as? UIViewController {
                parent.addChild(controller)
                controller.didMove(toParent: parent)
                return
            }
            responder = next
        }
    }

    /// Take the hosting controller out of its parent, when the view leaves its window.
    func detach() {
        guard let controller, controller.parent != nil else {
            return
        }
        controller.willMove(toParent: nil)
        controller.removeFromParent()
    }
}

/// The sign-in and sign-up screen for the module's client, or nothing before `configure`.
@MainActor
func tulaAuthScreen(
    mode: TulaAuthMode, theme: TulaTheme, redirectURL: String?, onSignedIn: @escaping @MainActor () -> Void
) -> AnyView {
    guard let client = TulaScreensHost.shared.client else {
        return AnyView(EmptyView())
    }
    return AnyView(
        TulaAuthView(
            client: client, mode: mode, theme: theme, options: TulaAuthOptions(redirectURL: redirectURL),
            onSignedIn: onSignedIn))
}

/// The account screen for the module's client, or nothing before `configure`.
@MainActor
func tulaAccountScreen(theme: TulaTheme, onSignedOut: @escaping @MainActor () -> Void) -> AnyView {
    guard let client = TulaScreensHost.shared.client else {
        return AnyView(EmptyView())
    }
    return AnyView(TulaAccountView(client: client, theme: theme, onSignedOut: onSignedOut))
}
