import Foundation
import TulaAuth
import XCTest

// What the UI tests stand on: the example app on a simulator, and the REAL API, served on
// this machine by native/swift/fixture/server.ts (the server the Swift client's journeys run
// against). A simulator shares the machine's loopback address, so the app and this test
// runner both reach it at 127.0.0.1.
//
// The tests cannot start the fixture themselves (a test runner on a simulator starts no
// process of the machine), so `bun run native/swift/fixture/ui-tests.ts` starts it, hands
// its address over as TULA_FIXTURE_ORIGIN and runs `xcodebuild test`.
//
// Everything here is synchronous on purpose. A UI test only asks the app's accessibility
// tree and the fixture, and an `async` set-up or tear-down on a main-actor test class ended
// the runner process in the concurrency runtime (Xcode 16.4: `swift_task_dealloc` under
// `XCTSwiftErrorObservation`), which the system reports as "TulaExampleUITests-Runner quit
// unexpectedly".

struct SeamFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// A value handed from a background task to the thread that waits for it.
private final class Handover<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Result<Value, Error>?
    func put(_ result: Result<Value, Error>) {
        lock.lock()
        held = result
        lock.unlock()
    }
    func take() -> Result<Value, Error>? {
        lock.lock()
        defer { lock.unlock() }
        return held
    }
}

/// Run async work and wait for it, at most `seconds`. The work never needs the main thread
/// (the client is not bound to it), so waiting on it here cannot deadlock.
private func waitFor<Value: Sendable>(
    seconds: TimeInterval = 30, _ work: @escaping @Sendable () async throws -> Value
) throws -> Value {
    let handover = Handover<Value>()
    let done = DispatchSemaphore(value: 0)
    let task = Task.detached {
        do {
            handover.put(.success(try await work()))
        } catch {
            handover.put(.failure(error))
        }
        done.signal()
    }
    guard done.wait(timeout: .now() + seconds) == .success, let result = handover.take() else {
        task.cancel()
        throw SeamFailure("the fixture or the client did not answer in \(Int(seconds)) seconds")
    }
    return try result.get()
}

/// One API in memory, made for one test: what a journey's `Server` is.
struct World: Sendable {
    static let password = "Correct-Horse-9-Battery!"

    let origin: String
    let id: String
    let baseURL: String
    let publishableKey: String

    static func create() throws -> World {
        guard let origin = ProcessInfo.processInfo.environment["TULA_FIXTURE_ORIGIN"], !origin.isEmpty else {
            throw SeamFailure(
                "no fixture: run these tests with `bun run native/swift/fixture/ui-tests.ts`, which starts the API and hands its address over"
            )
        }
        let made = try request("POST", "\(origin)/__test/servers", body: [:])
        guard
            let answer = made as? [String: Any], let id = answer["id"] as? String,
            let baseURL = answer["baseUrl"] as? String, let key = answer["publishableKey"] as? String
        else {
            throw SeamFailure("the fixture did not make a server")
        }
        return World(origin: origin, id: id, baseURL: baseURL, publishableKey: key)
    }

    @discardableResult
    private static func request(_ method: String, _ url: String, body: Any? = nil) throws -> Any {
        guard let address = URL(string: url) else { throw SeamFailure("not a URL") }
        var request = URLRequest(url: address)
        request.httpMethod = method
        request.timeoutInterval = 20
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let handover = Handover<Data>()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let data, (response as? HTTPURLResponse)?.statusCode == 200 {
                handover.put(.success(data))
            } else {
                handover.put(.failure(SeamFailure("the fixture refused \(method) \(address.path)\(error == nil ? "" : " (no answer)")")))
            }
            done.signal()
        }.resume()
        guard done.wait(timeout: .now() + 30) == .success, let result = handover.take() else {
            throw SeamFailure("the fixture did not answer \(method) \(address.path)")
        }
        return try JSONSerialization.jsonObject(with: try result.get(), options: [.fragmentsAllowed])
    }

    func remove() {
        _ = try? World.request("DELETE", "\(origin)/__test/servers/\(id)")
    }

    /// The environment's settings as an operator saved them: the defaults, with these
    /// sections.
    func settings(_ sections: [String: Any]) throws {
        try World.request("POST", "\(origin)/__test/servers/\(id)/settings", body: ["settings": sections])
    }

    /// Move the server's clock: past the wait between two emails to one address.
    func advance(seconds: Int) throws {
        try World.request("POST", "\(origin)/__test/servers/\(id)/advance", body: ["ms": seconds * 1000])
    }

    private func emails(_ email: String) throws -> [[String: Any]] {
        let query = email.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        return try World.request("GET", "\(origin)/__test/servers/\(id)/emails?to=\(query)") as? [[String: Any]] ?? []
    }

    /// The code a subject leads with, if it leads with one.
    private static func leadingCode(_ sent: [String: Any]) -> String? {
        let subject = sent["subject"] as? String ?? ""
        let lead = subject.prefix(6)
        guard lead.count == 6, lead.allSatisfy(\.isNumber), subject.dropFirst(6).first?.isNumber != true else {
            return nil
        }
        return String(lead)
    }

    /// The code of the newest email to `email` whose subject leads with one, once more than
    /// `after` such emails were sent.
    func code(_ email: String, after: Int = 0) throws -> String {
        // The email of a step is sent before the step is answered, but the screen can be
        // drawn a moment before this asks: look a few times.
        for _ in 0..<40 {
            let codes = try emails(email).compactMap(World.leadingCode)
            if codes.count > after, let newest = codes.last {
                return newest
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw SeamFailure("no email with a code was sent to that address")
    }

    /// How many emails with a code were sent to `email`.
    func codesSent(_ email: String) throws -> Int {
        try emails(email).compactMap(World.leadingCode).count
    }

    /// An account with a proven address and a password, made as an app would: by the
    /// client, in this process, with its tokens in memory. The clock is then moved past the
    /// wait between two emails to one address, so that the test's own email is not refused.
    func account(_ email: String) throws {
        let world = self
        let flow = try waitFor { () -> SignUpFlow in
            let client = try TulaClient(
                publishableKey: world.publishableKey, baseURL: world.baseURL, storage: MemoryTokenStorage())
            return try await client.startSignUp(email: email, password: World.password)
        }
        let code = try code(email)
        try waitFor {
            try await flow.verifyEmail(code: code)
        }
        try advance(seconds: 120)
    }
}

/// A test of the screens: a fresh API, and the example app pointed at it.
@MainActor
class ScreenTestCase: XCTestCase {
    var world: World!
    var app: XCUIApplication!
    private var addresses = 0

    override func setUpWithError() throws {
        // A helper that cannot go on throws; an assertion that fails lets the test go on.
        continueAfterFailure = true
        world = try World.create()
    }

    override func tearDownWithError() throws {
        if testRun?.hasSucceeded == false { keepScreenshot("end") }
        app?.terminate()
        world?.remove()
        XCUIDevice.shared.appearance = .light
    }

    func freshEmail() -> String {
        addresses += 1
        return "screen-user-\(addresses)@example.com"
    }

    func launch(dark: Bool = false) {
        XCUIDevice.shared.appearance = dark ? .dark : .light
        app = XCUIApplication()
        app.launchEnvironment["TULA_API_URL"] = world.baseURL
        app.launchEnvironment["TULA_PUBLISHABLE_KEY"] = world.publishableKey
        app.launch()
    }

    // MARK: Reading the screen

    var title: XCUIElement { app.staticTexts["tula.title"] }
    var primary: XCUIElement { app.buttons["tula.primary"] }

    /// Wait until the screen's title is `text`.
    func expectTitle(_ text: String) throws {
        let shown = NSPredicate(format: "label == %@", text)
        let waited = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: shown, object: title)], timeout: 20)
        if waited != .completed {
            let problem = app.staticTexts["tula.formError"]
            throw SeamFailure(
                "the title is \"\(title.exists ? title.label : "(none)")\", not \"\(text)\"; form error: \(problem.exists ? problem.label : "(none)")"
            )
        }
    }

    /// Wait until the example app says somebody is signed in.
    func expectSignedIn(as email: String) throws {
        guard app.staticTexts["example.signedIn"].waitForExistence(timeout: 20) else {
            let problem = app.staticTexts["tula.formError"]
            throw SeamFailure(
                "nobody is signed in; the title is \"\(title.exists ? title.label : "(none)")\", form error: \(problem.exists ? problem.label : "(none)")"
            )
        }
        XCTAssertEqual(app.staticTexts["example.email"].label, email)
    }

    func field(_ name: String) -> XCUIElement {
        let identifier = "tula.field.\(name)"
        let plain = app.textFields[identifier]
        return plain.exists ? plain : app.secureTextFields[identifier]
    }

    func type(_ text: String, into name: String) throws {
        let target = field(name)
        guard target.waitForExistence(timeout: 10) else { throw SeamFailure("no field \(name)") }
        target.tap()
        target.typeText(text)
    }

    func tapLink(_ name: String) throws {
        let link = app.buttons["tula.link.\(name)"]
        guard link.waitForExistence(timeout: 10) else { throw SeamFailure("no link \(name)") }
        if !link.isHittable {
            app.swipeUp()
        }
        link.tap()
    }

    func tapPrimary() throws {
        guard primary.waitForExistence(timeout: 10) else { throw SeamFailure("no main button") }
        if !primary.isHittable {
            // The keyboard can cover the button on a small screen.
            app.swipeUp()
        }
        primary.tap()
    }

    /// The system's accessibility audit of what is on the screen: contrast, element
    /// descriptions, hit regions, traits, clipped text and Dynamic Type. It is what axe is
    /// to the browser tests, and like axe it is not VoiceOver: no test here turns VoiceOver
    /// on.
    func audit(file: StaticString = #filePath, line: UInt = #line) throws {
        // Every issue is collected and reported with the element it is about: the audit's
        // own failure names neither.
        let found = try auditIssues()
        if !found.isEmpty { keepScreenshot("audit-\(line)") }
        XCTAssertEqual(found, [], "the accessibility audit found issues", file: file, line: line)
    }

    /// Put the keyboard away, by the drag the screens' scroll view answers.
    ///
    /// The audit measures an element from the pixels at its frame, and a screen's last
    /// lines are under the keyboard while it is up: their contrast was then the
    /// keyboard's ("Secured by Tula" and "Forgot password?" failed on the password screen
    /// and on no screen without a keyboard). So a screen is audited with the keyboard
    /// away, and no contrast finding is left out.
    private func putKeyboardAway() throws {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }
        let from = title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99))
        from.press(forDuration: 0.1, thenDragTo: to)
        let gone = NSPredicate(format: "exists == false")
        let waited = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: gone, object: keyboard)], timeout: 10)
        guard waited == .completed else { throw SeamFailure("the keyboard did not go away for the audit") }
    }

    private func auditIssues() throws -> [String] {
        try putKeyboardAway()
        var found: [String] = []
        try app.performAccessibilityAudit { issue in
            let element = issue.element
            // One finding is left out, for one element: "Text clipped" on the address field
            // while it holds an address. The audit reports it for text that is drawn whole,
            // with room to spare (Xcode 16.4, iOS 18.5: an address of 25 characters in a
            // field 321 points wide, seen on "Reset your password" and on "Create your
            // account" with the address carried over). Text clipped in the password, the
            // code or the new-password field, in the address field while it is empty, or
            // in a label, a button or a message, still fails. It is an exclusion of the
            // audit's finding, not a proof that the finding is wrong.
            if issue.auditType == .textClipped, element?.identifier == "tula.field.email",
                (element?.value as? String ?? "").isEmpty == false
            {
                return true
            }
            found.append("\(issue.compactDescription) [\(element?.identifier ?? "") \"\(element?.label ?? "")\"]")
            return true
        }
        return found
    }

    /// Show what a password field holds, so that it is typed into as plain text.
    ///
    /// A simulator covers a secure field for a new password with the system's "strong
    /// password" suggestion, and what a test types there never reaches the field. The
    /// screens' own "Show password" button makes it a plain field, which the suggestion
    /// leaves alone.
    func reveal(_ name: String) throws {
        let button = app.buttons["tula.reveal.\(name)"]
        guard button.waitForExistence(timeout: 10) else { throw SeamFailure("no reveal button for \(name)") }
        button.tap()
    }

    /// Keep a picture of the screen where TULA_SCREENSHOT_DIR says (a directory of this
    /// machine: a simulator's processes see its files), for reading a failure. Nothing is
    /// kept when it is not set.
    func keepScreenshot(_ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["TULA_SCREENSHOT_DIR"], !directory.isEmpty else {
            return
        }
        let test = self.name.filter { $0.isLetter || $0.isNumber }
        let file = URL(fileURLWithPath: directory).appendingPathComponent("\(test)-\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: file)
    }
}
