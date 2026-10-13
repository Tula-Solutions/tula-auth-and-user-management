import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// Scripted stand-ins for the three things of the system a screen can ask the client to
// show, and the answers of the API the screens of TULA-60 are drawn from. No test of this
// target shows a sheet, opens a browser or touches a pasteboard: a `Stage` is given one of
// these or nothing, and what a model copies goes to `Heard.copied`.

/// Something a thrown error says when it is printed: a canary no screen may show.
struct LoudSheetFailure: Error, CustomStringConvertible, LocalizedError {
    static let text = "SHEET-TEXT-CANARY"
    var description: String { LoudSheetFailure.text }
    var errorDescription: String? { LoudSheetFailure.text }
}

/// A passkey sheet that answers what a test tells it to.
final class ScriptedPasskeySheet: TulaPasskeySheet, @unchecked Sendable {
    private let lock = NSLock()
    private var requests = 0
    private var registrations = 0
    private var scripted: Result<PasskeyAssertionCredential, Error> = .success(ScriptedPasskeySheet.assertion)
    private var made: Result<PasskeyRegistrationCredential, Error> = .success(ScriptedPasskeySheet.registration)
    private var gate: Gate?

    static let assertion = PasskeyAssertionCredential(
        id: "Y3JlZC0x", rawId: "Y3JlZC0x",
        response: PasskeyAssertionCredentialResponse(
            clientDataJSON: "Q0FOQVJZLWNsaWVudA", authenticatorData: "Q0FOQVJZLWF1dGg", signature: "Q0FOQVJZLXNpZw",
            userHandle: "dXNyXzE"))
    static let registration = PasskeyRegistrationCredential(
        id: "Y3JlZC0x", rawId: "Y3JlZC0x",
        response: PasskeyRegistrationCredentialResponse(
            clientDataJSON: "Q0FOQVJZLWNsaWVudA", attestationObject: "Q0FOQVJZLWF0dA", transports: ["internal"]))

    /// How many times a passkey was asked for.
    var asked: Int { lock.withLock { requests } }
    /// How many times one was to be made.
    var created: Int { lock.withLock { registrations } }

    /// What the next requests answer: a credential, or what the sheet throws.
    func answer(_ next: Result<PasskeyAssertionCredential, Error>) { lock.withLock { scripted = next } }
    /// What the next registrations answer.
    func make(_ next: Result<PasskeyRegistrationCredential, Error>) { lock.withLock { made = next } }
    /// Keep every request open until the gate is: a sheet that is still on the screen.
    func hold(_ next: Gate?) { lock.withLock { gate = next } }

    func create(_ options: PasskeyCreationOptions) async throws -> PasskeyRegistrationCredential {
        let (held, outcome) = lock.withLock { () -> (Gate?, Result<PasskeyRegistrationCredential, Error>) in
            registrations += 1
            return (gate, made)
        }
        await held?.wait()
        return try outcome.get()
    }

    func get(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertionCredential {
        let held = lock.withLock { () -> Gate? in
            requests += 1
            return gate
        }
        await held?.wait()
        // Read after the wait: a test scripts the answer of a sheet that is open.
        return try lock.withLock { scripted }.get()
    }
}

/// A Sign in with Apple sheet that answers what a test tells it to.
final class ScriptedAppleSheet: TulaAppleSheet, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [String] = []
    private var scripted: Result<TulaAppleCredential, Error> = .success(
        TulaAppleCredential(idToken: "CANARY-id-token", givenName: "Maya", familyName: "Okafor"))

    /// The hashed nonces the sheet was shown with.
    var nonces: [String] { lock.withLock { seen } }

    /// What the next requests answer.
    func answer(_ next: Result<TulaAppleCredential, Error>) { lock.withLock { scripted = next } }

    func authorize(hashedNonce: String) async throws -> TulaAppleCredential {
        try lock.withLock { () -> Result<TulaAppleCredential, Error> in
            seen.append(hashedNonce)
            return scripted
        }.get()
    }
}

/// A browser session that returns what a test tells it to. Nothing is opened.
final class ScriptedBrowser: TulaBrowserSession, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [(url: String, redirect: String)] = []
    private var scripted: @Sendable (String, String) async throws -> String? = { _, _ in nil }

    /// The pages that would have been opened, and the address each was to come back to.
    var opened: [(url: String, redirect: String)] { lock.withLock { seen } }

    /// What the page comes back with: an address, `nil` for a browser that was closed.
    func returns(_ next: @escaping @Sendable (String, String) async throws -> String?) {
        lock.withLock { scripted = next }
    }

    /// The page comes back with the redirect URL and this fragment.
    func returns(fragment: String) {
        returns { _, redirect in "\(redirect)#\(fragment)" }
    }

    func open(url: String, redirectURL: String) async throws -> String? {
        let answer = lock.withLock { () -> @Sendable (String, String) async throws -> String? in
            seen.append((url, redirectURL))
            return scripted
        }
        return try await answer(url, redirectURL)
    }
}

/// Counts the calls of a closure a model was given (Google's own sheet).
final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []

    /// What each call was handed.
    var seen: [String] { lock.withLock { values } }

    func note(_ value: String) { lock.withLock { values.append(value) } }
}

extension Wire {
    static let redirect = "com.example.app://callback"
    static let number = "+1 415 555 0142"
    static let masked = "+1 *** *** **42"

    static let secondFactorRoute = "POST /v1/client/sign-ins/att_1/second-factor"
    static let secondPrepare = "POST /v1/client/sign-ins/att_1/second-factor/prepare"
    static let secondPasskeyOptions = "POST /v1/client/sign-ins/att_1/second-factor/passkey/options"
    static let enrolStart = "POST /v1/client/sign-ins/att_1/factor-enrolment/totp"
    static let enrolConfirm = "POST /v1/client/sign-ins/att_1/factor-enrolment/totp/confirm"
    static let passkeyStart = "POST /v1/client/sign-ins/passkey"
    static let passkeySubmit = "POST /v1/client/sign-ins/att_1/passkey"
    static let idTokens = "POST /v1/client/sign-ins/id-token"
    static let idTokenExchange = "POST /v1/client/sign-ins/att_1/id-token"
    static let oauth = "POST /v1/client/sign-ins/oauth"
    static let oauthExchange = "POST /v1/client/sign-ins/oauth/exchange"

    /// A step this version has never heard of.
    static let tomorrow = #"{"status":"needs_a_step_of_tomorrow","anything":1}"#
    /// What an environment with a password and a texted code offers, whatever was typed.
    static let passwordAndText = #"{"status":"needs_first_factor","strategies":["password","email_code","sms_code"]}"#
    static let passwordAndTextPrepared =
        #"{"status":"needs_first_factor","strategies":["password","email_code","sms_code"],"prepared":{"strategy":"sms_code","destination":"\#(masked)"}}"#
    static let everySecondWay = #"{"status":"needs_second_factor","options":["backup_code","passkey","totp"]}"#
    static let passkeySecond = #"{"status":"needs_second_factor","options":["passkey"]}"#
    static let textedSecond = #"{"status":"needs_second_factor","options":["sms_code"]}"#
    static let textedSecondPrepared =
        #"{"status":"needs_second_factor","options":["sms_code"],"prepared":{"method":"sms_code","destination":"\#(masked)"}}"#
    static let enrolment = #"{"status":"needs_factor_enrolment","methods":["totp"]}"#
    static let setupKey = "JBSWY3DPEHPK3PXP"
    static let setupAddress = "otpauth://totp/Acme:maya@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme"
    static let totpEnrolment = Reply(json: #"{"secret":"\#(setupKey)","uri":"\#(setupAddress)"}"#)
    static let backupCodes = ["aaaaa-bbbbb", "ccccc-ddddd"]
    static let requestOptions =
        #"{"challenge":"Y2hhbGxlbmdl","timeout":300000,"rpId":"example.test","userVerification":"required"}"#

    /// An answer with members beside the attempt's own.
    private static func with(_ reply: Reply, _ more: String) -> Reply {
        Reply(json: String(reply.json.dropLast()) + "," + more + "}")
    }

    /// The answer that confirms an authenticator app: the step it leads to, and the codes.
    static func enrolled(_ step: String = complete) -> Reply {
        with(flow("sign_in", step), #""backupCodes":["aaaaa-bbbbb","ccccc-ddddd"]"#)
    }

    /// A start that carries its attempt in a member (a passkey, an ID token, a provider).
    static func started(_ strategy: String, _ more: String) -> Reply {
        let step = #"{"status":"needs_first_factor","strategies":["\#(strategy)"]}"#
        return Reply(json: #"{"attempt":\#(flow("sign_in", step, start: true).json),\#(more)}"#)
    }

    static let passkeyStarted = started("passkey", #""options":\#(requestOptions)"#)
    static let idTokenStarted = started("oauth_google", #""nonce":"server-nonce""#)
    static let oauthStarted = started(
        "oauth_github", #""authorizationUrl":"https://provider.example/authorize?state=s","binding":"CANARY-binding""#)
    /// What a provider's page comes back with when it went well.
    static let ticket = "tula_ticket=CANARY-ticket&tula_attempt=att_1"

    /// The public configuration of an environment with these ways to sign in.
    static func config(methods: [String], oauth: [String] = []) -> Reply {
        func list(_ values: [String]) -> String { "[" + values.map { "\"\($0)\"" }.joined(separator: ",") + "]" }
        let plain = config(name: "Acme", signUpPassword: "required").json
        let from = #""signIn":{"methods":["password"]}"#
        precondition(plain.contains(from), "the configuration's shape changed")
        return Reply(
            json: plain.replacingOccurrences(
                of: from, with: #""signIn":{"methods":\#(list(methods)),"oauth":\#(list(oauth))}"#))
    }
}

extension Stage {
    /// Read an environment's configuration with these ways to sign in.
    func configure(methods: [String], oauth: [String] = []) async {
        api.on(Wire.config, Wire.config(methods: methods, oauth: oauth))
        await model.loadConfig()
    }

    /// Everything the model shows or says, with what it holds of a setup: for a canary.
    var everything: String {
        shown + "\n" + [model.setup?.key, model.setup?.uri].compactMap { $0 }.joined(separator: "\n") + "\n"
            + model.backupCodes.joined(separator: "\n") + "\n" + heard.copied.joined(separator: "\n")
    }
}

/// The screens of TULA-60 and what each holds, word for word: the rows `ContentTests` adds
/// to its table.
@MainActor
enum MoreScreens {
    private typealias Field = TulaAuthFieldContent
    private typealias Offer = TulaAuthOffer

    static let all: [TulaAuthScreen] = [
        .textedSignInOffer, .textedSignIn(destination: Wire.masked),
        .secondFactor(.totp, others: [.backupCode], sent: nil),
        .secondFactor(.totp, others: [.passkey, .textedCode, .backupCode], sent: nil),
        .secondFactor(.backupCode, others: [.totp], sent: nil), .secondFactor(.passkey, others: [], sent: nil),
        .secondFactor(.textedCode, others: [], sent: nil), .secondFactor(.textedCode, others: [], sent: Wire.masked),
        .enrolmentStart, .totpSetup, .backupCodes,
    ]

    private static let identity = Offer("change", "Change", .showSignIn, lead: "Signing in as maya@example.com")
    private static let back = Offer("back", "Start again", .startAgain)

    private static func code(_ label: String, _ submit: TulaAuthAction) -> Field {
        Field(field: .code, kind: .code, label: label, hint: "6 digits", submit: submit)
    }

    private static func link(_ way: TulaSecondWay) -> Offer {
        switch way {
        case .totp: return Offer("second.totp", "Use your authenticator app", .useSecondWay(.totp))
        case .passkey: return Offer("second.passkey", "Use your passkey instead", .useSecondWay(.passkey))
        case .textedCode: return Offer("second.textedCode", "Get a code by text message", .useSecondWay(.textedCode))
        case .backupCode: return Offer("second.backupCode", "Use a backup code", .useSecondWay(.backupCode))
        }
    }

    static func expected(_ screen: TulaAuthScreen) -> TulaAuthContent {
        switch screen {
        case .textedSignInOffer:
            return TulaAuthContent(
                title: "Check your phone",
                subtitle: "We will text a 6-digit code to this number, if you can sign in with it.",
                identity: identity, primary: Offer(primary: "Text me a code", .sendTextedCode))
        case .textedSignIn:
            return TulaAuthContent(
                title: "Check your phone",
                subtitle: "If this number can sign in, a 6-digit code is on its way to +1 *** *** **42. Enter it below.",
                identity: identity, fields: [code("Verification code", .submitCode)],
                primary: Offer(primary: "Sign in", .submitCode),
                links: [Offer("resend", "Text a new code", .resendCode)])
        case .secondFactor(.totp, let others, _):
            return TulaAuthContent(
                title: "Two-step verification", subtitle: "Enter the 6-digit code from your authenticator app.",
                fields: [code("Authentication code", .submitCode)], primary: Offer(primary: "Verify", .submitCode),
                links: others.map(link) + [back])
        case .secondFactor(.backupCode, let others, _):
            return TulaAuthContent(
                title: "Two-step verification", subtitle: "Enter one of your backup codes. Each code works once.",
                fields: [
                    Field(
                        field: .backupCode, kind: .backupCode, label: "Backup code",
                        hint: "10 characters, for example abcde-fghjk", submit: .submitBackupCode)
                ],
                primary: Offer(primary: "Verify", .submitBackupCode), links: others.map(link) + [back])
        case .secondFactor(.passkey, let others, _):
            return TulaAuthContent(
                title: "Two-step verification", subtitle: "Use your passkey to finish signing in.",
                primary: Offer(primary: "Use your passkey", .useSecondPasskey), links: others.map(link) + [back])
        case .secondFactor(.textedCode, let others, nil):
            return TulaAuthContent(
                title: "Two-step verification",
                subtitle: "We will text a 6-digit code to the phone number on your account.",
                primary: Offer(primary: "Text me a code", .sendTextedCode), links: others.map(link) + [back])
        case .secondFactor(.textedCode, let others, .some):
            return TulaAuthContent(
                title: "Two-step verification", subtitle: "Enter the 6-digit code we texted to +1 *** *** **42.",
                fields: [code("Verification code", .submitCode)], primary: Offer(primary: "Verify", .submitCode),
                links: [Offer("resend", "Text a new code", .resendCode)] + others.map(link) + [back])
        case .enrolmentStart:
            return TulaAuthContent(
                title: "Set up two-step verification",
                subtitle: "This app requires two-step verification. Set up an authenticator app to finish signing in.",
                primary: Offer(primary: "Set up authenticator app", .startEnrolment), links: [back])
        case .totpSetup:
            // Without its key: the key is the situation's, and has a test of its own.
            return TulaAuthContent(
                title: "Set up two-step verification",
                subtitle:
                    "Scan this QR code with your authenticator app, or enter the setup key by hand. Then enter the 6-digit code the app shows.",
                fields: [code("Authentication code", .confirmEnrolment)],
                primary: Offer(primary: "Turn on", .confirmEnrolment), links: [back])
        case .backupCodes:
            return TulaAuthContent(
                title: "Save your backup codes",
                subtitle:
                    "Each code signs you in once if you cannot use your authenticator app. Keep them somewhere safe: they will not be shown again.",
                primary: Offer(primary: "I have saved these codes", .savedBackupCodes),
                codes: TulaAuthCodesContent(
                    label: "Backup codes", codes: [], copy: Offer("copyCodes", "Copy", .copyBackupCodes)))
        default:
            // Every other screen has its row in ContentTests, whose own switch has no default.
            preconditionFailure("not a screen of this table: \(screen)")
        }
    }
}
