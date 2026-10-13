import Foundation
import TulaAuth

// The words of the screens that came after the first ones (TULA-60): the other ways to sign
// in, the second step, and the account screen. Each is a part of the one table
// (`TulaStrings.ways`, `.secondStep`, `.account`), so an app still hands over one value and
// every string a person reads is still a property of it.

/// The words of the ways to sign in beside an address: a passkey, a provider, a texted code.
public struct TulaSignInWayStrings: Hashable, Sendable {
    /// The first field's label where a phone number signs in too.
    public var identifierLabel = "Email address or phone number"
    /// Under that field.
    public var identifierHint = "For a phone number, include the country code, for example +1 415 555 0142."
    /// Between the form and the other ways.
    public var divider = "or"
    /// The button that opens the system's passkey sheet.
    public var passkey = "Sign in with a passkey"
    /// A provider's button. `{provider}` is the provider's name.
    public var continueWith = "Continue with {provider}"
    /// The providers' names, by the name the server gives them. One that is not here is
    /// not drawn: a button is never worded from a server's string.
    public var providers: [String: String] = [
        "google": "Google", "github": "GitHub", "apple": "Apple", "microsoft": "Microsoft", "discord": "Discord",
        "linkedin": "LinkedIn", "x": "X", "facebook": "Facebook",
    ]
    /// Said quietly when the passkey sheet was closed: not an error, and not a sign-in.
    public var passkeyDismissed = "The passkey request was cancelled. Nothing was changed; you can try again."
    /// Above the form when the server refused what the passkey sheet returned: about the
    /// passkey, never about a password.
    public var passkeyRefused = "That passkey did not sign you in. Try again, or sign in another way."
    /// Said quietly when a provider's sheet or the browser was closed.
    public var providerCancelled = "Sign-in was cancelled. Nothing was changed; you can try again."
    /// A provider's round trip came back with nothing this app can finish.
    public var providerRefused = "We could not sign you in. Nothing was changed; start again."
    /// A provider's sheet of the app's own could not be shown or gave nothing.
    public var providerFailed = "The sign-in could not be shown. Try again."
    /// The link that sends again the last step of a provider sign-in that got no answer.
    public var providerRetry = "Try again"
    /// Said quietly when another sheet of the app is still open (`flow.busy`).
    public var sheetBusy = "Another sign-in window is still open. Finish or close it first."
    /// On the first screen, where every way the environment signs in with is one this app
    /// cannot take on this device.
    public var noWayHere =
        "The ways to sign in here are ones this version of the app cannot use on this device. Update the app."
    /// The button, and the link, that asks for a texted sign-in code.
    public var smsCode = "Text me a code"
    /// Before a code was asked for. Never a claim that a message will arrive.
    public var smsPrompt = "We will text a 6-digit code to this number, if you can sign in with it."
    /// The title of the texted code's screens.
    public var smsTitle = "Check your phone"
    /// `{destination}` is the masked number.
    public var smsSubtitle = "Enter the 6-digit code we texted to {destination}."
    /// The link that asks for another text message.
    public var smsResend = "Text a new code"
    /// Said once another message was asked for.
    public var smsResent = "If you can sign in with this number, a new code is on its way."
    /// Under the code field when a texted sign-in code was refused: about the code, never
    /// about a password.
    public var smsCodeWrong = "That code did not sign you in. Check it, ask for a new one, or sign in another way."

    /// The English words.
    public init() {}
}

/// The words of the second step of a sign-in, and of setting one up inside a sign-in.
public struct TulaSecondStepStrings: Hashable, Sendable {
    /// The title of every second-step screen.
    public var title = "Two-step verification"
    /// Under the title, for a code of an authenticator app.
    public var totpSubtitle = "Enter the 6-digit code from your authenticator app."
    /// The label of that code's field.
    public var totpLabel = "Authentication code"
    /// Under a code field whose code the server refused.
    public var codeWrong = "That code is incorrect."
    /// The link to the backup code's screen.
    public var useBackupCode = "Use a backup code"
    /// The link to the authenticator code's screen.
    public var useAuthenticator = "Use your authenticator app"
    /// Under the title, for a backup code.
    public var backupSubtitle = "Enter one of your backup codes. Each code works once."
    /// The label of the backup code's field.
    public var backupLabel = "Backup code"
    /// Under that field.
    public var backupHint = "10 characters, for example abcde-fghjk"
    /// Under that field when it was left empty.
    public var backupRequired = "Enter a backup code."
    /// Under the title where the step is a passkey.
    public var passkeySubtitle = "Use your passkey to finish signing in."
    /// The button that opens the passkey sheet.
    public var usePasskey = "Use your passkey"
    /// The link to the passkey's screen.
    public var usePasskeyInstead = "Use your passkey instead"
    /// Before a texted code was asked for.
    public var smsSubtitle = "We will text a 6-digit code to the phone number on your account."
    /// The button that asks for it.
    public var smsSend = "Text me a code"
    /// The link to the texted code's screen.
    public var smsInstead = "Get a code by text message"
    /// `{destination}` is the masked number.
    public var smsSent = "Enter the 6-digit code we texted to {destination}."
    /// The link that asks for another message.
    public var smsResend = "Text a new code"
    /// Said once another message was asked for.
    public var smsResent = "A new code is on its way."
    /// The button that sends a second step's code.
    public var submit = "Verify"

    /// The title of the screens that set up two-step verification inside a sign-in.
    public var enrolTitle = "Set up two-step verification"
    /// Under it, before anything was started.
    public var enrolRequired =
        "This app requires two-step verification. Set up an authenticator app to finish signing in."
    /// The button that starts it.
    public var enrolStart = "Set up authenticator app"
    /// Above the QR code and the setup key.
    public var scanInstruction =
        "Scan this QR code with your authenticator app, or enter the setup key by hand. Then enter the 6-digit code the app shows."
    /// What the QR code is read as.
    public var qrLabel = "QR code for your authenticator app. If you cannot scan it, use the setup key."
    /// The label of the setup key.
    public var secretLabel = "Setup key"
    /// Under the setup key.
    public var secretHint = "Keep this key private. It is shown only now."
    /// The button that puts the setup key on the pasteboard.
    public var copyKey = "Copy setup key"
    /// The button that confirms the authenticator app with its code.
    public var confirmSubmit = "Turn on"
    /// The title of the screen that shows the backup codes, once.
    public var backupCodesTitle = "Save your backup codes"
    /// Under it.
    public var backupCodesIntro =
        "Each code signs you in once if you cannot use your authenticator app. Keep them somewhere safe: they will not be shown again."
    /// What the list of codes is read as.
    public var backupCodesList = "Backup codes"
    /// The button that puts the codes on the pasteboard.
    public var copy = "Copy"
    /// Said once something was copied.
    public var copied = "Copied."
    /// The button that closes the codes' screen.
    public var saved = "I have saved these codes"

    /// The English words.
    public init() {}
}

/// The words of the account screen.
public struct TulaAccountStrings: Hashable, Sendable {
    // MARK: The screen

    /// The screen's title.
    public var title = "Account"
    /// Where a part of the account could not be read.
    public var sectionFailed = "This could not be loaded."
    /// The link that reads the account again.
    public var reload = "Try again"
    /// The button that closes a form without doing anything.
    public var cancel = "Cancel"
    /// The button that stores what a form holds.
    public var save = "Save"
    /// Said quietly when a form was closed: not an error.
    public var nothingChanged = "Nothing was changed."

    // MARK: Profile

    /// The profile's heading.
    public var profileTitle = "Profile"
    /// Beside an address that was proven.
    public var emailVerified = "Verified"
    /// Beside one that was not.
    public var emailUnverified = "Not verified"
    /// For an account with no address.
    public var noEmail = "No email address."

    // MARK: Password

    /// The password's heading.
    public var passwordTitle = "Password"
    /// For an account with no password. `{forgotPassword}` is the sign-in screen's link.
    public var passwordNotSet =
        "This account has no password: you sign in another way. To add one, sign out and choose “{forgotPassword}” on the sign-in screen. We will email you a code to set it."
    /// The label of the current password's field.
    public var currentPasswordLabel = "Current password"
    /// Under it when it was refused.
    public var currentPasswordWrong = "That is not your current password."
    /// The button that opens, and the one that sends, a password change.
    public var changePassword = "Update password"
    /// Said once the password was changed.
    public var passwordChanged = "Your password was changed. Your other devices were signed out."

    // MARK: Sessions

    /// The sessions' heading.
    public var sessionsTitle = "Where you’re signed in"
    /// Beside the session this app is using.
    public var thisDevice = "This device"
    /// Beside a session that is bound to a device key. A key signed; nobody says whose
    /// hands the device is in.
    public var deviceBound = "Bound to a device key"
    /// `{date}` is when the session signed in.
    public var signedInOn = "Signed in {date}"
    /// `{date}` is when the session was last used.
    public var lastActive = "Last active {date}"
    /// A session of a browser.
    public var clientWeb = "Web browser"
    /// A session of an iOS app.
    public var clientIos = "iPhone or iPad app"
    /// A session of an Android app.
    public var clientAndroid = "Android app"
    /// A session of a server.
    public var clientServer = "Server"
    /// A session of a kind this version does not know.
    public var unknownDevice = "Unknown device"
    /// A row's sign-out button.
    public var signOutDevice = "Sign out"
    /// What that button is read as. `{device}` is the row's title.
    public var signOutDeviceLabel = "Sign out {device}"
    /// Said once a session was ended.
    public var deviceSignedOut = "That device was signed out."
    /// The button that ends every other session.
    public var signOutOthers = "Sign out of all other devices"
    /// `{count}` is how many were ended.
    public var othersSignedOut = "Signed out of {count} other devices."
    /// For exactly one.
    public var othersSignedOutOne = "Signed out of 1 other device."
    /// The button that signs this app out.
    public var signOut = "Sign out"
    /// A sign-out the server could not be told of is not a sign-out.
    public var signOutFailed = "We could not confirm the sign-out, so you may still be signed in on this device. Try again."

    // MARK: Two-step verification

    /// The heading.
    public var mfaTitle = "Two-step verification"
    /// With no authenticator app.
    public var mfaOff = "Off. Add a code from an authenticator app as a second step when you sign in."
    /// `{date}` is when it was turned on.
    public var mfaOn = "On since {date}."
    /// `{count}` backup codes are unused.
    public var codesRemaining = "{count} backup codes left."
    /// For exactly one.
    public var codesRemainingOne = "1 backup code left."
    /// The button that starts setting up an authenticator app.
    public var turnOn = "Turn on"
    /// The button that removes it.
    public var turnOff = "Turn off"
    /// The question before it is removed.
    public var turnOffConfirm = "Turn off two-step verification? Your backup codes will stop working."
    /// Said once it is on.
    public var turnedOn = "Two-step verification is on."
    /// Said once it is off.
    public var turnedOff = "Two-step verification is off."
    /// The button that replaces the backup codes.
    public var regenerate = "New backup codes"
    /// Said once they were replaced.
    public var regenerated = "Your earlier backup codes no longer work."
    /// Where the environment requires a second step.
    public var requiredByApp = "This app requires two-step verification, so it cannot be turned off."
    /// Where a texted code may be the second step.
    public var smsOffer = "You can also get a code by text message as your second step."
    /// The button that starts it.
    public var smsTurnOn = "Use text messages"
    /// `{date}` is when it was turned on.
    public var smsOn = "A code by text message is your second step since {date}."
    /// Where a texted code is enrolled and a stronger factor is in force.
    public var smsNotInUse =
        "It is not asked for while you have an authenticator app or a passkey. If you remove that, the code by text message is your second step again."
    /// Where a texted code is the second step in force.
    public var smsWeaker = "An authenticator app is safer than a text message. You can add one here."
    /// The button that removes it.
    public var smsTurnOff = "Stop using text messages"
    /// The question before it is removed.
    public var smsTurnOffConfirm = "Stop using text messages as your second step?"
    /// Said once it is on.
    public var smsTurnedOn = "A code by text message is now your second step."
    /// Said once it is off.
    public var smsTurnedOff = "Text messages are no longer your second step."

    // MARK: Phone number

    /// The heading.
    public var phoneTitle = "Phone number"
    /// With no number.
    public var phoneNone = "No phone number."
    /// Beside the number: it was proven with a texted code.
    public var phoneVerified = "Verified"
    /// The button that adds one.
    public var phoneAdd = "Add a phone number"
    /// The button that replaces it.
    public var phoneChange = "Change phone number"
    /// The button that removes it.
    public var phoneRemove = "Remove phone number"
    /// The question before it is removed.
    public var phoneRemoveConfirm = "Remove your phone number from this account?"
    /// The label of the number's field.
    public var phoneNumberLabel = "Phone number"
    /// Under it.
    public var phoneNumberHint = "Include the country code, for example +1 415 555 0142."
    /// The button that asks for the code.
    public var phoneSend = "Send code"
    /// `{destination}` is the masked number.
    public var phoneCodeSent = "Enter the 6-digit code we texted to {destination}."
    /// The link back to the number.
    public var phoneDifferent = "Use a different number"
    /// Said once the number was added.
    public var phoneAdded = "Your phone number was added."
    /// Said once it was removed.
    public var phoneRemoved = "Your phone number was removed."

    // MARK: Passkeys

    /// The heading.
    public var passkeysTitle = "Passkeys"
    /// Under it.
    public var passkeysIntro = "A passkey signs you in with your fingerprint, face or screen lock instead of a password."
    /// With none.
    public var passkeysEmpty = "You have no passkeys yet."
    /// The button that makes one.
    public var passkeyAdd = "Add a passkey"
    /// Said once one was made.
    public var passkeyAdded = "Your passkey was added."
    /// Above "Add a passkey" where a texted code is the second step in force.
    public var replacesTextedCode =
        "Once you add a passkey, it replaces the code by text message as your second step. A passkey has no backup codes: if you lose it, only an administrator of this app can let you back in."
    /// While the account's second step is still being read.
    public var addChecking = "Checking your second step before a passkey can be added…"
    /// Where that read failed.
    public var addUnchecked = "Your second step could not be checked, so a passkey cannot be added right now."
    /// Where the app gave the client no passkey sheet.
    public var addUnsupported = "This app cannot create passkeys here. You can still rename or remove the ones you have."
    /// Said quietly when the passkey sheet was closed.
    public var passkeyDismissed = "The passkey request was cancelled. Nothing was changed; you can try again."
    /// A passkey that travels with the user's account of the platform.
    public var passkeySynced = "Synced across your devices"
    /// One that does not.
    public var passkeySingleDevice = "On one device only"
    /// `{date}`.
    public var passkeyCreated = "Added {date}"
    /// `{date}`.
    public var passkeyLastUsed = "Last used {date}"
    /// For one that never signed in.
    public var passkeyNeverUsed = "Not used yet"
    /// A row's rename button.
    public var rename = "Rename"
    /// What it is read as. `{name}` is the passkey's name.
    public var renameLabel = "Rename {name}"
    /// The label of the name's field.
    public var passkeyNameLabel = "Passkey name"
    /// Said once it was renamed.
    public var passkeyRenamed = "The passkey was renamed."
    /// A row's remove button.
    public var remove = "Remove"
    /// What it is read as.
    public var removeLabel = "Remove {name}"
    /// The question before one is removed.
    public var removeConfirm = "Remove “{name}”? You will no longer be able to sign in with it."
    /// The button that removes it.
    public var removeConfirmButton = "Remove passkey"
    /// Said once it was removed.
    public var passkeyRemoved = "The passkey was removed."

    // MARK: Proving again that it is you

    /// The title of the step-up.
    public var stepUpTitle = "Confirm it is you"
    /// With the password.
    public var stepUpPassword = "Enter your password to continue."
    /// Under the password when it was refused.
    public var passwordWrong = "That password is incorrect."
    /// With an authenticator app's code.
    public var stepUpTotp = "Enter the 6-digit code from your authenticator app to continue."
    /// With a backup code.
    public var stepUpBackup = "Enter one of your backup codes to continue. Each code works once."
    /// Before an emailed code was asked for.
    public var stepUpEmailPrompt = "To continue, we will email you a 6-digit code."
    /// The button that asks for it.
    public var stepUpEmailSend = "Email me a code"
    /// `{destination}` is the masked address.
    public var stepUpEmailSent = "Enter the 6-digit code we sent to {destination}."
    /// Before a texted code was asked for.
    public var stepUpSmsPrompt = "To continue, we will text a 6-digit code to the phone number on your account."
    /// The button that asks for it.
    public var stepUpSmsSend = "Text me a code"
    /// `{destination}` is the masked number.
    public var stepUpSmsSent = "Enter the 6-digit code we texted to {destination}."
    /// With a passkey.
    public var stepUpPasskey = "Use your passkey to continue."
    /// Above the form when the server refused what the passkey sheet returned for a
    /// step-up: about the passkey, never about an address and a password.
    public var stepUpPasskeyRefused = "That passkey was not accepted. Try again, or confirm it is you another way."
    /// The button that sends the proof.
    public var stepUpSubmit = "Continue"
    /// The link to the password.
    public var passwordInstead = "Use your password instead"
    /// The link to the emailed code.
    public var emailInstead = "Email me a code instead"
    /// The link to the texted code.
    public var smsInstead = "Text me a code instead"
    /// Where the server names no way this app can take.
    public var stepUpNoMethod = "For your security, sign out and sign in again to continue."
    /// Said once it is proven and what was asked for has to be typed again.
    public var stepUpDone = "Confirmed. Enter it again to continue."

    /// The English words.
    public init() {}
}
