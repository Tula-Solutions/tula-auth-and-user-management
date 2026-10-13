import Foundation
import TulaAuth

// What the account screen holds, as data, by the rule of the sign-in screens (ADR 0057):
// the model decides, this file says it in words, fields and offers, and a view draws it
// from top to bottom. `swift test` reads all of it without drawing anything.

/// Something a person can ask the account screen to do.
public enum TulaAccountAction: Hashable, Sendable {
    /// Read the account again.
    case reload
    /// Sign out of this device.
    case signOut
    /// Sign out of every other device.
    case signOutOthers
    /// Sign out one other session.
    case signOutSession(String)
    /// Open the form that changes the password.
    case openChangePassword
    /// Send the current password and the new one.
    case submitPassword
    /// Ask for the setup key of an authenticator app.
    case setUpAuthenticator
    /// Confirm the authenticator app with its code.
    case confirmAuthenticator
    /// Replace the backup codes.
    case newBackupCodes
    /// Leave the backup codes: they are saved.
    case savedBackupCodes
    /// Put the setup key on the pasteboard.
    case copySetupKey
    /// Put the backup codes on the pasteboard.
    case copyBackupCodes
    /// Ask for the code that makes a texted code the second step.
    case turnOnTexted
    /// Send that code.
    case confirmTexted
    /// Open the form that adds or replaces the phone number.
    case openPhone
    /// Text a code to the number that was typed.
    case sendPhoneCode
    /// Go back to the number's form.
    case differentNumber
    /// Send the code that proves the number.
    case verifyPhone
    /// Show the system's sheet that makes a passkey.
    case addPasskey
    /// Open the form that renames a passkey.
    case openRename(String)
    /// Store the passkey's new name.
    case saveName
    /// Ask before something is removed or turned off.
    case ask(TulaAccountConfirmation)
    /// Do what was asked about.
    case confirm
    /// Close the open form.
    case cancel
    /// Open another way to prove it is the user.
    case useStepUpWay(TulaStepUpWay)
    /// Ask for the code of the open step-up.
    case sendStepUpCode
    /// Send what was typed for the step-up.
    case submitStepUp
    /// Show the passkey sheet for the step-up.
    case stepUpWithPasskey
}

/// A field of the account screen.
public typealias TulaAccountFieldContent = TulaFieldContent<TulaAccountAction>
/// A button or a link of the account screen.
public typealias TulaAccountOffer = TulaOffer<TulaAccountAction>

/// One thing of a list on the account screen: a session, a passkey.
public struct TulaAccountRow: Hashable, Sendable {
    /// The row's accessibility identifier: `tula.row.session.<id>`.
    public let identifier: String
    /// What it is, in words.
    public let title: String
    /// What marks it, in words: "This device", "Bound to a device key".
    public let marks: [String]
    /// What else is known of it.
    public let details: [String]
    /// What can be done with it.
    public let offers: [TulaAccountOffer]
}

/// One part of the account: a heading, what is said under it, its list and its buttons.
public struct TulaAccountSection: Hashable, Sendable {
    /// The section's accessibility identifier: `tula.section.sessions`.
    public let identifier: String
    /// Its heading.
    public let title: String
    /// What is said under the heading.
    public let lines: [String]
    /// Its list.
    public let rows: [TulaAccountRow]
    /// Its buttons.
    public let offers: [TulaAccountOffer]

    init(
        _ name: String, _ title: String, lines: [String] = [], rows: [TulaAccountRow] = [],
        offers: [TulaAccountOffer] = []
    ) {
        identifier = "tula.section.\(name)"
        self.title = title
        self.lines = lines
        self.rows = rows
        self.offers = offers
    }
}

/// What the account screen is drawn from beside the open panel: what was read of the
/// account, and what a form holds only while it is open. Prints as its type's name.
public struct TulaAccountFacts: TulaRedacted {
    /// Who is signed in.
    public var user: CurrentUser?
    /// The sessions.
    public var sessions: [Session]?
    /// The second step.
    public var factors: Factors?
    /// The passkeys.
    public var passkeys: [Passkey]?
    /// The parts whose read failed.
    public var failed: Set<TulaAccountPart> = []
    /// Whether the environment requires a second step.
    public var mfaRequired = false
    /// Whether a phone number can be added.
    public var phoneEnabled = false
    /// Whether the app gave the client a passkey sheet.
    public var passkeySheet = false
    /// Whether a texted code's controls are gone.
    public var textedOff = false
    /// Whether the last sign-out could not be confirmed.
    public var signOutFailed = false
    /// The setup key, on the setup form.
    public var setup: TulaAuthSetup?
    /// The backup codes, on their form.
    public var backupCodes: [String] = []
    /// How a date is said.
    public var formatDate: (Date) -> String = TulaAccountModel.mediumDate

    /// Facts in which nothing is known yet.
    public init() {}
}

/// Everything the account screen holds, in the order it is drawn: the title and what is
/// under it, then either the account's sections or one form.
///
/// It prints as its type's name: on the setup form it holds the setup key, and on the
/// codes' form the backup codes.
public struct TulaAccountContent: Hashable, Sendable, TulaRedacted {
    /// The title.
    public let title: String
    /// What is under the title, when there is something.
    public let subtitle: String?
    /// The account's sections; empty while a form is open.
    public let sections: [TulaAccountSection]
    /// The open form's fields.
    public let fields: [TulaAccountFieldContent]
    /// The main button.
    public let primary: TulaAccountOffer?
    /// The links under it.
    public let links: [TulaAccountOffer]
    /// The setup key of an authenticator app, drawn with its QR code above the fields.
    public let setup: TulaSetupContent<TulaAccountAction>?
    /// The backup codes, drawn as a list above the main button.
    public let codes: TulaCodesContent<TulaAccountAction>?

    init(
        title: String, subtitle: String? = nil, sections: [TulaAccountSection] = [],
        fields: [TulaAccountFieldContent] = [], primary: TulaAccountOffer? = nil, links: [TulaAccountOffer] = [],
        setup: TulaSetupContent<TulaAccountAction>? = nil, codes: TulaCodesContent<TulaAccountAction>? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.sections = sections
        self.fields = fields
        self.primary = primary
        self.links = links
        self.setup = setup
        self.codes = codes
    }

    /// Every action the screen offers. `TulaAccountModel.perform(_:)` does nothing for any
    /// other.
    public var actions: Set<TulaAccountAction> {
        var offers = [primary, setup?.copy, codes?.copy].compactMap { $0 } + links
        for section in sections {
            offers += section.offers + section.rows.flatMap(\.offers)
        }
        return Set(fields.map(\.submit) + offers.map(\.action))
    }

    /// What the account screen holds.
    ///
    /// - Parameters:
    ///   - panel: What is open.
    ///   - strings: The strings its words are taken from.
    ///   - facts: What is known of the account.
    public init(panel: TulaAccountPanel, strings t: TulaStrings, facts: TulaAccountFacts = TulaAccountFacts()) {
        let a = t.account
        let second = t.secondStep
        let cancel = TulaAccountOffer("cancel", a.cancel, .cancel)
        func code(_ label: String, _ submit: TulaAccountAction) -> TulaAccountFieldContent {
            TulaAccountFieldContent(field: .code, kind: .code, label: label, hint: t.codeHint, submit: submit)
        }

        switch panel {
        case .overview:
            if facts.signOutFailed {
                // The client has dropped its session, so nothing of the account can be read;
                // what is left to do here is to tell the server.
                self.init(title: a.title, primary: TulaAccountOffer(primary: a.signOut, .signOut, destructive: true))
            } else {
                self.init(
                    title: a.title, sections: TulaAccountContent.sections(t, facts),
                    links: [TulaAccountOffer("signOut", a.signOut, .signOut, destructive: true)])
            }
        case .stepUp(let way, let others, let sent):
            let links =
                others.map { other -> TulaAccountOffer in
                    switch other {
                    case .password: return TulaAccountOffer("stepUp.password", a.passwordInstead, .useStepUpWay(other))
                    case .totp: return TulaAccountOffer("stepUp.totp", second.useAuthenticator, .useStepUpWay(other))
                    case .backupCode:
                        return TulaAccountOffer("stepUp.backupCode", second.useBackupCode, .useStepUpWay(other))
                    case .emailCode: return TulaAccountOffer("stepUp.emailCode", a.emailInstead, .useStepUpWay(other))
                    case .textedCode: return TulaAccountOffer("stepUp.textedCode", a.smsInstead, .useStepUpWay(other))
                    case .passkey:
                        return TulaAccountOffer("stepUp.passkey", second.usePasskeyInstead, .useStepUpWay(other))
                    }
                } + [cancel]
            let submit = TulaAccountOffer(primary: a.stepUpSubmit, .submitStepUp)
            switch way {
            case .password:
                self.init(
                    title: a.stepUpTitle, subtitle: a.stepUpPassword,
                    fields: [
                        TulaAccountFieldContent(
                            field: .password, kind: .password, label: t.passwordLabel, hint: nil, submit: .submitStepUp)
                    ], primary: submit, links: links)
            case .totp:
                self.init(
                    title: a.stepUpTitle, subtitle: a.stepUpTotp, fields: [code(second.totpLabel, .submitStepUp)],
                    primary: submit, links: links)
            case .backupCode:
                self.init(
                    title: a.stepUpTitle, subtitle: a.stepUpBackup,
                    fields: [
                        TulaAccountFieldContent(
                            field: .backupCode, kind: .backupCode, label: second.backupLabel, hint: second.backupHint,
                            submit: .submitStepUp)
                    ], primary: submit, links: links)
            case .emailCode, .textedCode:
                let texted = way == .textedCode
                if let sent {
                    self.init(
                        title: a.stepUpTitle,
                        subtitle: TulaStrings.format(
                            texted ? a.stepUpSmsSent : a.stepUpEmailSent, ["destination": sent]),
                        fields: [code(t.codeLabel, .submitStepUp)], primary: submit,
                        links: [
                            TulaAccountOffer("resend", texted ? second.smsResend : t.resend, .sendStepUpCode)
                        ] + links)
                } else {
                    self.init(
                        title: a.stepUpTitle, subtitle: texted ? a.stepUpSmsPrompt : a.stepUpEmailPrompt,
                        primary: texted && facts.textedOff
                            ? nil
                            : TulaAccountOffer(primary: texted ? a.stepUpSmsSend : a.stepUpEmailSend, .sendStepUpCode),
                        links: links)
                }
            case .passkey:
                self.init(
                    title: a.stepUpTitle, subtitle: a.stepUpPasskey,
                    primary: TulaAccountOffer(primary: second.usePasskey, .stepUpWithPasskey), links: links)
            }
        case .stepUpUnavailable:
            self.init(
                title: a.stepUpTitle, subtitle: a.stepUpNoMethod,
                primary: TulaAccountOffer(primary: a.signOut, .signOut, destructive: true), links: [cancel])
        case .changePassword:
            self.init(
                title: a.passwordTitle,
                fields: [
                    TulaAccountFieldContent(
                        field: .currentPassword, kind: .password, label: a.currentPasswordLabel, hint: nil,
                        submit: .submitPassword),
                    TulaAccountFieldContent(
                        field: .newPassword, kind: .newPassword, label: t.newPasswordLabel, hint: nil,
                        submit: .submitPassword),
                ], primary: TulaAccountOffer(primary: a.changePassword, .submitPassword), links: [cancel])
        case .totpSetup:
            self.init(
                title: second.enrolTitle, subtitle: second.scanInstruction,
                fields: [code(second.totpLabel, .confirmAuthenticator)],
                primary: TulaAccountOffer(primary: second.confirmSubmit, .confirmAuthenticator), links: [cancel],
                setup: facts.setup.map {
                    TulaSetupContent(
                        uri: $0.uri, key: $0.key, qrLabel: second.qrLabel, keyLabel: second.secretLabel,
                        keyHint: second.secretHint, copy: TulaAccountOffer("copyKey", second.copyKey, .copySetupKey))
                })
        case .backupCodes:
            self.init(
                title: second.backupCodesTitle, subtitle: second.backupCodesIntro,
                primary: TulaAccountOffer(primary: second.saved, .savedBackupCodes),
                codes: TulaCodesContent(
                    label: second.backupCodesList, codes: facts.backupCodes,
                    copy: TulaAccountOffer("copyCodes", second.copy, .copyBackupCodes)))
        case .textedFactor(let destination):
            self.init(
                title: a.mfaTitle, subtitle: TulaStrings.format(a.phoneCodeSent, ["destination": destination]),
                fields: [code(t.codeLabel, .confirmTexted)],
                primary: TulaAccountOffer(primary: a.smsTurnOn, .confirmTexted), links: [cancel])
        case .phoneNumber:
            self.init(
                title: a.phoneTitle,
                fields: [
                    TulaAccountFieldContent(
                        field: .phoneNumber, kind: .phoneNumber, label: a.phoneNumberLabel, hint: a.phoneNumberHint,
                        submit: .sendPhoneCode)
                ], primary: TulaAccountOffer(primary: a.phoneSend, .sendPhoneCode), links: [cancel])
        case .phoneCode(let destination):
            self.init(
                title: a.phoneTitle, subtitle: TulaStrings.format(a.phoneCodeSent, ["destination": destination]),
                fields: [code(t.codeLabel, .verifyPhone)], primary: TulaAccountOffer(primary: t.verifySubmit, .verifyPhone),
                links: [
                    TulaAccountOffer("resend", second.smsResend, .sendPhoneCode),
                    TulaAccountOffer("differentNumber", a.phoneDifferent, .differentNumber), cancel,
                ])
        case .renamePasskey:
            self.init(
                title: a.rename,
                fields: [
                    TulaAccountFieldContent(
                        field: .name, kind: .name, label: a.passkeyNameLabel, hint: nil, submit: .saveName)
                ], primary: TulaAccountOffer(primary: a.save, .saveName), links: [cancel])
        case .confirm(let what):
            let title: String
            let question: String
            let button: String
            switch what {
            case .removePasskey(_, let name):
                (title, question, button) = (
                    a.passkeysTitle, TulaStrings.format(a.removeConfirm, ["name": name]), a.removeConfirmButton
                )
            case .turnOffAuthenticator: (title, question, button) = (a.mfaTitle, a.turnOffConfirm, a.turnOff)
            case .turnOffTexted: (title, question, button) = (a.mfaTitle, a.smsTurnOffConfirm, a.smsTurnOff)
            case .removePhone: (title, question, button) = (a.phoneTitle, a.phoneRemoveConfirm, a.phoneRemove)
            }
            self.init(
                title: title, subtitle: question,
                primary: TulaAccountOffer(primary: button, .confirm, destructive: true), links: [cancel])
        }
    }

    // MARK: The account's sections

    private static func sections(_ t: TulaStrings, _ facts: TulaAccountFacts) -> [TulaAccountSection] {
        let a = t.account
        func date(_ text: String?) -> String? {
            TulaStrings.date(text, facts.formatDate)
        }
        func dated(_ words: String, _ text: String?) -> String? {
            date(text).map { TulaStrings.format(words, ["date": $0]) }
        }
        func unread(_ name: String, _ title: String) -> TulaAccountSection {
            // Several parts can fail at once, and an identifier names one control: the
            // button carries its section's name.
            TulaAccountSection(
                name, title, lines: [a.sectionFailed],
                offers: [TulaAccountOffer("reload.\(name)", a.reload, .reload)])
        }
        var sections: [TulaAccountSection] = []

        // Who is signed in, the password and the phone number are all the user's.
        if let user = facts.user {
            var lines: [String] = []
            let name = [user.firstName, user.lastName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
            if !name.isEmpty {
                lines.append(name)
            }
            if let email = user.email {
                lines += [email, user.emailVerifiedAt == nil ? a.emailUnverified : a.emailVerified]
            } else {
                lines.append(a.noEmail)
            }
            sections.append(TulaAccountSection("profile", a.profileTitle, lines: lines))
            sections.append(
                user.hasPassword
                    ? TulaAccountSection(
                        "password", a.passwordTitle,
                        offers: [TulaAccountOffer("changePassword", a.changePassword, .openChangePassword)])
                    // The sentence names the sign-in screen's link by the words that link has in
                    // this table, so that the two cannot drift apart.
                    : TulaAccountSection(
                        "password", a.passwordTitle,
                        lines: [TulaStrings.format(a.passwordNotSet, ["forgotPassword": t.forgotPassword])]))
        } else if facts.failed.contains(.user) {
            sections.append(unread("profile", a.profileTitle))
        }

        if let sessions = facts.sessions {
            let rows = sessions.map { session -> TulaAccountRow in
                // A session is named by the kind of client it was made by, in the table's
                // words: what a browser says of itself is not drawn.
                let device: String
                switch session.client {
                case .web: device = a.clientWeb
                case .ios: device = a.clientIos
                case .android: device = a.clientAndroid
                case .server: device = a.clientServer
                default: device = a.unknownDevice
                }
                return TulaAccountRow(
                    identifier: "tula.row.session.\(session.id)", title: device,
                    marks: (session.current ? [a.thisDevice] : []) + (session.deviceBound ? [a.deviceBound] : []),
                    details: [dated(a.signedInOn, session.createdAt), dated(a.lastActive, session.lastActiveAt)]
                        .compactMap { $0 },
                    offers: session.current
                        ? []
                        : [
                            TulaAccountOffer(
                                "signOutSession.\(session.id)", a.signOutDevice, .signOutSession(session.id),
                                spoken: TulaStrings.format(a.signOutDeviceLabel, ["device": device]),
                                destructive: true)
                        ])
            }
            sections.append(
                TulaAccountSection(
                    "sessions", a.sessionsTitle, rows: rows,
                    offers: sessions.contains { !$0.current }
                        ? [TulaAccountOffer("signOutOthers", a.signOutOthers, .signOutOthers, destructive: true)] : []))
        } else if facts.failed.contains(.sessions) {
            sections.append(unread("sessions", a.sessionsTitle))
        }

        if let factors = facts.factors {
            var lines: [String] = []
            var offers: [TulaAccountOffer] = []
            if factors.totp.enabled {
                lines.append(dated(a.mfaOn, factors.totp.confirmedAt) ?? a.turnedOn)
                let left = factors.backupCodes.remaining
                lines.append(
                    left == 1
                        ? a.codesRemainingOne : TulaStrings.format(a.codesRemaining, ["count": String(left)]))
                offers.append(TulaAccountOffer("newBackupCodes", a.regenerate, .newBackupCodes))
                if facts.mfaRequired {
                    lines.append(a.requiredByApp)
                } else {
                    offers.append(
                        TulaAccountOffer("turnOff", a.turnOff, .ask(.turnOffAuthenticator), destructive: true))
                }
            } else {
                lines.append(a.mfaOff)
                offers.append(TulaAccountOffer("turnOn", a.turnOn, .setUpAuthenticator))
            }
            if let sms = factors.sms {
                if sms.enabled {
                    // A texted code beside a stronger factor is dormant: said, never hidden.
                    lines.append(sms.inUse ? (dated(a.smsOn, sms.enabledAt) ?? a.smsTurnedOn) : a.smsNotInUse)
                    if sms.inUse {
                        lines.append(a.smsWeaker)
                    }
                    offers.append(
                        TulaAccountOffer("smsTurnOff", a.smsTurnOff, .ask(.turnOffTexted), destructive: true))
                } else if sms.available {
                    lines.append(a.smsOffer)
                    offers.append(TulaAccountOffer("smsTurnOn", a.smsTurnOn, .turnOnTexted))
                }
            }
            sections.append(TulaAccountSection("mfa", a.mfaTitle, lines: lines, offers: offers))
        } else if facts.failed.contains(.factors) {
            sections.append(unread("mfa", a.mfaTitle))
        }

        if let user = facts.user, facts.phoneEnabled || user.phoneNumber != nil {
            if let number = user.phoneNumber {
                sections.append(
                    TulaAccountSection(
                        "phone", a.phoneTitle, lines: [number, a.phoneVerified],
                        offers: (facts.phoneEnabled ? [TulaAccountOffer("phoneChange", a.phoneChange, .openPhone)] : [])
                            + [TulaAccountOffer("phoneRemove", a.phoneRemove, .ask(.removePhone), destructive: true)]))
            } else {
                sections.append(
                    TulaAccountSection(
                        "phone", a.phoneTitle, lines: [a.phoneNone],
                        offers: [TulaAccountOffer("phoneAdd", a.phoneAdd, .openPhone)]))
            }
        }

        if let passkeys = facts.passkeys {
            var lines = [a.passkeysIntro]
            var offers: [TulaAccountOffer] = []
            if passkeys.isEmpty {
                lines.append(a.passkeysEmpty)
            }
            if !facts.passkeySheet {
                lines.append(a.addUnsupported)
            } else if let factors = facts.factors {
                if factors.sms?.inUse == true {
                    // A passkey takes the second step over, and has no backup codes: said
                    // before the sheet, not after.
                    lines.append(a.replacesTextedCode)
                }
                offers.append(TulaAccountOffer("passkeyAdd", a.passkeyAdd, .addPasskey))
            } else {
                lines.append(facts.failed.contains(.factors) ? a.addUnchecked : a.addChecking)
            }
            let rows = passkeys.map { passkey in
                TulaAccountRow(
                    identifier: "tula.row.passkey.\(passkey.id)", title: passkey.name,
                    marks: [passkey.synced ? a.passkeySynced : a.passkeySingleDevice],
                    details: [
                        dated(a.passkeyCreated, passkey.createdAt),
                        dated(a.passkeyLastUsed, passkey.lastUsedAt) ?? a.passkeyNeverUsed,
                    ].compactMap { $0 },
                    offers: [
                        TulaAccountOffer(
                            "rename.\(passkey.id)", a.rename, .openRename(passkey.id),
                            spoken: TulaStrings.format(a.renameLabel, ["name": passkey.name])),
                        TulaAccountOffer(
                            "remove.\(passkey.id)", a.remove, .ask(.removePasskey(id: passkey.id, name: passkey.name)),
                            spoken: TulaStrings.format(a.removeLabel, ["name": passkey.name]), destructive: true),
                    ])
            }
            sections.append(TulaAccountSection("passkeys", a.passkeysTitle, lines: lines, rows: rows, offers: offers))
        } else if facts.failed.contains(.passkeys) {
            sections.append(unread("passkeys", a.passkeysTitle))
        }
        return sections
    }
}

extension TulaAccountModel {
    /// What the screen is drawn from beside the open panel.
    public var facts: TulaAccountFacts {
        var facts = TulaAccountFacts()
        facts.user = user
        facts.sessions = sessions
        facts.factors = factors
        facts.passkeys = passkeys
        facts.failed = failed
        facts.mfaRequired = mfaRequired
        facts.phoneEnabled = phoneEnabled
        facts.passkeySheet = client.sheets.passkeys
        facts.textedOff = textedOff
        facts.signOutFailed = signOutFailed
        facts.setup = setup
        facts.backupCodes = backupCodes
        facts.formatDate = formatDate
        return facts
    }

    /// What the screen holds: what a view draws.
    public var content: TulaAccountContent {
        TulaAccountContent(panel: panel, strings: strings, facts: facts)
    }

    /// Do what a button, a link or the keyboard's "go" of the screen asks.
    ///
    /// An action the screen does not offer does nothing: it cannot be asked for.
    ///
    /// - Parameter action: An action of `content`.
    public func perform(_ action: TulaAccountAction) async {
        guard content.actions.contains(action) else {
            return
        }
        switch action {
        case .reload: await load()
        case .signOut: await signOut()
        case .signOutOthers: await signOutOthers()
        case .signOutSession(let id): await signOutSession(id)
        case .openChangePassword: openChangePassword()
        case .submitPassword: await submitPassword()
        case .setUpAuthenticator: await setUpAuthenticator()
        case .confirmAuthenticator: await confirmAuthenticator()
        case .newBackupCodes: await newBackupCodes()
        case .savedBackupCodes: savedBackupCodes()
        case .copySetupKey: copySetupKey()
        case .copyBackupCodes: copyBackupCodes()
        case .turnOnTexted: await turnOnTexted()
        case .confirmTexted: await confirmTexted()
        case .openPhone: openPhone()
        case .sendPhoneCode: await sendPhoneCode()
        case .differentNumber: differentNumber()
        case .verifyPhone: await verifyPhone()
        case .addPasskey: await addPasskey()
        case .openRename(let id): openRename(id)
        case .saveName: await saveName()
        case .ask(let what): askToConfirm(what)
        case .confirm: await confirm()
        case .cancel: cancel()
        case .useStepUpWay(let way): useStepUpWay(way)
        case .sendStepUpCode: await sendStepUpCode()
        case .submitStepUp: await submitStepUp()
        case .stepUpWithPasskey: await stepUpWithPasskey()
        }
    }

    /// What is wrong with a field, each worded as a problem ("Error: …").
    public func problems(of field: TulaAuthField) -> [String] {
        (fieldErrors[field] ?? []).map { TulaStrings.format(strings.errorPrefix, ["message": $0]) }
    }

    /// What went wrong that is not about one field, worded as a problem.
    public var formProblem: String? {
        formError.map { TulaStrings.format(strings.errorPrefix, ["message": $0]) }
    }

    /// What VoiceOver reads for a field: its label, and its problems when it has any.
    public func spokenLabel(of field: TulaAccountFieldContent) -> String {
        let problems = fieldErrors[field.field] ?? []
        return problems.isEmpty
            ? field.label
            : TulaStrings.format(
                strings.fieldInvalid, ["label": field.label, "message": problems.joined(separator: " ")])
    }
}
