import Foundation

/// The codes the client raises by itself, before or instead of an answer of the API. They sit
/// beside the contract's codes (`ErrorCode`) so that an app has one error to catch and one
/// field to switch on. A `TulaError` with one of them has `status` 0.
public enum TulaClientErrorCode {
    /// The request never reached the API, or its answer never came back.
    public static let networkFailed = "network.failed"
    /// No answer inside the request's deadline.
    public static let networkTimeout = "network.timeout"
    /// An answer that is not what the API sends (a proxy's page, a wrong base URL).
    public static let responseInvalid = "response.invalid"
    /// The token storage (the Keychain) could not be read or written.
    public static let storageFailed = "storage.failed"
    /// A flow was asked for a second action while one was still being sent.
    public static let flowBusy = "flow.busy"

    /// The default (English) message of a client code; `nil` for a code that is not one.
    static func message(_ code: String) -> String? {
        switch code {
        case networkFailed: return "Could not reach the server. Check your connection and try again."
        case networkTimeout: return "The server took too long to answer. Try again."
        case responseInvalid: return "The server sent a response this app could not read."
        case storageFailed: return "Your session could not be saved on this device."
        case flowBusy: return "Another step of this flow is still being sent. Wait for it to finish."
        default: return nil
        }
    }
}

/// One problem with one field of a request, as the API reports it.
public struct TulaFieldError: Hashable, Sendable {
    /// The field of the request body, e.g. `password`.
    public let field: String
    /// The code, e.g. `password.too_short`.
    public let code: String
    /// The message for the code (the contract's, or the server's own for a code this version
    /// does not know).
    public let message: String
    /// The scalar parameters of the problem, e.g. `["min": .number(10)]`.
    public let params: [String: TulaJSONValue]
}

/// The one error every failed call of the client throws.
///
/// `code` is a code of the contract (`auth.invalid_credentials`) or one of the client's own
/// (`TulaClientErrorCode`). The error holds no token, password, code or attempt secret, and
/// nothing of the failure underneath it: what the network layer or the Keychain said is
/// dropped, because an app logs what it catches.
public struct TulaError: Error, Hashable, Sendable, CustomStringConvertible {
    /// The code as the API writes it (`area.reason`).
    public let code: String
    /// The HTTP status of the answer; 0 when the client raised the error itself.
    public let status: Int
    /// A message for the code, in English: the contract's for a code it has, otherwise the
    /// server's own. An app translates by `code`.
    public let message: String
    /// The scalar parameters the API sent with the code.
    public let params: [String: TulaJSONValue]
    /// The problems of single fields, for a refused request body.
    public let errors: [TulaFieldError]
    /// How long the server asked the client to wait, in seconds, when it said so.
    public let retryAfter: TimeInterval?

    /// The code as the generated enumeration; `unknown` for the client's own codes and for a
    /// code this version of the SDK does not know.
    public var known: ErrorCode { ErrorCode(rawValue: code) }

    /// The code and the status, and nothing else: safe to log.
    public var description: String { "TulaError(\(code), status \(status))" }

    init(
        code: String,
        status: Int = 0,
        message: String? = nil,
        params: [String: TulaJSONValue] = [:],
        errors: [TulaFieldError] = [],
        retryAfter: TimeInterval? = nil
    ) {
        self.code = code
        self.status = status
        self.message = message ?? TulaError.defaultMessage(code) ?? code
        self.params = params
        self.errors = errors
        self.retryAfter = retryAfter
    }

    /// An error of the client's own, or a contract code the client raises itself.
    static func client(_ code: String) -> TulaError {
        TulaError(code: code)
    }

    /// The contract's message for a code, or the client's for one of its own.
    static func defaultMessage(_ code: String) -> String? {
        TulaClientErrorCode.message(code) ?? definitions[code]?.message
    }

    private static let definitions: [String: TulaErrorDefinition] = Dictionary(
        TulaErrorDefinitions.all.map { ($0.code.rawValue, $0) },
        uniquingKeysWith: { first, _ in first }
    )
}
