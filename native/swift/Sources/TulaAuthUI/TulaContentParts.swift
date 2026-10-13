import Foundation
import TulaAuth

// The parts a screen's content is made of, whichever screen it is: a field, a button or a
// link, a setup key, a list of codes. The sign-in screens and the account screen say what
// they hold with the same parts and differ only in what a control does (`Action`), so that
// one set of views draws both and neither decides anything.

/// One field of a screen.
public struct TulaFieldContent<Action: Hashable & Sendable>: Hashable, Sendable {
    /// The field.
    public let field: TulaAuthField
    /// What it asks of the keyboard and of autofill.
    public let kind: TulaAuthFieldKind
    /// Its label.
    public let label: String
    /// A hint under it, when it has one.
    public let hint: String?
    /// What the keyboard's "go" does: the screen's main action.
    public let submit: Action
}

/// A button or a link of a screen: its words and the action it performs.
public struct TulaOffer<Action: Hashable & Sendable>: Hashable, Sendable {
    /// The control's accessibility identifier: `tula.primary`, `tula.link.reset`.
    public let identifier: String
    /// The words on it.
    public let title: String
    /// What it does.
    public let action: Action
    /// A sentence drawn before it, when it has one: "New here?".
    public let lead: String?
    /// What VoiceOver reads for it where the words alone would not say what it acts on:
    /// "Sign out iPhone or iPad app" for a row's "Sign out".
    public let spoken: String?
    /// Whether it removes or ends something: drawn in the danger colour, and said by its
    /// words, never by the colour alone.
    public let destructive: Bool

    init(
        _ name: String, _ title: String, _ action: Action, lead: String? = nil, spoken: String? = nil,
        destructive: Bool = false
    ) {
        identifier = "tula.link.\(name)"
        self.title = title
        self.action = action
        self.lead = lead
        self.spoken = spoken
        self.destructive = destructive
    }

    init(primary title: String, _ action: Action, destructive: Bool = false) {
        identifier = "tula.primary"
        self.title = title
        self.action = action
        lead = nil
        spoken = nil
        self.destructive = destructive
    }
}

/// The setup key of an authenticator app, as a screen draws it: the QR code, the key in
/// words, and the button that copies it. Prints as its type's name.
public struct TulaSetupContent<Action: Hashable & Sendable>: Hashable, Sendable, TulaRedacted {
    /// The `otpauth://` address the QR code is drawn from.
    public let uri: String
    /// The setup key, to type by hand.
    public let key: String
    /// What the QR code is read as.
    public let qrLabel: String
    /// The key's label.
    public let keyLabel: String
    /// Under the key.
    public let keyHint: String
    /// The button that copies the key.
    public let copy: TulaOffer<Action>
}

/// Backup codes, as a screen draws them. Prints as its type's name.
public struct TulaCodesContent<Action: Hashable & Sendable>: Hashable, Sendable, TulaRedacted {
    /// What the list is read as.
    public let label: String
    /// The codes.
    public let codes: [String]
    /// The button that copies them.
    public let copy: TulaOffer<Action>
}

/// A field of the sign-in screens.
public typealias TulaAuthFieldContent = TulaFieldContent<TulaAuthAction>
/// A button or a link of the sign-in screens.
public typealias TulaAuthOffer = TulaOffer<TulaAuthAction>
/// The setup key on the sign-in screens.
public typealias TulaAuthSetupContent = TulaSetupContent<TulaAuthAction>
/// The backup codes on the sign-in screens.
public typealias TulaAuthCodesContent = TulaCodesContent<TulaAuthAction>

// MARK: Where a problem is said

/// Where the problems of a failed call are said on a screen: under which fields, or above
/// the form.
struct TulaPlacedProblems {
    /// The messages by field.
    var fields: [TulaAuthField: [String]] = [:]
    /// The message above the form, when what went wrong is about no field of the screen.
    var above: String?

    /// Sort an error's problems onto a screen's fields.
    ///
    /// - Parameters:
    ///   - error: The failed call's error.
    ///   - fields: The fields of the open screen, in the order they are drawn.
    ///   - strings: The table the messages are taken from, by code.
    ///   - wrong: What a refused secret is said as on this screen, and at which field: the
    ///     server answers a wrong password and a wrong code with one code, whose sentence
    ///     is about an address and a password.
    ///   - refusals: The codes that mean "the secret was refused" on this screen, and are
    ///     said as `wrong`. `auth.invalid_credentials` alone by default; a step-up adds
    ///     `mfa.invalid_code`, which is what the server answers a wrong code there with.
    init(
        _ error: TulaError, fields shown: [TulaAuthField], strings: TulaStrings,
        wrong: (TulaAuthField, String)? = nil,
        refusals: Set<String> = [ErrorCode.authInvalidCredentials.rawValue]
    ) {
        let secret: TulaAuthField = shown.contains(.newPassword) ? .newPassword : .password
        let code: TulaAuthField = shown.contains(.backupCode) ? .backupCode : .code
        let byName: [String: TulaAuthField] = [
            "email": .email, "identifier": .email, "password": secret, "newPassword": secret,
            "currentPassword": .currentPassword, "code": code, "phoneNumber": .phoneNumber, "name": .name,
        ]
        func target(_ problem: String, named: String?) -> TulaAuthField? {
            var found: TulaAuthField?
            if let named, let field = byName[named] {
                found = field
            } else if wrong != nil, refusals.contains(problem) {
                found = wrong?.0
            } else if problem == ErrorCode.authInvalidCredentials.rawValue {
                // The server never says which part was wrong: shown at the last thing typed.
                found = shown.last
            } else {
                switch problem.split(separator: ".").first.map(String.init) {
                case "email": found = .email
                case "password": found = secret
                case "verification", "mfa": found = code
                case "phone": found = .phoneNumber
                default: found = nil
                }
            }
            return found.flatMap { shown.contains($0) ? $0 : nil }
        }
        func words(_ problem: String, _ known: String) -> String {
            refusals.contains(problem) ? (wrong?.1 ?? known) : known
        }
        for problem in error.errors {
            if let field = target(problem.code, named: problem.field) {
                let message = words(problem.code, strings.message(for: problem))
                if self.fields[field]?.contains(message) != true {
                    self.fields[field, default: []].append(message)
                }
            } else {
                above = strings.message(for: error)
            }
        }
        if error.errors.isEmpty {
            if let field = target(error.code, named: nil) {
                self.fields[field] = [words(error.code, strings.message(for: error))]
            } else {
                above = strings.message(for: error)
            }
        }
        if let wait = error.retryAfter, wait > 0, let message = above {
            above = message + " " + TulaStrings.format(strings.retryIn, ["time": strings.duration(wait)])
        }
    }
}

extension TulaStrings {
    /// The message of a code that did not come with an error: one a provider's page came
    /// back with.
    ///
    /// - Parameter code: A code of the contract.
    /// - Returns: `errors[code]`, or the contract's English sentence, or `unknownError`.
    public func message(code: String) -> String {
        if let own = errors[code] {
            return own
        }
        return TulaErrorDefinitions.all.first { $0.code.rawValue == code }?.message ?? unknownError
    }

    /// A date the server wrote, in words, or `nil` when it is not one.
    ///
    /// - Parameters:
    ///   - text: An ISO 8601 time, as the API writes them.
    ///   - format: How a date is said.
    static func date(_ text: String?, _ format: (Date) -> String) -> String? {
        guard let text else {
            return nil
        }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)).map(format)
    }
}

/// How text a person asked to copy is put on the pasteboard: a setup key or backup codes,
/// which are secrets. The view that writes the pasteboard reads this and decides nothing.
enum TulaCopyRule {
    /// Kept on this device: not handed to the account's other devices.
    static let localOnly = true
    /// How long the text stays on the pasteboard, where the system can take it back.
    static let lifetime: TimeInterval = 60

    /// When text copied at `now` is taken off the pasteboard.
    static func expiry(from now: Date) -> Date {
        now.addingTimeInterval(lifetime)
    }
}
