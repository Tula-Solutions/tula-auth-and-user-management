import Foundation
import TulaAuth

/// Every string the screens show: one table, in English by default.
///
/// An app translates, or rewords, by changing the properties it wants and handing the table
/// to the view (`TulaAuthView(client:strings:)`):
///
/// ```swift
/// var strings = TulaStrings.english
/// strings.signInTitle = "Welcome back"
/// strings.errors["auth.invalid_credentials"] = "That did not match. Try again."
/// ```
///
/// A value in `{braces}` is filled in by the screens (`{appName}`, `{destination}`, `{time}`,
/// `{label}`, `{message}`); a string that leaves one out simply does not show it. Every
/// string is drawn as text: nothing here is parsed as Markdown, HTML or a link.
///
/// **A server's error is shown by its code, never by the server's own words.** The message
/// of a code is `errors[code]` when the table has one, otherwise the contract's English
/// sentence for a code this version knows, otherwise `unknownError`: text a server wrote is
/// never put on the screen.
public struct TulaStrings: Hashable, Sendable {
    // MARK: Common

    /// Said of a button whose action is being sent, and of the screen while it starts.
    public var loading = "Loading…"
    /// Under a field that was left empty.
    public var required = "This field is required."
    /// Goes back to the screen before.
    public var back = "Back"
    /// The last line of every screen.
    public var securedBy = "Secured by Tula"
    /// What a field's label is followed by, for VoiceOver, when the field has a problem.
    /// `{label}` is the field's label and `{message}` its problems.
    public var fieldInvalid = "{label}, invalid: {message}"
    /// What a problem under a field starts with, so that it is one in words and not only
    /// in colour. `{message}` is the problem.
    public var errorPrefix = "Error: {message}"
    /// After a `rate_limited` answer that says how long to wait. `{time}` is the wait.
    public var retryIn = "Try again in {time}."
    /// A wait under a minute. `{seconds}` is the number.
    public var seconds = "{seconds}s"
    /// A wait of a minute or more.
    public var minutesSeconds = "{minutes}m {seconds}s"

    // MARK: Sign-in

    /// The title of the screen a sign-in starts on.
    public var signInTitle = "Sign in"
    /// `{appName}` is the environment's app name.
    public var signInSubtitle = "to continue to {appName}"
    /// The subtitle while, or where, the app's name is not known.
    public var signInSubtitleNoApp = "Welcome back"
    /// The label of the address field, on every screen that has one.
    public var emailLabel = "Email address"
    /// The button that starts a sign-in or a sign-up.
    public var continueButton = "Continue"
    /// The title of the password step.
    public var passwordTitle = "Enter your password"
    /// The label of the password field.
    public var passwordLabel = "Password"
    /// The button that sends the password.
    public var signInSubmit = "Sign in"
    /// The link from a sign-in to a password reset.
    public var forgotPassword = "Forgot password?"
    /// Beside the address a sign-in is for: goes back to change it.
    public var changeEmail = "Change"
    /// What the address a sign-in is for is read as. `{email}` is the address.
    public var signingInAs = "Signing in as {email}"
    /// The words before the link to the sign-up.
    public var noAccount = "New here?"
    /// The link from a sign-in to a sign-up.
    public var signUpLink = "Create an account"
    /// Said, and shown, when a flow has signed somebody in.
    public var signedIn = "You are signed in."
    /// The link from the emailed code back to the password.
    public var usePassword = "Use your password"
    /// The button, and the link, that asks for an emailed sign-in code.
    public var emailCode = "Email me a code"
    /// The title of the emailed sign-in code's screens.
    public var emailCodeTitle = "Check your email"
    /// Under the title, before the code was asked for.
    public var emailCodePrompt = "We will email you a 6-digit code to sign in with."
    /// `{destination}` is the masked address the server sent the code to.
    public var emailCodeSubtitle = "Enter the 6-digit code we sent to {destination}."
    /// The link that asks for another sign-in email.
    public var emailResend = "Send a new email"
    /// Said, and shown, once another sign-in email was asked for.
    public var emailResent = "A new email is on its way."

    // MARK: Sign-up

    /// The title of the screen a sign-up starts on.
    public var signUpTitle = "Create your account"
    /// Under the sign-up's title.
    public var signUpSubtitle = "Welcome! Sign up to get started."
    /// The password field's label where the environment lets a sign-up go without one.
    public var passwordOptionalLabel = "Password (optional)"
    /// Under that field: what leaving it empty means.
    public var passwordOptionalHint = "Leave it empty to sign in with a code we email you instead."
    /// The words before the link to the sign-in.
    public var haveAccount = "Already have an account?"
    /// The link from a sign-up to a sign-in.
    public var signInLink = "Sign in"

    // MARK: The emailed code

    /// The title of the step that verifies an address.
    public var verificationTitle = "Check your email"
    /// `{destination}` is the masked address the server sent the code to.
    public var verificationSubtitle = "Enter the 6-digit code we sent to {destination}."
    /// The label of the code field.
    public var codeLabel = "Verification code"
    /// Under the code field: what a code looks like.
    public var codeHint = "6 digits"
    /// Under the code field when it holds fewer than six digits.
    public var codeIncomplete = "Enter the 6-digit code."
    /// The button that sends the code.
    public var verifySubmit = "Verify"
    /// The link that asks for another code.
    public var resend = "Resend code"
    /// Said, and shown, once another code was asked for.
    public var resent = "A new code is on its way."

    // MARK: Password reset

    /// The title of the screen a reset starts on.
    public var resetTitle = "Reset your password"
    /// Under the reset's title.
    public var resetSubtitle = "Enter your email address and we will send you a code."
    /// The button that starts a reset.
    public var sendCode = "Send code"
    /// The title of the step that takes the code and the new password.
    public var newPasswordTitle = "Choose a new password"
    /// `{destination}` is the masked address the server sent the code to.
    public var newPasswordSubtitle = "Enter the 6-digit code we sent to {destination} and a new password."
    /// The label of a new password's field.
    public var newPasswordLabel = "New password"
    /// The button that sends the code and the new password.
    public var resetSubmit = "Reset password"
    /// The link from a reset back to the sign-in.
    public var backToSignIn = "Back to sign in"

    // MARK: An expired password

    /// The title of the last step of a sign-in whose password is too old.
    public var expiredPasswordTitle = "Your password has expired"
    /// Under that title.
    public var expiredPasswordSubtitle = "Choose a new password to finish signing in."
    /// The button that stores the new password and finishes the sign-in.
    public var expiredPasswordSubmit = "Save password and sign in"

    // MARK: Showing a password

    /// What the button in a password field is read as while the password is hidden.
    public var showPassword = "Show password"
    /// What it is read as while the password is shown.
    public var hidePassword = "Hide password"

    // MARK: A step this version has no screen for

    /// The title of the screen for a step this version cannot continue.
    public var notSupportedTitle = "This step is not supported"
    /// Under that title: what a person can do.
    public var notSupportedMessage =
        "This version of the app cannot continue this sign-in. Update the app, or sign in another way."
    /// The button that discards the attempt and goes back to the first screen.
    public var startAgain = "Start again"
    /// Above the first screen, when a button found that its attempt was no longer open.
    public var flowLost = "That attempt is no longer open. Start again."
    /// On the signed-in screen, when the flow completed and the session could not be stored
    /// (`storage.failed`): the client is signed in for as long as the app runs. "May",
    /// because a later refresh that succeeds stores the session after all.
    public var sessionNotSaved =
        "Your session could not be saved on this device. You may be signed out when the app closes."

    // MARK: Errors

    /// Messages by error code (`auth.invalid_credentials`, `network.failed`), for a
    /// translation or another wording. A code that is not here gets the contract's English
    /// sentence.
    public var errors: [String: String] = [:]
    /// The words of the ways to sign in that are not an address and a password: a passkey,
    /// a provider, a texted code.
    public var ways = TulaSignInWayStrings()
    /// The words of the second step and of setting up an authenticator app.
    public var secondStep = TulaSecondStepStrings()
    /// The words of the account screen.
    public var account = TulaAccountStrings()
    /// The message of a code this version does not know. The server's own words for such a
    /// code are never shown.
    public var unknownError = "Something went wrong. Try again."

    /// The English table.
    public static let english = TulaStrings()

    /// The English table.
    public init() {}

    /// The message of an error, by its code.
    ///
    /// - Parameter error: A failed call's error.
    /// - Returns: `errors[code]`, or the contract's (or the client's) English sentence for a
    ///   code this version knows, or `unknownError`.
    public func message(for error: TulaError) -> String {
        message(code: error.code, known: error.message)
    }

    /// The message of one field's problem, by its code.
    ///
    /// - Parameter problem: One entry of a `TulaError`'s `errors`.
    /// - Returns: The message, by the rule of `message(for:)`.
    public func message(for problem: TulaFieldError) -> String {
        message(code: problem.code, known: problem.message)
    }

    private func message(code: String, known: String) -> String {
        if let own = errors[code] {
            return own
        }
        // `known` is the contract's sentence exactly when the code is one this version has;
        // for any other code it is whatever the server wrote, which is not shown.
        return TulaStrings.knownCodes.contains(code) ? known : unknownError
    }

    /// A wait, in words: `42s` or `4m 12s`.
    ///
    /// - Parameter wait: The wait in seconds; a fraction is rounded up.
    public func duration(_ wait: TimeInterval) -> String {
        let total = wait.isFinite ? Int(min(max(wait, 0), 86_400).rounded(.up)) : 0
        let minutes = total / 60
        return minutes > 0
            ? TulaStrings.format(minutesSeconds, ["minutes": String(minutes), "seconds": String(total % 60)])
            : TulaStrings.format(seconds, ["seconds": String(total)])
    }

    /// Fill a string's `{name}` placeholders.
    ///
    /// A value is put in once and never read again: a value that itself holds `{braces}` is
    /// shown as it is. A placeholder with no value is left as written.
    ///
    /// - Parameters:
    ///   - template: A string of the table.
    ///   - values: The values by placeholder name.
    public static func format(_ template: String, _ values: [String: String]) -> String {
        var result = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{") {
            result += rest[rest.startIndex..<open]
            let after = rest[rest.index(after: open)...]
            guard let close = after.firstIndex(of: "}"), let value = values[String(after[after.startIndex..<close])]
            else {
                result += "{"
                rest = after
                continue
            }
            result += value
            rest = after[after.index(after: close)...]
        }
        return result + rest
    }

    /// The codes whose English sentence this version has: the contract's, and the client's
    /// own.
    static let knownCodes: Set<String> = Set(TulaErrorDefinitions.all.map(\.code.rawValue)).union([
        TulaClientErrorCode.networkFailed, TulaClientErrorCode.networkTimeout, TulaClientErrorCode.responseInvalid,
        TulaClientErrorCode.storageFailed, TulaClientErrorCode.flowBusy, TulaClientErrorCode.deviceKeyFailed,
        TulaClientErrorCode.passkeyUnsupported, TulaClientErrorCode.passkeyAlreadyOnDevice,
        TulaClientErrorCode.passkeyFailed, TulaClientErrorCode.providerUnsupported,
        TulaClientErrorCode.providerFailed,
    ])
}
