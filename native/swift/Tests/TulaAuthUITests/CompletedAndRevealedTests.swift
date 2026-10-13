import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// What a screen is when a flow completed and its session could not be stored, what a late
// completion does to a flow that was opened meanwhile, and what "show password" is after
// its screen was left.
@MainActor
final class CompletedAndRevealedTests: XCTestCase {
    // MARK: A flow that completed, whose session could not be stored

    /// One way a flow completes: where it starts, and the action that finishes it.
    private struct Completion {
        let name: String
        let mode: TulaAuthMode
        /// Bring a stage to the step before the last, with the last answer registered.
        let ready: @MainActor (Stage) async -> Void
        /// The route of the action that completes, and the action itself.
        let route: String
        let finish: @MainActor (TulaAuthModel) async -> Void
    }

    private static let completions: [Completion] = [
        Completion(
            name: "a sign-in's password", mode: .signIn,
            ready: { stage in
                await stage.signIn(to: Wire.needsPassword)
                stage.api.on(Wire.password, Wire.flow("sign_in", Wire.complete))
                stage.model.password = Canary.password
            },
            route: Wire.password, finish: { await $0.submitPassword() }),
        Completion(
            name: "a sign-in's emailed code", mode: .signIn,
            ready: { stage in
                await stage.signIn(to: Wire.codeOnlyPrepared)
                stage.api.on(Wire.attempt, Wire.flow("sign_in", Wire.complete))
                stage.model.code = "123456"
            },
            route: Wire.attempt, finish: { await $0.submitCode() }),
        Completion(
            name: "a sign-up's emailed code", mode: .signUp,
            ready: { stage in
                stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.verification, start: true))
                stage.model.email = "maya@example.com"
                stage.model.password = Canary.password
                await stage.model.start()
                stage.api.on(Wire.signUpVerify, Wire.flow("sign_up", Wire.complete))
                stage.model.code = "123456"
            },
            route: Wire.signUpVerify, finish: { await $0.submitCode() }),
        Completion(
            name: "a sign-in's texted code", mode: .signIn,
            ready: { stage in
                stage.api.on(Wire.signIns, Wire.flow("sign_in", Wire.passwordAndTextPrepared, start: true))
                stage.model.email = Wire.number
                await stage.model.start()
                stage.api.on(Wire.attempt, Wire.flow("sign_in", Wire.complete))
                stage.model.code = "123456"
            },
            route: Wire.attempt, finish: { await $0.submitCode() }),
        Completion(
            name: "a second step's authenticator code", mode: .signIn,
            ready: { stage in
                await stage.signIn(to: Wire.secondFactor)
                stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
                stage.model.code = "123456"
            },
            route: Wire.secondFactorRoute, finish: { await $0.submitCode() }),
        Completion(
            name: "a second step's texted code", mode: .signIn,
            ready: { stage in
                await stage.signIn(to: Wire.textedSecondPrepared)
                stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
                stage.model.useSecondWay(.textedCode)
                stage.model.code = "123456"
            },
            route: Wire.secondFactorRoute, finish: { await $0.submitCode() }),
    ]

    func testAFlowThatCompletedIsSignedInAlsoWhenItsSessionCouldNotBeStored() async throws {
        // The answer said `complete`, the client holds the session in memory, and the
        // Keychain refused the write. The action throws `storage.failed`, and the flow is
        // over: a form left open would have a button that can only say `flow.invalid_step`
        // to somebody who is signed in.
        for completion in Self.completions {
            let storage = RefusingStorage()
            let stage = try Stage(mode: completion.mode, storage: storage)
            await completion.ready(stage)
            await completion.finish(stage.model)

            let refused = await storage.refused
            XCTAssertEqual(refused, 1, "\(completion.name): the write was asked for and refused")
            let signedIn = await stage.isSignedIn
            XCTAssertTrue(signedIn, "\(completion.name): the client is signed in, in memory")
            XCTAssertEqual(stage.model.screen, .signedIn, completion.name)
            XCTAssertEqual(stage.heard.signedIn, 1, "\(completion.name): the app is told, once")
            XCTAssertEqual(stage.model.formError, stage.model.strings.sessionNotSaved, completion.name)
            XCTAssertEqual(
                stage.heard.said.filter { $0 == stage.model.strings.sessionNotSaved }.count, 1,
                "\(completion.name): said to VoiceOver, once")
            XCTAssertFalse(stage.model.isPending, completion.name)
            XCTAssertEqual(
                [stage.model.password, stage.model.code, stage.model.newPassword], ["", "", ""], completion.name)

            // Nothing is left to press: the same action again asks nothing.
            let sent = stage.api.count(completion.route)
            stage.model.password = Canary.password
            stage.model.code = "123456"
            await completion.finish(stage.model)
            XCTAssertEqual(stage.api.count(completion.route), sent, "\(completion.name): no second request")
            XCTAssertEqual(stage.model.screen, .signedIn, completion.name)
            XCTAssertEqual(stage.heard.signedIn, 1, completion.name)
            XCTAssertFalse(stage.shown.contains("flow.invalid_step"), completion.name)
        }
    }

    func testAStartThatCompletedAtOnceIsSignedInAlsoWhenItsSessionCouldNotBeStored() async throws {
        // A start hands back no flow when it throws: the client's own session is asked.
        let stage = try Stage(mode: .signUp, storage: RefusingStorage())
        stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.complete, start: true))
        stage.model.email = "maya@example.com"
        stage.model.password = Canary.password
        await stage.model.start()

        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertEqual(stage.model.formError, stage.model.strings.sessionNotSaved)
        XCTAssertEqual(stage.model.password, "")

        await stage.model.start()
        XCTAssertEqual(stage.api.count(Wire.signUps), 1)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testAStartThatFailedBeforeAnybodyWasSignedInIsSaidOnItsForm() async throws {
        // `storage.failed` alone decides nothing: it is a completion only when the client
        // is signed in. (No start raises it otherwise today; an answer in its code does.)
        let stage = try Stage()
        stage.api.on(Wire.signIns, Reply.error(500, "storage.failed"))
        stage.model.email = "maya@example.com"
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertEqual(stage.heard.signedIn, 0)
        XCTAssertNotNil(stage.model.formError)
        XCTAssertNotEqual(stage.model.formError, stage.model.strings.sessionNotSaved)
    }

    func testTheWordsOfASessionThatWasNotSavedSayWhenItEnds() {
        let words = TulaStrings.english.sessionNotSaved
        XCTAssertTrue(words.contains("could not be saved on this device"))
        XCTAssertTrue(words.contains("when the app closes"))
    }

    func testTheNoteOfASessionThatWasNotSavedGoesWithItsScreen() async throws {
        let stage = try Stage(storage: RefusingStorage())
        await Self.completions[0].ready(stage)
        await Self.completions[0].finish(stage.model)
        XCTAssertEqual(stage.model.formError, stage.model.strings.sessionNotSaved)
        stage.model.close()
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertNil(stage.model.formError)
    }

    func testAFlowWhoseSessionCouldNotBeStoredIsSignedInAlsoWhenItsScreenWasLeft() async throws {
        // The write is refused after the screen was left: the answer comes back as an
        // error under an older generation, and the client is signed in all the same.
        let gate = Gate()
        let storage = HeldThenRefusingStorage(gate)
        let stage = try Stage(storage: storage)
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.complete))
        stage.model.password = Canary.password
        let sending = Task { await stage.model.submitPassword() }
        await eventually("the session is being stored") { await storage.writes == 1 }
        stage.model.showSignUp()
        gate.open()
        await sending.value

        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertEqual(stage.model.formError, stage.model.strings.sessionNotSaved)
    }

    // MARK: A completion that arrives after another flow was opened

    func testALateCompletionEndsTheFlowThatWasOpenedMeanwhile() async throws {
        // Deliberate (ADR 0057): the client is signed in, so whatever is open is left, as
        // `@tula/react`'s screens are taken away when the client becomes signed in.
        let gate = Gate()
        let storage = HeldStorage(gate)
        let stage = try Stage(storage: storage)
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.complete))
        stage.model.password = Canary.password
        let sending = Task { await stage.model.submitPassword() }
        await eventually("the session is being stored") { await storage.writes == 1 }

        // The screen closes, and a second sign-in is started and typed into.
        stage.model.close()
        XCTAssertEqual(stage.heard.signedIn, 0)
        stage.api.on(Wire.signIns, Wire.flow("sign_in", Wire.both, start: true))
        stage.model.email = "noor@example.com"
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: true))
        stage.model.password = Canary.password
        stage.model.toggleReveal(.password)
        let starts = stage.api.count(Wire.signIns)
        let passwords = stage.api.count(Wire.password)
        let prepares = stage.api.count(Wire.prepare)

        gate.open()
        await sending.value

        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1, "once for the completion, after the close")
        XCTAssertEqual([stage.model.password, stage.model.code, stage.model.newPassword], ["", "", ""])
        XCTAssertFalse(stage.model.isRevealed(.password))
        XCTAssertNil(stage.model.formError)

        // The second flow is gone: nothing the screen had can ask for anything.
        stage.model.password = Canary.password
        await stage.model.submitPassword()
        await stage.model.sendEmailCode()
        await stage.model.perform(.submitPassword)
        await stage.model.perform(.sendEmailCode)
        XCTAssertEqual(stage.api.count(Wire.signIns), starts)
        XCTAssertEqual(stage.api.count(Wire.password), passwords)
        XCTAssertEqual(stage.api.count(Wire.prepare), prepares)
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    // MARK: "Show password"

    func testAPasswordIsHiddenUntilAskedForAndOnlyASecretFieldCanBeShown() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        XCTAssertFalse(stage.model.isRevealed(.password))
        stage.model.toggleReveal(.password)
        XCTAssertTrue(stage.model.isRevealed(.password))
        stage.model.toggleReveal(.password)
        XCTAssertFalse(stage.model.isRevealed(.password))

        // A field the screen does not have, and one that is no secret, are never "shown".
        stage.model.toggleReveal(.newPassword)
        stage.model.toggleReveal(.email)
        stage.model.toggleReveal(.code)
        XCTAssertFalse(stage.model.isRevealed(.newPassword))
        XCTAssertFalse(stage.model.isRevealed(.email))
        XCTAssertFalse(stage.model.isRevealed(.code))
    }

    func testAShownPasswordIsHiddenAgainWhenItsScreenChanges() async throws {
        let stage = try Stage()
        stage.api.on(Wire.signIns, Wire.flow("sign_in", Wire.both, start: true))
        stage.model.email = "maya@example.com"
        await stage.model.start()
        stage.model.toggleReveal(.password)
        XCTAssertTrue(stage.model.isRevealed(.password))

        // To the emailed code and back: the next password typed is not drawn in the clear.
        stage.api.on(Wire.prepare, Wire.flow("sign_in", Wire.bothPrepared))
        await stage.model.sendEmailCode()
        XCTAssertFalse(stage.model.isRevealed(.password))
        stage.model.usePassword()
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: true))
        XCTAssertFalse(stage.model.isRevealed(.password))
    }

    func testAShownPasswordIsHiddenAgainWhenTheScreenCloses() async throws {
        let stage = try Stage(mode: .signUp)
        stage.model.toggleReveal(.password)
        XCTAssertTrue(stage.model.isRevealed(.password))
        stage.model.close()
        XCTAssertEqual(stage.model.screen, .signUpStart, "the same screen again")
        XCTAssertFalse(stage.model.isRevealed(.password))
    }

    func testAShownPasswordIsHiddenAgainWhenAnotherFlowIsOpenedOrItIsSent() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.model.toggleReveal(.password)
        stage.model.startAgain()
        XCTAssertFalse(stage.model.isRevealed(.password))

        // Sent and refused: the field is emptied, and what is typed next is hidden.
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Reply.error(401, "auth.invalid_credentials"))
        stage.model.password = Canary.password
        stage.model.toggleReveal(.password)
        await stage.model.submitPassword()
        XCTAssertEqual(stage.model.password, "")
        XCTAssertFalse(stage.model.isRevealed(.password))
    }
}

/// A token storage whose first write waits for a gate and is then refused.
actor HeldThenRefusingStorage: TulaTokenStorage {
    private(set) var writes = 0
    private let gate: Gate

    init(_ gate: Gate) { self.gate = gate }

    func get(_ key: String) async throws -> String? { nil }

    func set(_ key: String, _ value: String) async throws {
        writes += 1
        await gate.wait()
        throw WriteRefused()
    }

    func remove(_ key: String) async throws {}
}
