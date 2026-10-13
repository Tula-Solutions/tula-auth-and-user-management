import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// What the account screen holds, word for word: one row for every panel and variant, and the
// account's sections for what can be known of an account. A view draws this from top to
// bottom and decides nothing, so what is asserted here is what a person is shown.
@MainActor
final class AccountContentTests: XCTestCase {
    private typealias Field = TulaAccountFieldContent
    private typealias Offer = TulaAccountOffer
    private typealias Section = TulaAccountSection
    private typealias Row = TulaAccountRow

    private static let cancel = Offer("cancel", "Cancel", .cancel)
    private static let signOutLink = Offer("signOut", "Sign out", .signOut, destructive: true)
    private static let setup = TulaAuthSetup(key: Wire.setupKey, uri: Wire.setupAddress)

    private static func code(_ label: String, _ submit: TulaAccountAction) -> Field {
        Field(field: .code, kind: .code, label: label, hint: "6 digits", submit: submit)
    }

    private static func link(_ way: TulaStepUpWay) -> Offer {
        // No default: a new way does not compile without its words.
        switch way {
        case .password: return Offer("stepUp.password", "Use your password instead", .useStepUpWay(.password))
        case .totp: return Offer("stepUp.totp", "Use your authenticator app", .useStepUpWay(.totp))
        case .backupCode: return Offer("stepUp.backupCode", "Use a backup code", .useStepUpWay(.backupCode))
        case .emailCode: return Offer("stepUp.emailCode", "Email me a code instead", .useStepUpWay(.emailCode))
        case .textedCode: return Offer("stepUp.textedCode", "Text me a code instead", .useStepUpWay(.textedCode))
        case .passkey: return Offer("stepUp.passkey", "Use your passkey instead", .useStepUpWay(.passkey))
        }
    }

    private static let everyWay: [TulaStepUpWay] = [.password, .totp, .backupCode, .emailCode, .textedCode, .passkey]

    /// Every panel, with every variant that is drawn differently.
    private static var panels: [TulaAccountPanel] {
        var panels: [TulaAccountPanel] = [.overview, .stepUpUnavailable]
        for way in everyWay {
            panels.append(.stepUp(way, others: [], sent: nil))
            panels.append(.stepUp(way, others: everyWay.filter { $0 != way }, sent: nil))
        }
        panels += [
            .stepUp(.emailCode, others: [.password], sent: Account.maskedEmail),
            .stepUp(.textedCode, others: [.totp, .backupCode], sent: Wire.masked),
            .changePassword, .totpSetup, .backupCodes, .textedFactor(destination: Wire.masked), .phoneNumber,
            .phoneCode(destination: Wire.masked), .renamePasskey(id: "pk_1"),
            .confirm(.removePasskey(id: "pk_1", name: "iPhone")), .confirm(.turnOffAuthenticator),
            .confirm(.turnOffTexted), .confirm(.removePhone),
        ]
        return panels
    }

    /// What a panel holds. Neither switch has a default: a new panel, way or question does
    /// not compile without a row.
    private static func expected(_ panel: TulaAccountPanel, textedOff: Bool = false) -> TulaAccountContent {
        let stepUp = "Confirm it is you"
        let proceed = Offer(primary: "Continue", .submitStepUp)
        switch panel {
        case .overview:
            return TulaAccountContent(title: "Account", links: [signOutLink])
        case .stepUp(let way, let others, let sent):
            let links = others.map(link) + [cancel]
            switch way {
            case .password:
                return TulaAccountContent(
                    title: stepUp, subtitle: "Enter your password to continue.",
                    fields: [
                        Field(field: .password, kind: .password, label: "Password", hint: nil, submit: .submitStepUp)
                    ], primary: proceed, links: links)
            case .totp:
                return TulaAccountContent(
                    title: stepUp, subtitle: "Enter the 6-digit code from your authenticator app to continue.",
                    fields: [code("Authentication code", .submitStepUp)], primary: proceed, links: links)
            case .backupCode:
                return TulaAccountContent(
                    title: stepUp, subtitle: "Enter one of your backup codes to continue. Each code works once.",
                    fields: [
                        Field(
                            field: .backupCode, kind: .backupCode, label: "Backup code",
                            hint: "10 characters, for example abcde-fghjk", submit: .submitStepUp)
                    ], primary: proceed, links: links)
            case .emailCode:
                guard let sent else {
                    return TulaAccountContent(
                        title: stepUp, subtitle: "To continue, we will email you a 6-digit code.",
                        primary: Offer(primary: "Email me a code", .sendStepUpCode), links: links)
                }
                return TulaAccountContent(
                    title: stepUp, subtitle: "Enter the 6-digit code we sent to \(sent).",
                    fields: [code("Verification code", .submitStepUp)], primary: proceed,
                    links: [Offer("resend", "Resend code", .sendStepUpCode)] + links)
            case .textedCode:
                guard let sent else {
                    return TulaAccountContent(
                        title: stepUp,
                        subtitle: "To continue, we will text a 6-digit code to the phone number on your account.",
                        primary: textedOff ? nil : Offer(primary: "Text me a code", .sendStepUpCode), links: links)
                }
                return TulaAccountContent(
                    title: stepUp, subtitle: "Enter the 6-digit code we texted to \(sent).",
                    fields: [code("Verification code", .submitStepUp)], primary: proceed,
                    links: [Offer("resend", "Text a new code", .sendStepUpCode)] + links)
            case .passkey:
                return TulaAccountContent(
                    title: stepUp, subtitle: "Use your passkey to continue.",
                    primary: Offer(primary: "Use your passkey", .stepUpWithPasskey), links: links)
            }
        case .stepUpUnavailable:
            return TulaAccountContent(
                title: stepUp, subtitle: "For your security, sign out and sign in again to continue.",
                primary: Offer(primary: "Sign out", .signOut, destructive: true), links: [cancel])
        case .changePassword:
            return TulaAccountContent(
                title: "Password",
                fields: [
                    Field(
                        field: .currentPassword, kind: .password, label: "Current password", hint: nil,
                        submit: .submitPassword),
                    Field(
                        field: .newPassword, kind: .newPassword, label: "New password", hint: nil,
                        submit: .submitPassword),
                ], primary: Offer(primary: "Update password", .submitPassword), links: [cancel])
        case .totpSetup:
            return TulaAccountContent(
                title: "Set up two-step verification",
                subtitle:
                    "Scan this QR code with your authenticator app, or enter the setup key by hand. Then enter the 6-digit code the app shows.",
                fields: [code("Authentication code", .confirmAuthenticator)],
                primary: Offer(primary: "Turn on", .confirmAuthenticator), links: [cancel],
                setup: TulaSetupContent(
                    uri: Wire.setupAddress, key: Wire.setupKey,
                    qrLabel: "QR code for your authenticator app. If you cannot scan it, use the setup key.",
                    keyLabel: "Setup key", keyHint: "Keep this key private. It is shown only now.",
                    copy: Offer("copyKey", "Copy setup key", .copySetupKey)))
        case .backupCodes:
            return TulaAccountContent(
                title: "Save your backup codes",
                subtitle:
                    "Each code signs you in once if you cannot use your authenticator app. Keep them somewhere safe: they will not be shown again.",
                primary: Offer(primary: "I have saved these codes", .savedBackupCodes),
                codes: TulaCodesContent(
                    label: "Backup codes", codes: Wire.backupCodes, copy: Offer("copyCodes", "Copy", .copyBackupCodes)))
        case .textedFactor(let destination):
            return TulaAccountContent(
                title: "Two-step verification", subtitle: "Enter the 6-digit code we texted to \(destination).",
                fields: [code("Verification code", .confirmTexted)],
                primary: Offer(primary: "Use text messages", .confirmTexted), links: [cancel])
        case .phoneNumber:
            return TulaAccountContent(
                title: "Phone number",
                fields: [
                    Field(
                        field: .phoneNumber, kind: .phoneNumber, label: "Phone number",
                        hint: "Include the country code, for example +1 415 555 0142.", submit: .sendPhoneCode)
                ], primary: Offer(primary: "Send code", .sendPhoneCode), links: [cancel])
        case .phoneCode(let destination):
            return TulaAccountContent(
                title: "Phone number", subtitle: "Enter the 6-digit code we texted to \(destination).",
                fields: [code("Verification code", .verifyPhone)], primary: Offer(primary: "Verify", .verifyPhone),
                links: [
                    Offer("resend", "Text a new code", .sendPhoneCode),
                    Offer("differentNumber", "Use a different number", .differentNumber), cancel,
                ])
        case .renamePasskey:
            return TulaAccountContent(
                title: "Rename",
                fields: [Field(field: .name, kind: .name, label: "Passkey name", hint: nil, submit: .saveName)],
                primary: Offer(primary: "Save", .saveName), links: [cancel])
        case .confirm(let what):
            let (title, question, button): (String, String, String)
            switch what {
            case .removePasskey(_, let name):
                (title, question, button) = (
                    "Passkeys", "Remove “\(name)”? You will no longer be able to sign in with it.", "Remove passkey"
                )
            case .turnOffAuthenticator:
                (title, question, button) = (
                    "Two-step verification", "Turn off two-step verification? Your backup codes will stop working.",
                    "Turn off"
                )
            case .turnOffTexted:
                (title, question, button) = (
                    "Two-step verification", "Stop using text messages as your second step?",
                    "Stop using text messages"
                )
            case .removePhone:
                (title, question, button) = (
                    "Phone number", "Remove your phone number from this account?", "Remove phone number"
                )
            }
            return TulaAccountContent(
                title: title, subtitle: question, primary: Offer(primary: button, .confirm, destructive: true),
                links: [cancel])
        }
    }

    /// Every identifier a content gives a control, a section or a row.
    private static func identifiers(_ content: TulaAccountContent) -> [String] {
        var offers = [content.primary, content.setup?.copy, content.codes?.copy].compactMap { $0 } + content.links
        var found: [String] = []
        for section in content.sections {
            found.append(section.identifier)
            found += section.rows.map(\.identifier)
            offers += section.offers + section.rows.flatMap(\.offers)
        }
        return found + offers.map(\.identifier)
    }

    private func assertUnique(_ content: TulaAccountContent, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let found = AccountContentTests.identifiers(content)
        XCTAssertEqual(found.count, Set(found).count, "\(what): an identifier names one thing: \(found)", file: file, line: line)
    }

    private func facts(_ change: (inout TulaAccountFacts) -> Void = { _ in }) -> TulaAccountFacts {
        var facts = TulaAccountFacts()
        facts.formatDate = Account.formatDate
        change(&facts)
        return facts
    }

    private func sections(_ change: (inout TulaAccountFacts) -> Void) -> [TulaAccountSection] {
        let content = TulaAccountContent(panel: .overview, strings: .english, facts: facts(change))
        assertUnique(content, "the overview")
        XCTAssertEqual(content.title, "Account")
        XCTAssertEqual(content.links, [AccountContentTests.signOutLink], "the account always offers to sign out")
        XCTAssertNil(content.primary)
        return content.sections
    }

    // MARK: Every panel

    func testEveryPanelHoldsExactlyItsRow() {
        for panel in AccountContentTests.panels {
            let content = TulaAccountContent(
                panel: panel, strings: .english,
                facts: facts {
                    $0.setup = AccountContentTests.setup
                    $0.backupCodes = Wire.backupCodes
                })
            XCTAssertEqual(content, AccountContentTests.expected(panel), "\(panel)")
            assertUnique(content, "\(panel)")
            XCTAssertEqual(content.fields.map(\.field), panel.fields, "\(panel): the fields are the panel's")
            if panel != .overview {
                XCTAssertEqual(content.sections, [], "\(panel): a form is drawn alone")
            }
        }
    }

    func testATextedStepUpWhoseMessagesAreOffKeepsItsWordsAndLosesItsButton() {
        for others in [[], [TulaStepUpWay.password]] {
            let panel = TulaAccountPanel.stepUp(.textedCode, others: others, sent: nil)
            let content = TulaAccountContent(panel: panel, strings: .english, facts: facts { $0.textedOff = true })
            XCTAssertEqual(content, AccountContentTests.expected(panel, textedOff: true))
            XCTAssertNil(content.primary)
            XCTAssertFalse(content.actions.contains(.sendStepUpCode))
        }
        // The switch is a texted code's alone: an emailed one keeps its button.
        let emailed = TulaAccountContent(
            panel: .stepUp(.emailCode, others: [], sent: nil), strings: .english, facts: facts { $0.textedOff = true })
        XCTAssertEqual(emailed.primary?.action, .sendStepUpCode)
    }

    func testTheSetupFormWithoutAKeyDrawsNoKey() {
        let content = TulaAccountContent(panel: .totpSetup, strings: .english)
        XCTAssertNil(content.setup)
        XCTAssertFalse(content.actions.contains(.copySetupKey))
        XCTAssertEqual(TulaAccountContent(panel: .backupCodes, strings: .english).codes?.codes, [])
    }

    func testThePanelsFieldsAreTheOnesItsFormDraws() {
        XCTAssertEqual(TulaAccountPanel.stepUp(.emailCode, others: [], sent: nil).fields, [])
        XCTAssertEqual(TulaAccountPanel.stepUp(.textedCode, others: [], sent: "x").fields, [.code])
        XCTAssertEqual(TulaAccountPanel.stepUp(.passkey, others: [], sent: nil).fields, [])
        XCTAssertEqual(TulaAccountPanel.changePassword.fields, [.currentPassword, .newPassword])
        XCTAssertTrue(TulaAccountPanel.stepUpUnavailable.isStepUp)
        XCTAssertTrue(TulaAccountPanel.stepUp(.totp, others: [], sent: nil).isStepUp)
        XCTAssertFalse(TulaAccountPanel.overview.isStepUp)
        XCTAssertEqual(Set(TulaAccountPart.allCases), [.user, .sessions, .factors, .passkeys])
    }

    // MARK: The account's sections

    func testNothingReadYetDrawsNoSection() {
        XCTAssertEqual(sections { _ in }, [])
    }

    func testAPartThatCouldNotBeReadSaysSoAndOffersToReadAgain() {
        let titles: [(TulaAccountPart, String, String)] = [
            (.user, "profile", "Profile"), (.sessions, "sessions", "Where you’re signed in"),
            (.factors, "mfa", "Two-step verification"), (.passkeys, "passkeys", "Passkeys"),
        ]
        for (part, name, title) in titles {
            let found = sections { $0.failed = [part] }
            XCTAssertEqual(
                found,
                [
                    Section(
                        name, title, lines: ["This could not be loaded."],
                        offers: [Offer("reload.\(name)", "Try again", .reload)])
                ], "\(part)")
        }
        // Every part at once: four sections, each with a button of its own.
        let all = sections { $0.failed = Set(TulaAccountPart.allCases) }
        XCTAssertEqual(all.map(\.identifier), titles.map { "tula.section.\($0.1)" })
        XCTAssertEqual(Set(all.flatMap(\.offers).map(\.identifier)).count, 4)
        // What was read stays, also when a later read of it failed.
        let kept = sections {
            $0.passkeys = []
            $0.failed = [.passkeys]
        }
        XCTAssertEqual(kept.map(\.identifier), ["tula.section.passkeys"])
        XCTAssertEqual(kept.first?.offers, [])
    }

    func testTheProfileAndThePasswordOfAUser() {
        let change = Offer("changePassword", "Update password", .openChangePassword)
        var found = sections { $0.user = Account.decoded(Account.user(first: "Maya", last: "Okafor")) }
        XCTAssertEqual(
            found,
            [
                Section("profile", "Profile", lines: ["Maya Okafor", "maya@example.com", "Verified"]),
                Section("password", "Password", offers: [change]),
            ])
        found = sections { $0.user = Account.decoded(Account.user(verified: false, first: "", last: "Okafor")) }
        XCTAssertEqual(found.first?.lines, ["Okafor", "maya@example.com", "Not verified"])

        // An account a provider made that gave no address: no address is said, and none invented.
        found = sections { $0.user = Account.decoded(Account.user(email: nil, verified: false, hasPassword: false)) }
        XCTAssertEqual(
            found,
            [
                Section("profile", "Profile", lines: ["No email address."]),
                Section(
                    "password", "Password",
                    lines: [
                        "This account has no password: you sign in another way. To add one, sign out and choose “Forgot password?” on the sign-in screen. We will email you a code to set it."
                    ]),
            ])
    }

    func testThePasswordSentenceNamesTheSignInScreensLinkByItsWordsInTheTable() {
        var strings = TulaStrings.english
        strings.forgotPassword = "Reset it"
        strings.account.passwordNotSet = "Choose {forgotPassword}."
        let content = TulaAccountContent(
            panel: .overview, strings: strings,
            facts: facts { $0.user = Account.decoded(Account.user(hasPassword: false)) })
        XCTAssertEqual(content.sections.last?.lines, ["Choose Reset it."])
    }

    func testThePhoneNumberOfAUser() {
        let with: CurrentUser = Account.decoded(Account.user(phone: "+14155550142"))
        let without: CurrentUser = Account.decoded(Account.user())
        let remove = Offer("phoneRemove", "Remove phone number", .ask(.removePhone), destructive: true)

        XCTAssertNil(sections { $0.user = without }.first { $0.identifier == "tula.section.phone" })
        XCTAssertEqual(
            sections {
                $0.user = without
                $0.phoneEnabled = true
            }.last,
            Section(
                "phone", "Phone number", lines: ["No phone number."],
                offers: [Offer("phoneAdd", "Add a phone number", .openPhone)]))
        XCTAssertEqual(
            sections {
                $0.user = with
                $0.phoneEnabled = true
            }.last,
            Section(
                "phone", "Phone number", lines: ["+14155550142", "Verified"],
                offers: [Offer("phoneChange", "Change phone number", .openPhone), remove]))
        // Text messages were switched off since: the number can still be taken off.
        XCTAssertEqual(
            sections { $0.user = with }.last,
            Section("phone", "Phone number", lines: ["+14155550142", "Verified"], offers: [remove]))
    }

    func testTheSessionsOfAUser() {
        func signOut(_ id: String, _ device: String) -> Offer {
            Offer("signOutSession.\(id)", "Sign out", .signOutSession(id), spoken: "Sign out \(device)", destructive: true)
        }
        let dates = ["Signed in 2026-01-01", "Last active 2026-01-02"]
        let found = sections {
            $0.sessions = Account.sessionList(
                Account.sessions([
                    Account.session("ses_1", client: "ios", current: true, bound: true),
                    Account.session("ses_2", client: "web"), Account.session("ses_3", client: "android", bound: true),
                    Account.session("ses_4", client: "server"), Account.session("ses_5", client: "watch_of_tomorrow"),
                ]))
        }
        XCTAssertEqual(
            found,
            [
                Section(
                    "sessions", "Where you’re signed in",
                    rows: [
                        Row(
                            identifier: "tula.row.session.ses_1", title: "iPhone or iPad app",
                            marks: ["This device", "Bound to a device key"], details: dates, offers: []),
                        Row(
                            identifier: "tula.row.session.ses_2", title: "Web browser", marks: [], details: dates,
                            offers: [signOut("ses_2", "Web browser")]),
                        Row(
                            identifier: "tula.row.session.ses_3", title: "Android app", marks: ["Bound to a device key"],
                            details: dates, offers: [signOut("ses_3", "Android app")]),
                        Row(
                            identifier: "tula.row.session.ses_4", title: "Server", marks: [], details: dates,
                            offers: [signOut("ses_4", "Server")]),
                        Row(
                            identifier: "tula.row.session.ses_5", title: "Unknown device", marks: [], details: dates,
                            offers: [signOut("ses_5", "Unknown device")]),
                    ],
                    offers: [Offer("signOutOthers", "Sign out of all other devices", .signOutOthers, destructive: true)])
            ])
        // What a browser says of itself, and an address, are not drawn.
        let drawn = found.flatMap(\.rows).flatMap { [$0.title] + $0.marks + $0.details }.joined(separator: "\n")
        XCTAssertFalse(drawn.contains("CANARY-user-agent"))
        XCTAssertFalse(drawn.contains("203.0.113.7"))

        // Alone: nothing to sign out of but this device, which the screen's own link does.
        let alone = sections {
            $0.sessions = Account.sessionList(Account.sessions([Account.session("ses_1", current: true)]))
        }
        XCTAssertEqual(alone.first?.offers, [])
        XCTAssertEqual(alone.first?.rows.first?.offers, [])
    }

    func testADateTheServerDidNotWriteAsOneIsLeftOut() {
        var session: Session = Account.decoded(Account.session("ses_2"))
        session.createdAt = "yesterday"
        session.lastActiveAt = "2026-01-02T00:00:00Z"
        let found = sections { $0.sessions = [session] }
        XCTAssertEqual(found.first?.rows.first?.details, ["Last active 2026-01-02"])
        XCTAssertNil(TulaStrings.date(nil, Account.formatDate))
    }

    func testTheSecondStepOfAUser() {
        let turnOn = Offer("turnOn", "Turn on", .setUpAuthenticator)
        let newCodes = Offer("newBackupCodes", "New backup codes", .newBackupCodes)
        let turnOff = Offer("turnOff", "Turn off", .ask(.turnOffAuthenticator), destructive: true)
        let smsOff = Offer("smsTurnOff", "Stop using text messages", .ask(.turnOffTexted), destructive: true)
        let off = "Off. Add a code from an authenticator app as a second step when you sign in."
        func mfa(_ json: String, required: Bool = false) -> TulaAccountSection? {
            sections {
                $0.factors = Account.decoded(json)
                $0.mfaRequired = required
            }.first
        }

        XCTAssertEqual(mfa(Account.factors()), Section("mfa", "Two-step verification", lines: [off], offers: [turnOn]))
        XCTAssertEqual(
            mfa(Account.factors(totp: true, codes: 8)),
            Section(
                "mfa", "Two-step verification", lines: ["On since 2026-01-01.", "8 backup codes left."],
                offers: [newCodes, turnOff]))
        XCTAssertEqual(mfa(Account.factors(totp: true, codes: 1))?.lines.last, "1 backup code left.")
        XCTAssertEqual(mfa(Account.factors(totp: true, codes: 0))?.lines.last, "0 backup codes left.")
        // Required by the environment: it cannot be turned off, and the screen says why.
        XCTAssertEqual(
            mfa(Account.factors(totp: true, codes: 8), required: true),
            Section(
                "mfa", "Two-step verification",
                lines: [
                    "On since 2026-01-01.", "8 backup codes left.",
                    "This app requires two-step verification, so it cannot be turned off.",
                ], offers: [newCodes]))
        // A confirmation time that is not a time: on, said without a date.
        var undated: Factors = Account.decoded(Account.factors(totp: true, codes: 2))
        undated.totp.confirmedAt = nil
        XCTAssertEqual(
            sections { $0.factors = undated }.first?.lines,
            ["Two-step verification is on.", "2 backup codes left."])

        // A texted code: offered, in use, dormant, and not for this user.
        XCTAssertEqual(
            mfa(Account.factors(sms: Account.sms(enabled: false, inUse: false, available: true))),
            Section(
                "mfa", "Two-step verification",
                lines: [off, "You can also get a code by text message as your second step."],
                offers: [turnOn, Offer("smsTurnOn", "Use text messages", .turnOnTexted)]))
        XCTAssertEqual(
            mfa(Account.factors(sms: Account.sms(enabled: true, inUse: true, available: true))),
            Section(
                "mfa", "Two-step verification",
                lines: [
                    off, "A code by text message is your second step since 2026-01-01.",
                    "An authenticator app is safer than a text message. You can add one here.",
                ], offers: [turnOn, smsOff]))
        XCTAssertEqual(
            mfa(Account.factors(totp: true, codes: 8, sms: Account.sms(enabled: true, inUse: false, available: false))),
            Section(
                "mfa", "Two-step verification",
                lines: [
                    "On since 2026-01-01.", "8 backup codes left.",
                    "It is not asked for while you have an authenticator app or a passkey. If you remove that, the code by text message is your second step again.",
                ], offers: [newCodes, turnOff, smsOff]))
        XCTAssertEqual(
            mfa(Account.factors(sms: Account.sms(enabled: false, inUse: false, available: false))),
            Section("mfa", "Two-step verification", lines: [off], offers: [turnOn]))
        var undatedSms: Factors = Account.decoded(
            Account.factors(sms: Account.sms(enabled: true, inUse: true, available: true)))
        undatedSms.sms?.enabledAt = nil
        XCTAssertEqual(
            sections { $0.factors = undatedSms }.first?.lines[1], "A code by text message is now your second step.")
    }

    func testThePasskeysOfAUser() {
        let intro = "A passkey signs you in with your fingerprint, face or screen lock instead of a password."
        let add = Offer("passkeyAdd", "Add a passkey", .addPasskey)
        let none: Factors = Account.decoded(Account.factors())
        func passkeys(_ change: @escaping (inout TulaAccountFacts) -> Void) -> TulaAccountSection? {
            sections {
                $0.passkeys = []
                $0.passkeySheet = true
                change(&$0)
            }.last
        }

        XCTAssertEqual(
            passkeys { $0.factors = none },
            Section("passkeys", "Passkeys", lines: [intro, "You have no passkeys yet."], offers: [add]))
        // No sheet: the reason in words, and no button that could only fail.
        XCTAssertEqual(
            passkeys {
                $0.factors = none
                $0.passkeySheet = false
            },
            Section(
                "passkeys", "Passkeys",
                lines: [
                    intro, "You have no passkeys yet.",
                    "This app cannot create passkeys here. You can still rename or remove the ones you have.",
                ]))
        // The second step is what says whether a passkey would take a texted code's place:
        // until it is known, nothing is offered.
        XCTAssertEqual(
            passkeys { _ in }?.lines.last, "Checking your second step before a passkey can be added…")
        XCTAssertEqual(passkeys { _ in }?.offers, [])
        XCTAssertEqual(
            passkeys { $0.failed = [.factors] }?.lines.last,
            "Your second step could not be checked, so a passkey cannot be added right now.")
        XCTAssertEqual(passkeys { $0.failed = [.factors] }?.offers, [])
        // Said before the sheet, not after.
        XCTAssertEqual(
            passkeys {
                $0.factors = Account.decoded(
                    Account.factors(sms: Account.sms(enabled: true, inUse: true, available: true)))
            },
            Section(
                "passkeys", "Passkeys",
                lines: [
                    intro, "You have no passkeys yet.",
                    "Once you add a passkey, it replaces the code by text message as your second step. A passkey has no backup codes: if you lose it, only an administrator of this app can let you back in.",
                ], offers: [add]))

        let some = passkeys {
            $0.factors = none
            $0.passkeys = [
                Account.decoded(Account.passkey("pk_1", name: "iPhone", synced: true, used: true)),
                Account.decoded(Account.passkey("pk_2", name: "Key", synced: false)),
            ]
        }
        XCTAssertEqual(
            some,
            Section(
                "passkeys", "Passkeys", lines: [intro],
                rows: [
                    Row(
                        identifier: "tula.row.passkey.pk_1", title: "iPhone", marks: ["Synced across your devices"],
                        details: ["Added 2026-01-01", "Last used 2026-01-01"],
                        offers: [
                            Offer("rename.pk_1", "Rename", .openRename("pk_1"), spoken: "Rename iPhone"),
                            Offer(
                                "remove.pk_1", "Remove", .ask(.removePasskey(id: "pk_1", name: "iPhone")),
                                spoken: "Remove iPhone", destructive: true),
                        ]),
                    Row(
                        identifier: "tula.row.passkey.pk_2", title: "Key", marks: ["On one device only"],
                        details: ["Added 2026-01-01", "Not used yet"],
                        offers: [
                            Offer("rename.pk_2", "Rename", .openRename("pk_2"), spoken: "Rename Key"),
                            Offer(
                                "remove.pk_2", "Remove", .ask(.removePasskey(id: "pk_2", name: "Key")),
                                spoken: "Remove Key", destructive: true),
                        ]),
                ], offers: [add]))
    }

    func testAWholeAccountIsDrawnInOneOrderWithEveryIdentifierItsOwn() {
        let found = sections {
            $0.user = Account.decoded(Account.user(phone: "+14155550142"))
            $0.sessions = Account.sessionList(Account.twoSessions)
            $0.factors = Account.decoded(Account.factors(totp: true, codes: 8))
            $0.passkeys = [Account.decoded(Account.passkey())]
            $0.phoneEnabled = true
            $0.passkeySheet = true
        }
        XCTAssertEqual(
            found.map(\.identifier),
            [
                "tula.section.profile", "tula.section.password", "tula.section.sessions", "tula.section.mfa",
                "tula.section.phone", "tula.section.passkeys",
            ])
    }

    func testAfterASignOutThatFailedTheScreenOffersToSignOutAndNothingElse() {
        let content = TulaAccountContent(
            panel: .overview, strings: .english,
            facts: facts {
                $0.user = Account.decoded(Account.user())
                $0.sessions = Account.sessionList(Account.twoSessions)
                $0.signOutFailed = true
            })
        XCTAssertEqual(
            content, TulaAccountContent(title: "Account", primary: Offer(primary: "Sign out", .signOut, destructive: true)))
        XCTAssertEqual(content.actions, [.signOut])
    }

    // MARK: What can be asked for

    func testTheActionsOfAContentAreItsOffersAndItsFieldsSubmit() {
        XCTAssertEqual(
            TulaAccountContent(panel: .changePassword, strings: .english).actions, [.submitPassword, .cancel])
        XCTAssertEqual(
            TulaAccountContent(
                panel: .totpSetup, strings: .english, facts: facts { $0.setup = AccountContentTests.setup }
            ).actions, [.confirmAuthenticator, .cancel, .copySetupKey])
        XCTAssertEqual(
            TulaAccountContent(panel: .backupCodes, strings: .english).actions, [.savedBackupCodes, .copyBackupCodes])
        XCTAssertEqual(
            TulaAccountContent(panel: .stepUp(.totp, others: [.backupCode], sent: nil), strings: .english).actions,
            [.submitStepUp, .useStepUpWay(.backupCode), .cancel])
    }

    func testAnActionTheScreenDoesNotOfferDoesNothing() async throws {
        let stage = try await AccountStage.loaded()
        let before = stage.api.routes
        // None of these is on the account of a user with a password and no second step.
        let absent: [TulaAccountAction] = [
            .submitPassword, .confirmAuthenticator, .newBackupCodes, .savedBackupCodes, .copySetupKey,
            .copyBackupCodes, .turnOnTexted, .confirmTexted, .openPhone, .sendPhoneCode, .differentNumber,
            .verifyPhone, .addPasskey, .openRename("pk_1"), .saveName, .ask(.turnOffAuthenticator), .confirm, .cancel,
            .useStepUpWay(.password), .sendStepUpCode, .submitStepUp, .stepUpWithPasskey, .signOutSession("ses_1"),
            .signOutSession("ses_9"), .reload,
        ]
        for action in absent {
            XCTAssertFalse(stage.model.content.actions.contains(action), "\(action)")
            await stage.model.perform(action)
            XCTAssertEqual(stage.model.panel, .overview, "\(action)")
        }
        XCTAssertEqual(stage.api.routes, before, "nothing was asked of the server")
        XCTAssertEqual(stage.heard.said, [])
        XCTAssertEqual(stage.heard.copied, [])
    }

    // MARK: Words of the model

    func testAProblemIsSaidAsOneAndAFieldIsReadWithIt() async throws {
        let stage = try await AccountStage.loaded()
        await stage.model.perform(.openChangePassword)
        let field = try XCTUnwrap(stage.model.content.fields.first)
        XCTAssertEqual(stage.model.spokenLabel(of: field), "Current password")
        XCTAssertEqual(stage.model.problems(of: .currentPassword), [])
        XCTAssertNil(stage.model.formProblem)
        await stage.model.perform(.submitPassword)
        XCTAssertEqual(stage.model.problems(of: .currentPassword), ["Error: This field is required."])
        XCTAssertEqual(stage.model.spokenLabel(of: field), "Current password, invalid: This field is required.")

        stage.model.currentPassword = "a"
        stage.model.newPassword = "b"
        stage.api.on(Account.password, Reply.error(503, "service.unavailable"))
        await stage.model.perform(.submitPassword)
        let problem = try XCTUnwrap(stage.model.formProblem)
        XCTAssertTrue(problem.hasPrefix("Error: "))
        XCTAssertFalse(problem.contains(Canary.serverText))
    }
}
