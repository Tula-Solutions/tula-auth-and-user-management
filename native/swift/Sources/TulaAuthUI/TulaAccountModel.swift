import Foundation
import TulaAuth

/// A way to prove again that it is the user, when the server asks for it.
public enum TulaStepUpWay: Hashable, Sendable {
    /// The account's password.
    case password
    /// The code of an authenticator app.
    case totp
    /// A backup code.
    case backupCode
    /// An emailed code.
    case emailCode
    /// A texted code.
    case textedCode
    /// A passkey, through the system's sheet.
    case passkey
}

/// Something the account screen asks about before it does it.
public enum TulaAccountConfirmation: Hashable, Sendable {
    /// Remove a passkey. `name` is drawn in the question.
    case removePasskey(id: String, name: String)
    /// Turn the authenticator app off.
    case turnOffAuthenticator
    /// Stop using a texted code as the second step.
    case turnOffTexted
    /// Remove the phone number.
    case removePhone
}

/// What the account screen has open: the account itself, or one form over it.
public enum TulaAccountPanel: Hashable, Sendable {
    /// The account: profile, password, sessions, two-step verification, phone, passkeys.
    case overview
    /// The server asked for proof that it is the user. `others` are the other ways it
    /// named and this app can take; `sent` is the masked destination once a code was asked
    /// for, and `nil` before.
    case stepUp(TulaStepUpWay, others: [TulaStepUpWay], sent: String?)
    /// The server asked for proof and named no way this app can take.
    case stepUpUnavailable
    /// The current password and a new one.
    case changePassword
    /// The setup key of an authenticator app, its QR code and the code field.
    case totpSetup
    /// Backup codes, shown once.
    case backupCodes
    /// The texted code that turns a texted second step on.
    case textedFactor(destination: String)
    /// The phone number to add.
    case phoneNumber
    /// The texted code that proves it.
    case phoneCode(destination: String)
    /// A passkey's new name.
    case renamePasskey(id: String)
    /// A question before something is removed or turned off.
    case confirm(TulaAccountConfirmation)

    /// The fields the panel has, in the order they are drawn.
    public var fields: [TulaAuthField] {
        switch self {
        case .stepUp(let way, _, let sent):
            switch way {
            case .password: return [.password]
            case .totp: return [.code]
            case .backupCode: return [.backupCode]
            case .emailCode, .textedCode: return sent == nil ? [] : [.code]
            case .passkey: return []
            }
        case .changePassword: return [.currentPassword, .newPassword]
        case .totpSetup, .textedFactor, .phoneCode: return [.code]
        case .phoneNumber: return [.phoneNumber]
        case .renamePasskey: return [.name]
        case .overview, .stepUpUnavailable, .backupCodes, .confirm: return []
        }
    }

    var isStepUp: Bool {
        switch self {
        case .stepUp, .stepUpUnavailable: return true
        default: return false
        }
    }
}

/// A part of the account, read by a call of its own.
public enum TulaAccountPart: Hashable, Sendable, CaseIterable {
    /// Who is signed in.
    case user
    /// The user's sessions.
    case sessions
    /// The user's second step.
    case factors
    /// The user's passkeys.
    case passkeys
}

/// What is behind a `TulaAccountView`: what is known of the account, which form is open over
/// it, what the fields hold, what went wrong, and the actions of the buttons. The views draw
/// it and decide nothing.
///
/// **It holds no token.** A password, a code, a setup key and backup codes are in its
/// properties only while their form is open: every change of panel and `close()` empty
/// them. It prints as its type's name.
///
/// **The step-up is the screen's, not a row's.** A call the server answers
/// `auth.step_up_required` opens the step-up over whatever asked, and what was asked for is
/// done once the proof is accepted: again by itself where nothing secret was typed for it,
/// and by opening its form again, empty, where something was (a secret does not wait
/// behind another form).
///
/// **A failed sign-out is not a sign-out.** The screen stays, says that the session may
/// still be active and offers to try again; `onSignedOut` is called only once the server
/// was told.
@MainActor
public final class TulaAccountModel: ObservableObject, TulaRedacted {
    /// What is open.
    @Published public private(set) var panel: TulaAccountPanel = .overview
    /// Who is signed in, once read.
    @Published public private(set) var user: CurrentUser?
    /// The user's sessions, once read.
    @Published public private(set) var sessions: [Session]?
    /// The user's second step, once read.
    @Published public private(set) var factors: Factors?
    /// The user's passkeys, once read.
    @Published public private(set) var passkeys: [Passkey]?
    /// The parts whose last read failed.
    @Published public private(set) var failed: Set<TulaAccountPart> = []
    /// Whether the environment requires a second step: the authenticator app then cannot be
    /// turned off.
    @Published public private(set) var mfaRequired = false
    /// Whether a phone number can be added (`sms` is on and the deployment has a sender).
    @Published public private(set) var phoneEnabled = false

    /// The password field of a step-up. Emptied when its form is left.
    @Published public var password = ""
    /// The current-password field. Emptied when its form is left.
    @Published public var currentPassword = ""
    /// The new-password field. Emptied when its form is left.
    @Published public var newPassword = ""
    /// The code field. Emptied when its form is left.
    @Published public var code = ""
    /// The backup-code field. Emptied when its form is left.
    @Published public var backupCode = ""
    /// The phone-number field. Kept while a step-up is open over its form; emptied when the
    /// account is shown again.
    @Published public var phoneNumber = ""
    /// The name field. Kept and emptied as the phone number is.
    @Published public var name = ""

    /// Whether an action is being sent. A second one is not started meanwhile.
    @Published public private(set) var isPending = false
    /// What went wrong that is not about one field, in the table's words.
    @Published public private(set) var formError: String?
    /// What is wrong with each field, in the table's words.
    @Published public private(set) var fieldErrors: [TulaAuthField: [String]] = [:]
    /// Something that went right, in words.
    @Published public private(set) var status: String?
    /// Something that is neither: a sheet that was closed, a form that was cancelled.
    @Published public private(set) var notice: String?
    /// Where the focus was last asked to go.
    @Published public private(set) var focus: TulaAuthFocus = .title
    /// Counts the requests to move the focus.
    @Published public private(set) var focusRequests = 0
    /// The secret fields whose text is drawn in the clear. Emptied with the fields.
    @Published public private(set) var revealed: Set<TulaAuthField> = []
    /// The setup key and its address, only while the setup form is open.
    @Published public private(set) var setup: TulaAuthSetup?
    /// Backup codes, only while their form is open.
    @Published public private(set) var backupCodes: [String] = []
    /// A texted code's controls are gone: the server said that no message will be sent.
    @Published public private(set) var textedOff = false
    /// The last sign-out could not be confirmed by the server. The client has dropped its
    /// session all the same, so the account can no longer be read: the screen says so and
    /// offers to try again.
    @Published public private(set) var signOutFailed = false
    /// The app was told that nobody is signed in, and nobody has been since. A session
    /// that ended is reported once however often the account is read after it.
    private var toldSignedOut = false

    /// The strings the messages are taken from.
    public var strings: TulaStrings

    /// What is done once a step-up was accepted.
    private enum Owed {
        /// Open a panel and perform one of its actions: nothing secret was typed for it.
        case perform(TulaAccountAction, on: TulaAccountPanel)
        /// Open a form again, empty: what it sends was typed, and did not wait.
        case retype(TulaAccountPanel)
    }

    let client: TulaClient
    private let announce: @MainActor (String) -> Void
    private let copy: @MainActor (String) -> Void
    private let onSignedOut: (@MainActor () -> Void)?
    let formatDate: (Date) -> String
    private var owed: Owed?
    /// What is said on the account once the backup codes' form is left.
    private var afterCodes: String?
    /// Grows whenever the screen closes or signs out: an answer asked for under an older
    /// number is dropped.
    private var generation = 0

    /// - Parameters:
    ///   - client: The app's client, signed in.
    ///   - strings: The strings.
    ///   - formatDate: How a date is said. The system's medium date and short time by
    ///     default; a test passes its own.
    ///   - announce: Says a message to VoiceOver.
    ///   - copy: Puts text on the pasteboard, when a person asks for a setup key or backup
    ///     codes to be copied.
    ///   - onSignedOut: Called when nobody is signed in any more: after a sign-out the
    ///     server was told of, and when the screen finds that the session ended elsewhere.
    ///     Never after a sign-out that failed.
    public init(
        client: TulaClient,
        strings: TulaStrings = .english,
        formatDate: @escaping (Date) -> String = TulaAccountModel.mediumDate,
        announce: @escaping @MainActor (String) -> Void = { _ in },
        copy: @escaping @MainActor (String) -> Void = { _ in },
        onSignedOut: (@MainActor () -> Void)? = nil
    ) {
        self.client = client
        self.strings = strings
        self.formatDate = formatDate
        self.announce = announce
        self.copy = copy
        self.onSignedOut = onSignedOut
    }

    /// A date as the system says it: a medium date and a short time.
    public nonisolated static func mediumDate(_ date: Date) -> String {
        DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }

    // MARK: Reading the account

    /// Read the account: who is signed in, the sessions, the second step, the passkeys, and
    /// what the environment allows. A part that could not be read is said in its place and
    /// can be asked for again; the others are shown.
    public func load() async {
        await read(Set(TulaAccountPart.allCases))
        if let config = try? await client.config() {
            mfaRequired = config.mfa?.policy == .required
            phoneEnabled = config.phone?.enabled == true
        }
    }

    /// Read some parts again, quietly: after something of them changed.
    private func read(_ parts: Set<TulaAccountPart>) async {
        let asked = generation
        let client = self.client
        // One after another: the calls share the session's one refresh, and the screen is
        // drawn from whatever has arrived.
        if parts.contains(.user) {
            let value = try? await client.user()
            guard asked == generation else { return }
            take(.user, value) { self.user = $0 }
        }
        if parts.contains(.sessions) {
            let value = try? await client.session.list()
            guard asked == generation else { return }
            take(.sessions, value) { self.sessions = $0 }
        }
        if parts.contains(.factors) {
            let value = try? await client.factors.get()
            guard asked == generation else { return }
            take(.factors, value) { self.factors = $0 }
        }
        if parts.contains(.passkeys) {
            let value = try? await client.passkeys.list()
            guard asked == generation else { return }
            take(.passkeys, value) { self.passkeys = $0 }
        }
        await leaveIfSignedOut()
    }

    private func take<Value>(_ part: TulaAccountPart, _ value: Value?, _ set: (Value) -> Void) {
        if let value {
            set(value)
            failed.remove(part)
        } else {
            failed.insert(part)
        }
    }

    /// The session ended somewhere else (it was revoked, or its refresh was refused): the
    /// account is nobody's now. Not after a sign-out of this screen that failed: that one
    /// stays, and says so.
    private func leaveIfSignedOut() async {
        guard !signOutFailed else {
            return
        }
        let asked = generation
        let state = await client.session.state
        guard asked == generation else {
            return
        }
        if state.isSignedIn {
            // Somebody is signed in again: the end of this session will be one to tell.
            toldSignedOut = false
        }
        guard state == .signedOut, !toldSignedOut else {
            return
        }
        toldSignedOut = true
        reset()
        onSignedOut?()
    }

    // MARK: Leaving

    /// The screen is closing: forget what every field held, the setup key and the codes,
    /// close whatever form is open, and drop the answer of anything still on its way.
    /// Nobody is signed out by it.
    public func close() {
        reset()
    }

    private func reset() {
        generation += 1
        isPending = false
        owed = nil
        afterCodes = nil
        wipe()
        phoneNumber = ""
        name = ""
        clearMessages()
        if panel != .overview {
            panel = .overview
            ask(.title)
        }
    }

    private func wipe() {
        password = ""
        currentPassword = ""
        newPassword = ""
        code = ""
        backupCode = ""
        revealed = []
        setup = nil
        backupCodes = []
        textedOff = false
    }

    private func clearMessages() {
        formError = nil
        fieldErrors = [:]
        status = nil
        notice = nil
    }

    private func ask(_ target: TulaAuthFocus) {
        focus = target
        focusRequests += 1
    }

    /// Open a panel: everything secret of the one before is emptied.
    private func show(_ next: TulaAccountPanel) {
        guard next != panel else {
            return
        }
        wipe()
        clearMessages()
        if !next.isStepUp {
            owed = nil
        }
        if next == .overview {
            phoneNumber = ""
            name = ""
            afterCodes = nil
        }
        panel = next
        ask(.title)
    }

    private func succeed(_ words: String) {
        status = words
        announce(words)
    }

    private func quiet(_ words: String) {
        notice = words
        announce(words)
    }

    // MARK: Running a call

    private func begin() -> Int? {
        guard !isPending else {
            return nil
        }
        isPending = true
        clearMessages()
        return generation
    }

    /// Send one call of the account. A call the server wants proof for opens the step-up,
    /// with what is owed once it is given; any other failure is said on the open panel.
    ///
    /// - Returns: The answer, or `nil` when there is none to act on: the call failed, a
    ///   step-up was opened, or the screen was left meanwhile.
    private func send<Value: Sendable>(
        owing owed: Owed, _ call: @escaping @Sendable () async throws -> Value
    ) async -> Value? {
        guard let asked = begin() else {
            return nil
        }
        do {
            let value = try await call()
            guard asked == generation else {
                return nil
            }
            isPending = false
            return value
        } catch {
            guard asked == generation else {
                return nil
            }
            isPending = false
            if let failure = error as? TulaError, failure.code == ErrorCode.authStepUpRequired.rawValue {
                askStepUp(failure.stepUpMethods, owed)
            } else {
                fail(error)
                await leaveIfSignedOut()
            }
            return nil
        }
    }

    private func fail(_ error: Error) {
        guard let failure = error as? TulaError else {
            formError = strings.unknownError
            announce(strings.unknownError)
            return
        }
        if failure.code == TulaClientErrorCode.flowBusy {
            // Another sheet of the app is still out: nothing went wrong, and nothing was sent.
            quiet(strings.ways.sheetBusy)
            return
        }
        if TulaAuthModel.switchedOff.contains(failure.code), case .stepUp(.textedCode, let others, _) = panel {
            // No message will be sent whatever is pressed: the controls go, the words stay.
            show(.stepUp(.textedCode, others: others, sent: nil))
            textedOff = true
        }
        // What the server answers a refused proof with says nothing of the panel it was typed
        // on: a wrong password is `auth.invalid_credentials`, whose sentence is about an
        // address and a password, and a wrong code of a step-up is `mfa.invalid_code` (an
        // emailed one `verification.invalid_code`). Each is said in the panel's own words,
        // at the field that was typed.
        let credentials = ErrorCode.authInvalidCredentials.rawValue
        let wrongCodes: Set<String> = [
            credentials, ErrorCode.mfaInvalidCode.rawValue, ErrorCode.verificationInvalidCode.rawValue,
        ]
        var wrong: (TulaAuthField, String)?
        var refusals: Set<String> = [credentials]
        switch panel {
        case .stepUp(.password, _, _): wrong = (.password, strings.account.passwordWrong)
        case .stepUp(.backupCode, _, _): (wrong, refusals) = ((.backupCode, strings.secondStep.codeWrong), wrongCodes)
        case .stepUp(.passkey, _, _):
            if failure.code == credentials {
                // Nothing was typed: the refusal is about the passkey, and is said above.
                formError = strings.account.stepUpPasskeyRefused
                announce(strings.account.stepUpPasskeyRefused)
                return
            }
        case .stepUp: (wrong, refusals) = ((.code, strings.secondStep.codeWrong), wrongCodes)
        case .changePassword: wrong = (.currentPassword, strings.account.currentPasswordWrong)
        default: wrong = nil
        }
        let placed = TulaPlacedProblems(
            failure, fields: panel.fields, strings: strings, wrong: wrong, refusals: refusals)
        fieldErrors = placed.fields
        formError = placed.above
        // A secret the server refused is typed again; one that is being chosen is kept, to
        // be put right against the message under it.
        for field in [TulaAuthField.password, .currentPassword, .code, .backupCode] where placed.fields[field] != nil {
            setText("", of: field)
            revealed.remove(field)
        }
        let first = panel.fields.first { placed.fields[$0] != nil }
        if let first {
            ask(.field(first))
        }
        announce(placed.above ?? first.flatMap { placed.fields[$0]?.first } ?? strings.unknownError)
    }

    /// Whether nothing is missing. Otherwise the fields are marked and the first takes the
    /// focus, without a request.
    private func require(_ missing: [TulaAuthField], message: String? = nil) -> Bool {
        guard !isPending else {
            return false
        }
        guard let first = missing.first else {
            return true
        }
        clearMessages()
        for field in missing {
            fieldErrors[field] = [field == first ? (message ?? strings.required) : strings.required]
        }
        ask(.field(first))
        announce(fieldErrors[first]?.first ?? strings.required)
        return false
    }

    private var typedCode: String? {
        let typed = code
        return require(typed.count == TulaAuthModel.codeLength ? [] : [.code], message: strings.codeIncomplete)
            ? typed : nil
    }

    // MARK: Proving again that it is the user

    private static let stepUpWays: [String: TulaStepUpWay] = [
        "password": .password, "totp": .totp, "backup_code": .backupCode, "email_code": .emailCode,
        "sms_code": .textedCode, "passkey": .passkey,
    ]

    private func askStepUp(_ methods: [String], _ owed: Owed) {
        var ways: [TulaStepUpWay] = []
        // A way this version does not know is left out, never guessed; a passkey is one
        // only where the app gave the client its sheet.
        for method in methods {
            if let way = TulaAccountModel.stepUpWays[method], !ways.contains(way),
                way != .passkey || client.sheets.passkeys
            {
                ways.append(way)
            }
        }
        self.owed = owed
        if let first = ways.first {
            show(.stepUp(first, others: Array(ways.dropFirst()), sent: nil))
        } else {
            show(.stepUpUnavailable)
        }
    }

    /// Open another way to prove it, among the ones the server named.
    public func useStepUpWay(_ way: TulaStepUpWay) {
        guard case .stepUp(let open, let others, _) = panel, others.contains(way), !isPending else {
            return
        }
        show(.stepUp(way, others: [open] + others.filter { $0 != way }, sent: nil))
    }

    /// "Email me a code" and "Text me a code": ask for the code of the open step-up.
    /// Nothing is sent by arriving at it.
    public func sendStepUpCode() async {
        guard case .stepUp(let way, let others, _) = panel, way == .emailCode || way == .textedCode, !textedOff,
            let asked = begin()
        else {
            return
        }
        let stepUp = client.stepUp
        do {
            let destination: String
            if way == .emailCode {
                destination = try await stepUp.sendEmailCode().destination
            } else {
                destination = try await stepUp.sendSmsCode().destination
            }
            guard asked == generation else {
                return
            }
            isPending = false
            if case .stepUp(_, _, .some) = panel {
                succeed(strings.resent)
            } else {
                show(.stepUp(way, others: others, sent: destination))
            }
        } catch {
            guard asked == generation else {
                return
            }
            isPending = false
            fail(error)
        }
    }

    /// The main button of a step-up that is typed. A secret is emptied as it is sent.
    public func submitStepUp() async {
        guard case .stepUp(let way, _, let sent) = panel, !isPending else {
            return
        }
        let stepUp = client.stepUp
        let proof: @Sendable () async throws -> Void
        switch way {
        case .password:
            let typed = password
            guard require(typed.isEmpty ? [.password] : []) else { return }
            password = ""
            revealed.remove(.password)
            proof = { try await stepUp.withPassword(typed) }
        case .totp:
            guard let typed = typedCode else { return }
            code = ""
            proof = { try await stepUp.withTotp(typed) }
        case .backupCode:
            let typed = backupCode.trimmingCharacters(in: .whitespacesAndNewlines)
            guard require(typed.isEmpty ? [.backupCode] : [], message: strings.secondStep.backupRequired) else {
                return
            }
            backupCode = ""
            proof = { try await stepUp.withBackupCode(typed) }
        case .emailCode, .textedCode:
            guard sent != nil, let typed = typedCode else { return }
            code = ""
            let emailed = way == .emailCode
            proof = {
                if emailed {
                    try await stepUp.withEmailCode(typed)
                } else {
                    try await stepUp.withSmsCode(typed)
                }
            }
        case .passkey:
            return
        }
        guard let asked = begin() else {
            return
        }
        do {
            try await proof()
            guard asked == generation else {
                return
            }
            isPending = false
            await proven()
        } catch {
            guard asked == generation else {
                return
            }
            isPending = false
            fail(error)
        }
    }

    /// "Use your passkey": show the system's sheet for the step-up. A sheet that was closed
    /// is said quietly: nothing was proven and nothing changed.
    public func stepUpWithPasskey() async {
        guard case .stepUp(.passkey, _, _) = panel, let asked = begin() else {
            return
        }
        let stepUp = client.stepUp
        do {
            let outcome = try await stepUp.withPasskey()
            guard asked == generation else {
                return
            }
            isPending = false
            switch outcome {
            case .dismissed: quiet(strings.account.passkeyDismissed)
            case .finished: await proven()
            }
        } catch {
            guard asked == generation else {
                return
            }
            isPending = false
            fail(error)
        }
    }

    /// The proof was accepted: do what was asked for.
    private func proven() async {
        let owed = self.owed
        self.owed = nil
        switch owed {
        case .perform(let action, let on):
            show(on)
            await perform(action)
        case .retype(let form):
            show(form)
            quiet(strings.account.stepUpDone)
        case nil:
            show(.overview)
        }
    }

    /// "Cancel": close the open form. Nothing was changed, and that is said quietly.
    public func cancel() {
        guard panel != .overview, panel != .backupCodes, !isPending else {
            return
        }
        // Every form closes onto the account, a step-up too, whatever asked for it: a form
        // behind a step-up has lost what was typed, and what was owed is forgotten with it.
        show(.overview)
        quiet(strings.account.nothingChanged)
    }

    // MARK: Signing out

    /// "Sign out". A sign-out the server could not be told of is not one: the screen stays
    /// and says that the session may still be active.
    public func signOut() async {
        guard let asked = begin() else {
            return
        }
        let session = client.session
        do {
            try await session.signOut()
            guard asked == generation else {
                return
            }
            signOutFailed = false
            // Told here, whatever was told before: a sign-out a person asked for. A read
            // that finds nobody signed in afterwards has nothing new to say.
            toldSignedOut = true
            reset()
            onSignedOut?()
        } catch {
            guard asked == generation else {
                return
            }
            isPending = false
            show(.overview)
            signOutFailed = true
            formError = strings.account.signOutFailed
            announce(strings.account.signOutFailed)
        }
    }

    /// "Sign out of all other devices". It needs no proof: ending sessions is what an owner
    /// does when something looks wrong.
    public func signOutOthers() async {
        let session = client.session
        guard let count = await send(owing: .perform(.signOutOthers, on: .overview), { try await session.revokeOthers() })
        else {
            return
        }
        succeed(
            count == 1
                ? strings.account.othersSignedOutOne
                : TulaStrings.format(strings.account.othersSignedOut, ["count": String(count)]))
        await read([.sessions])
    }

    /// A row's "Sign out": end one other session.
    public func signOutSession(_ id: String) async {
        guard sessions?.contains(where: { $0.id == id && !$0.current }) == true else {
            return
        }
        let session = client.session
        guard
            await send(owing: .perform(.signOutSession(id), on: .overview), { try await session.revoke(id) }) != nil
        else {
            return
        }
        succeed(strings.account.deviceSignedOut)
        await read([.sessions])
    }

    // MARK: The password

    /// Open the form that changes the password.
    public func openChangePassword() {
        guard panel == .overview, user?.hasPassword == true, !isPending else {
            return
        }
        show(.changePassword)
    }

    /// The main button of that form. The current password is emptied as it is sent; the
    /// new one is kept when the server refuses it, to be put right.
    public func submitPassword() async {
        guard panel == .changePassword, !isPending else {
            return
        }
        let current = currentPassword
        let new = newPassword
        var missing: [TulaAuthField] = current.isEmpty ? [.currentPassword] : []
        if new.isEmpty {
            missing.append(.newPassword)
        }
        guard require(missing) else {
            return
        }
        currentPassword = ""
        revealed.remove(.currentPassword)
        let client = self.client
        guard
            await send(owing: .retype(.changePassword), { try await client.changePassword(current: current, new: new) })
                != nil
        else {
            return
        }
        show(.overview)
        succeed(strings.account.passwordChanged)
        await read([.sessions])
    }

    // MARK: Two-step verification

    /// "Turn on": ask for the setup key of an authenticator app and open its form.
    public func setUpAuthenticator() async {
        guard panel == .overview, factors?.totp.enabled == false else {
            return
        }
        let factors = client.factors
        guard
            let enrolment = await send(
                owing: .perform(.setUpAuthenticator, on: .overview), { try await factors.startTotp() })
        else {
            return
        }
        show(.totpSetup)
        setup = TulaAuthSetup(key: enrolment.secret, uri: enrolment.uri)
    }

    /// "Turn on", on the setup form: confirm the app with the code it shows. The answer is
    /// the backup codes, shown once.
    public func confirmAuthenticator() async {
        guard panel == .totpSetup, let typed = typedCode else {
            return
        }
        code = ""
        let factors = client.factors
        // A proof asked for here starts the setup again: the key does not wait behind it.
        guard
            let codes = await send(
                owing: .perform(.setUpAuthenticator, on: .overview), { try await factors.confirmTotp(code: typed) })
        else {
            return
        }
        showCodes(codes, then: strings.account.turnedOn)
        await read([.factors])
    }

    /// "New backup codes": replace them. The earlier ones stop working.
    public func newBackupCodes() async {
        guard panel == .overview, factors?.totp.enabled == true else {
            return
        }
        let factors = client.factors
        guard
            let codes = await send(
                owing: .perform(.newBackupCodes, on: .overview), { try await factors.regenerateBackupCodes() })
        else {
            return
        }
        showCodes(codes, then: strings.account.regenerated)
        await read([.factors])
    }

    private func showCodes(_ codes: [String], then words: String) {
        show(.backupCodes)
        backupCodes = codes
        afterCodes = words
    }

    /// "I have saved these codes": forget them and show the account.
    public func savedBackupCodes() {
        guard panel == .backupCodes else {
            return
        }
        let words = afterCodes
        show(.overview)
        if let words {
            succeed(words)
        }
    }

    /// "Copy setup key": put the key on the pasteboard, because a person asked.
    public func copySetupKey() {
        guard panel == .totpSetup, let setup else {
            return
        }
        copy(setup.key)
        succeed(strings.secondStep.copied)
    }

    /// "Copy": put the backup codes on the pasteboard, one a line, because a person asked.
    public func copyBackupCodes() {
        guard panel == .backupCodes, !backupCodes.isEmpty else {
            return
        }
        copy(backupCodes.joined(separator: "\n"))
        succeed(strings.secondStep.copied)
    }

    /// "Use text messages": ask for the code that turns a texted second step on. Offered
    /// only where the server says it may be one (`Factors.sms.available`).
    public func turnOnTexted() async {
        guard panel == .overview, factors?.sms?.available == true, factors?.sms?.enabled == false else {
            return
        }
        let factors = client.factors
        guard
            let sent = await send(owing: .perform(.turnOnTexted, on: .overview), { try await factors.startSms() })
        else {
            return
        }
        show(.textedFactor(destination: sent.destination))
    }

    /// The main button of that form.
    public func confirmTexted() async {
        guard case .textedFactor = panel, let typed = typedCode else {
            return
        }
        code = ""
        let factors = client.factors
        guard
            let next = await send(
                owing: .perform(.turnOnTexted, on: .overview), { try await factors.confirmSms(code: typed) })
        else {
            return
        }
        self.factors = next
        show(.overview)
        succeed(strings.account.smsTurnedOn)
    }

    // MARK: The phone number

    /// Open the form that adds, or replaces, the phone number.
    public func openPhone() {
        guard panel == .overview, phoneEnabled, !isPending else {
            return
        }
        show(.phoneNumber)
    }

    /// "Send code": text a code to the number that was typed.
    public func sendPhoneCode() async {
        guard panel == .phoneNumber || { if case .phoneCode = panel { return true } else { return false } }() else {
            return
        }
        let number = phoneNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        guard require(number.isEmpty ? [.phoneNumber] : []) else {
            return
        }
        let phone = client.phone
        guard
            let sent = await send(
                owing: .perform(.sendPhoneCode, on: .phoneNumber), { try await phone.request(phoneNumber: number) })
        else {
            return
        }
        if case .phoneCode = panel {
            succeed(strings.resent)
        } else {
            let typed = phoneNumber
            show(.phoneCode(destination: sent.destination))
            // The number is not a secret, and "send again" needs it.
            phoneNumber = typed
        }
    }

    /// "Use a different number": back to the number's form.
    public func differentNumber() {
        guard case .phoneCode = panel, !isPending else {
            return
        }
        let typed = phoneNumber
        show(.phoneNumber)
        phoneNumber = typed
    }

    /// "Verify": prove the number with the texted code.
    public func verifyPhone() async {
        guard case .phoneCode = panel, let typed = typedCode else {
            return
        }
        code = ""
        let phone = client.phone
        guard
            let next = await send(
                owing: .perform(.sendPhoneCode, on: .phoneNumber), { try await phone.verify(code: typed) })
        else {
            return
        }
        user = next
        show(.overview)
        succeed(strings.account.phoneAdded)
        await read([.factors])
    }

    // MARK: Passkeys

    /// "Add a passkey": show the system's sheet. A sheet that was closed is said quietly.
    public func addPasskey() async {
        guard panel == .overview, client.sheets.passkeys, factors != nil else {
            return
        }
        let passkeys = client.passkeys
        guard
            let outcome = await send(owing: .perform(.addPasskey, on: .overview), { try await passkeys.add() })
        else {
            return
        }
        switch outcome {
        case .dismissed:
            quiet(strings.account.passkeyDismissed)
        case .finished:
            succeed(strings.account.passkeyAdded)
            await read([.passkeys, .factors])
        }
    }

    /// A row's "Rename": open the name's form, holding the name it has.
    public func openRename(_ id: String) {
        guard panel == .overview, let passkey = passkeys?.first(where: { $0.id == id }), !isPending else {
            return
        }
        show(.renamePasskey(id: id))
        name = passkey.name
    }

    /// "Save": store the passkey's new name.
    public func saveName() async {
        guard case .renamePasskey(let id) = panel else {
            return
        }
        let typed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard require(typed.isEmpty ? [.name] : []) else {
            return
        }
        let passkeys = client.passkeys
        guard
            await send(owing: .perform(.saveName, on: panel), { try await passkeys.rename(id, to: typed) }) != nil
        else {
            return
        }
        show(.overview)
        succeed(strings.account.passkeyRenamed)
        await read([.passkeys])
    }

    // MARK: Questions

    /// Ask before something is removed or turned off.
    public func askToConfirm(_ what: TulaAccountConfirmation) {
        guard panel == .overview, !isPending else {
            return
        }
        show(.confirm(what))
    }

    /// The main button of a question: do it.
    public func confirm() async {
        guard case .confirm(let what) = panel else {
            return
        }
        let owed = Owed.perform(.confirm, on: panel)
        let client = self.client
        switch what {
        case .removePasskey(let id, _):
            guard await send(owing: owed, { try await client.passkeys.remove(id) }) != nil else { return }
            show(.overview)
            succeed(strings.account.passkeyRemoved)
            await read([.passkeys, .factors])
        case .turnOffAuthenticator:
            guard await send(owing: owed, { try await client.factors.disableTotp() }) != nil else { return }
            show(.overview)
            succeed(strings.account.turnedOff)
            await read([.factors])
        case .turnOffTexted:
            guard await send(owing: owed, { try await client.factors.disableSms() }) != nil else { return }
            show(.overview)
            succeed(strings.account.smsTurnedOff)
            await read([.factors])
        case .removePhone:
            guard await send(owing: owed, { try await client.phone.remove() }) != nil else { return }
            show(.overview)
            succeed(strings.account.phoneRemoved)
            await read([.user, .factors])
        }
    }

    // MARK: Fields

    /// Whether a secret field's text is drawn in the clear.
    public func isRevealed(_ field: TulaAuthField) -> Bool {
        revealed.contains(field)
    }

    /// "Show password" and "hide password", for a password field of the open form.
    public func toggleReveal(_ field: TulaAuthField) {
        guard [.password, .currentPassword, .newPassword].contains(field), panel.fields.contains(field) else {
            return
        }
        if revealed.remove(field) == nil {
            revealed.insert(field)
        }
    }

    /// What a field holds.
    public func text(of field: TulaAuthField) -> String {
        switch field {
        case .password: return password
        case .currentPassword: return currentPassword
        case .newPassword: return newPassword
        case .code: return code
        case .backupCode: return backupCode
        case .phoneNumber: return phoneNumber
        case .name: return name
        case .email: return ""
        }
    }

    /// Take what was typed, or pasted, into a field. A code field keeps the digits of a
    /// code and nothing else.
    public func setText(_ typed: String, of field: TulaAuthField) {
        switch field {
        case .password: password = typed
        case .currentPassword: currentPassword = typed
        case .newPassword: newPassword = typed
        case .code: code = TulaAuthModel.digits(typed)
        case .backupCode: backupCode = typed
        case .phoneNumber: phoneNumber = typed
        case .name: name = typed
        case .email: break
        }
    }
}
