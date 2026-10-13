package dev.tula.auth.ui

// The strings of the screens that came after the first ones (TULA-61, ADR 0062): the ways to
// sign in that are not typed, a texted code, the second step, an authenticator app set up
// inside a sign-in, and the account screen. Three tables nested in `TulaStrings`; a
// translation sets them as it sets the rest.

/**
 * The first screen's other ways to sign in (a passkey, a provider, a texted code).
 *
 * **A texted sign-in code's screens never say that a message was sent**: a number that signs
 * nobody in is answered like one that does and is texted nothing (ADR 0037), so the words are
 * "if this number can sign in".
 */
data class TulaWayStrings(
    /** The first field's label where a phone number signs in too. */
    val identifierLabel: String = "Email address or phone number",
    /** Under that field. */
    val identifierHint: String = "For a phone number, include the country code, for example +1 415 555 0142.",
    /** Between the form and the buttons under it. */
    val divider: String = "or",
    /** The passkey button. */
    val passkey: String = "Sign in with a passkey",
    /** A provider's button. `{provider}` is the provider's name from [providers]. */
    val continueWith: String = "Continue with {provider}",
    /** The providers' names by their word in the API. One without a name here is not drawn. */
    val providers: Map<String, String> = mapOf(
        "google" to "Google", "github" to "GitHub", "apple" to "Apple", "microsoft" to "Microsoft",
        "discord" to "Discord", "linkedin" to "LinkedIn", "x" to "X", "facebook" to "Facebook",
    ),
    /** A passkey sheet that was closed: a notice, never an error. */
    val passkeyDismissed: String = "The passkey request was cancelled. Nothing was changed; you can try again.",
    /** A passkey the server did not take. */
    val passkeyRefused: String = "That passkey did not sign you in. Try again, or sign in another way.",
    /** A provider's sheet or page that was closed: a notice, never an error. */
    val providerCancelled: String = "Sign-in was cancelled. Nothing was changed; you can try again.",
    /** A provider sign-in the server did not take. */
    val providerRefused: String = "We could not sign you in. Nothing was changed; start again.",
    /** A sheet that could not be shown. */
    val providerFailed: String = "The sign-in could not be shown. Try again.",
    /** Sends the last step of a provider sign-in again, without another trip to the provider. */
    val providerRetry: String = "Try again",
    /** Another sheet of the app is still out (`flow.busy`): a notice. */
    val sheetBusy: String = "Another sign-in window is still open. Finish or close it first.",
    /** The first screen where no way to sign in is one this app can take here. */
    val noWayHere: String =
        "The ways to sign in here are ones this version of the app cannot use on this device. Update the app.",
    /** The button that asks for a texted sign-in code. */
    val smsCode: String = "Text me a code",
    /** Under the title, before the code was asked for. */
    val smsPrompt: String = "We will text a 6-digit code to this number, if you can sign in with it.",
    /** The title of the texted sign-in code's screens. */
    val smsTitle: String = "Check your phone",
    /** `{destination}` is the masked number. Never "we sent". */
    val smsSubtitle: String = "If this number can sign in, a 6-digit code is on its way to {destination}. Enter it below.",
    /** At the first field: what was typed is no number in the international form. */
    val numberForm: String = "Enter a phone number with its country code, starting with +.",
    /** The link that asks for another texted sign-in code. */
    val smsResend: String = "Text a new code",
    /** Said once another was asked for. Never "sent". */
    val smsResent: String = "If you can sign in with this number, a new code is on its way.",
    /** A texted sign-in code the server did not take, at the code field. */
    val smsCodeWrong: String = "That code did not sign you in. Check it, ask for a new one, or sign in another way.",
)

/** The second step of a sign-in, and an authenticator app set up inside one. */
data class TulaSecondStepStrings(
    /** The title of the second step. */
    val title: String = "Two-step verification",
    /** Under it, for an authenticator's code. */
    val totpSubtitle: String = "Enter the 6-digit code from your authenticator app.",
    /** The label of an authenticator's code field. */
    val totpLabel: String = "Authentication code",
    /** A wrong code, at its field. */
    val codeWrong: String = "That code is incorrect.",
    /** The link to the backup code. */
    val useBackupCode: String = "Use a backup code",
    /** The link to the authenticator's code. */
    val useAuthenticator: String = "Use your authenticator app",
    /** Under the title, for a backup code. */
    val backupSubtitle: String = "Enter one of your backup codes. Each code works once.",
    /** The label of the backup code's field. */
    val backupLabel: String = "Backup code",
    /** Under that field. */
    val backupHint: String = "10 characters, for example abcde-fghjk",
    /** Under that field when it is empty. */
    val backupRequired: String = "Enter a backup code.",
    /** Under the title, where a passkey is the open way: also where it is the only one. */
    val passkeySubtitle: String = "Use your passkey to finish signing in.",
    /** The button that shows the passkey sheet. */
    val usePasskey: String = "Use your passkey",
    /** The link to the passkey. */
    val usePasskeyInstead: String = "Use your passkey instead",
    /** Under the title, before a texted code was asked for. */
    val smsSubtitle: String = "We will text a 6-digit code to the phone number on your account.",
    /** The button that asks for it. */
    val smsSend: String = "Text me a code",
    /** The link to the texted code. */
    val smsInstead: String = "Get a code by text message",
    /** `{destination}` is the masked number of the account. */
    val smsSent: String = "Enter the 6-digit code we texted to {destination}.",
    /** The link that asks for another. */
    val smsResend: String = "Text a new code",
    /** Said once another was asked for. */
    val smsResent: String = "A new code is on its way.",
    /** The button that sends a second step's code. */
    val submit: String = "Verify",
    /** The title of the enrolment's screens. */
    val enrolTitle: String = "Set up two-step verification",
    /** Under it, before the setup key was asked for. */
    val enrolRequired: String =
        "This app requires two-step verification. Set up an authenticator app to finish signing in.",
    /** The button that asks for the setup key. */
    val enrolStart: String = "Set up authenticator app",
    /** Above the QR code. */
    val scanInstruction: String =
        "Scan this QR code with your authenticator app, or enter the setup key by hand. " +
            "Then enter the 6-digit code the app shows.",
    /** What the QR code is read as. */
    val qrLabel: String = "QR code for your authenticator app. If you cannot scan it, use the setup key.",
    /** The label of the setup key. */
    val secretLabel: String = "Setup key",
    /** Under the setup key. */
    val secretHint: String = "Keep this key private. It is shown only now.",
    /** Copies the setup key. */
    val copyKey: String = "Copy setup key",
    /** The button that confirms the enrolment. */
    val confirmSubmit: String = "Turn on",
    /** The title of the backup codes' screen. */
    val backupCodesTitle: String = "Save your backup codes",
    /** Under it. */
    val backupCodesIntro: String =
        "Each code signs you in once if you cannot use your authenticator app. " +
            "Keep them somewhere safe: they will not be shown again.",
    /** What the list of codes is read as. */
    val backupCodesList: String = "Backup codes",
    /** Copies the backup codes. */
    val copy: String = "Copy",
    /** Said once something was copied. */
    val copied: String = "Copied.",
    /** The button that leaves the backup codes' screen. */
    val saved: String = "I have saved these codes",
)

/** The account screen. */
data class TulaAccountStrings(
    /** The screen's title. */
    val title: String = "Account",
    /** In a section whose read failed. */
    val sectionFailed: String = "This could not be loaded.",
    /** Reads it again. */
    val reload: String = "Try again",
    /** Leaves a form. */
    val cancel: String = "Cancel",
    /** Said when a form or a step-up was left. */
    val nothingChanged: String = "Nothing was changed.",
    /** The profile section's title. */
    val profileTitle: String = "Profile",
    /** Beside a proven address. */
    val emailVerified: String = "Verified",
    /** Beside an address that was not proven. */
    val emailUnverified: String = "Not verified",
    /** An account with no address. */
    val noEmail: String = "No email address.",
    /** The password section's title. */
    val passwordTitle: String = "Password",
    /** An account with no password. `{forgotPassword}` is the sign-in screen's link. */
    val passwordNotSet: String =
        "This account has no password: you sign in another way. To add one, sign out and choose " +
            "“{forgotPassword}” on the sign-in screen. We will email you a code to set it.",
    /** The label of the current password's field. */
    val currentPasswordLabel: String = "Current password",
    /** A wrong current password, at its field. */
    val currentPasswordWrong: String = "That is not your current password.",
    /** The button that opens, and that sends, the password change. */
    val changePassword: String = "Update password",
    /** Said once it was changed. */
    val passwordChanged: String = "Your password was changed. Your other devices were signed out.",
    /** The sessions section's title. */
    val sessionsTitle: String = "Where you’re signed in",
    /** Marks the session this app holds. */
    val thisDevice: String = "This device",
    /** Marks a session bound to a device key. Never more than that of a device (ADR 0043). */
    val deviceBound: String = "Bound to a device key",
    /** `{date}` is when the session was signed in. */
    val signedInOn: String = "Signed in {date}",
    /** `{date}` is when it was last used. */
    val lastActive: String = "Last active {date}",
    /** A `web` session. */
    val clientWeb: String = "Web browser",
    /** An `ios` session. */
    val clientIos: String = "iPhone or iPad app",
    /** An `android` session. */
    val clientAndroid: String = "Android app",
    /** A `server` session. */
    val clientServer: String = "Server",
    /** A session of a kind this version does not know. */
    val unknownDevice: String = "Unknown device",
    /** The button beside another session. */
    val signOutDevice: String = "Sign out",
    /** What that button is read as. `{device}` is the session's kind. */
    val signOutDeviceLabel: String = "Sign out {device}",
    /** Said once one was ended. */
    val deviceSignedOut: String = "That device was signed out.",
    /** Ends every other session. */
    val signOutOthers: String = "Sign out of all other devices",
    /** `{count}` is how many were ended. */
    val othersSignedOut: String = "Signed out of {count} other devices.",
    /** Exactly one was ended. */
    val othersSignedOutOne: String = "Signed out of 1 other device.",
    /** The button that signs this app out. */
    val signOut: String = "Sign out",
    /** A sign-out the server could not be told of: it is not a sign-out. */
    val signOutFailed: String =
        "We could not confirm the sign-out, so you may still be signed in on this device. Try again.",
    /** The second step's section title. */
    val mfaTitle: String = "Two-step verification",
    /** No authenticator app. */
    val mfaOff: String = "Off. Add a code from an authenticator app as a second step when you sign in.",
    /** `{date}` is when the authenticator was confirmed. */
    val mfaOn: String = "On since {date}.",
    /** `{count}` backup codes are left. */
    val codesRemaining: String = "{count} backup codes left.",
    /** Exactly one is left. */
    val codesRemainingOne: String = "1 backup code left.",
    /** Starts the authenticator's setup. */
    val turnOn: String = "Turn on",
    /** Asks before it is turned off. */
    val turnOff: String = "Turn off",
    /** The question. */
    val turnOffConfirm: String = "Turn off two-step verification? Your backup codes will stop working.",
    /** Said once it is on. */
    val turnedOn: String = "Two-step verification is on.",
    /** Said once it is off. */
    val turnedOff: String = "Two-step verification is off.",
    /** Makes new backup codes. */
    val regenerate: String = "New backup codes",
    /** Above the new codes. */
    val regenerated: String = "Your earlier backup codes no longer work.",
    /** Where the environment requires a second step. */
    val requiredByApp: String = "This app requires two-step verification, so it cannot be turned off.",
    /** Where a texted code may be the second step. */
    val smsOffer: String = "You can also get a code by text message as your second step.",
    /** Starts it. */
    val smsTurnOn: String = "Use text messages",
    /** `{date}` is when it was switched on. */
    val smsOn: String = "A code by text message is your second step since {date}.",
    /** A texted code that is dormant beside a stronger factor. */
    val smsNotInUse: String =
        "It is not asked for while you have an authenticator app or a passkey. If you remove that, " +
            "the code by text message is your second step again.",
    /** Beside a texted code that is in use. */
    val smsWeaker: String = "An authenticator app is safer than a text message. You can add one here.",
    /** Asks before it is switched off. */
    val smsTurnOff: String = "Stop using text messages",
    /** The question. */
    val smsTurnOffConfirm: String = "Stop using text messages as your second step?",
    /** Said once it is on. */
    val smsTurnedOn: String = "A code by text message is now your second step.",
    /** Said once it is off. */
    val smsTurnedOff: String = "Text messages are no longer your second step.",
    /** `{destination}` is the masked number of the account. */
    val smsFactorSent: String = "Enter the 6-digit code we texted to {destination}.",
    /** The phone section's title. */
    val phoneTitle: String = "Phone number",
    /** An account with no number. */
    val phoneNone: String = "No phone number.",
    /** Beside the account's number. */
    val phoneVerified: String = "Verified",
    /** Opens the form for a number. */
    val phoneAdd: String = "Add a phone number",
    /** Opens it where the account has one. */
    val phoneChange: String = "Change phone number",
    /** Asks before the number is removed. */
    val phoneRemove: String = "Remove phone number",
    /** The question. */
    val phoneRemoveConfirm: String = "Remove your phone number from this account?",
    /** The label of the number's field. */
    val phoneNumberLabel: String = "Phone number",
    /** Under that field. */
    val phoneNumberHint: String = "Include the country code, for example +1 415 555 0142.",
    /** The button that texts the code. */
    val phoneSend: String = "Send code",
    /** `{destination}` is the masked number. */
    val phoneCodeSent: String = "Enter the 6-digit code we texted to {destination}.",
    /** Back to the number's form. */
    val phoneDifferent: String = "Use a different number",
    /** Said once the number is the account's. */
    val phoneAdded: String = "Your phone number was added.",
    /** Said once it is gone. */
    val phoneRemoved: String = "Your phone number was removed.",
    /** Where this environment sends no text messages. */
    val phoneUnavailable: String = "Phone numbers cannot be added here.",
    /** The passkeys section's title. */
    val passkeysTitle: String = "Passkeys",
    /** Under it. */
    val passkeysIntro: String =
        "A passkey signs you in with your fingerprint, face or screen lock instead of a password.",
    /** No passkey. */
    val passkeysEmpty: String = "You have no passkeys yet.",
    /** Shows the sheet that creates one. */
    val passkeyAdd: String = "Add a passkey",
    /** Said once one was added. */
    val passkeyAdded: String = "Your passkey was added.",
    /** Before a passkey that takes the second step over from a texted code. */
    val replacesTextedCode: String =
        "Once you add a passkey, it replaces the code by text message as your second step. A passkey has " +
            "no backup codes: if you lose it, only an administrator of this app can let you back in.",
    /** While the factors are being read. */
    val addChecking: String = "Checking your second step before a passkey can be added…",
    /** The factors could not be read. */
    val addUnchecked: String = "Your second step could not be checked, so a passkey cannot be added right now.",
    /** The app gave the client no passkey sheet. */
    val addUnsupported: String = "This app cannot create passkeys here. You can still remove the ones you have.",
    /** A passkey cannot be renamed in this version (the client has no call for it). */
    val renameUnavailable: String = "Passkeys cannot be renamed in this version of the app.",
    /** A passkey sheet that was closed: a notice. */
    val passkeyDismissed: String = "The passkey request was cancelled. Nothing was changed; you can try again.",
    /** Another sheet of the app is still out: a notice. */
    val sheetBusy: String = "Another window of this app is still open. Finish or close it first.",
    /** A passkey the password manager keeps on several devices. */
    val passkeySynced: String = "Synced across your devices",
    /** A passkey of one device. */
    val passkeySingleDevice: String = "On one device only",
    /** `{date}` is when it was added. */
    val passkeyCreated: String = "Added {date}",
    /** `{date}` is when it was last used. */
    val passkeyLastUsed: String = "Last used {date}",
    /** It was never used. */
    val passkeyNeverUsed: String = "Not used yet",
    /** The button beside a passkey. */
    val remove: String = "Remove",
    /** What that button is read as. `{name}` is the passkey's name. */
    val removeLabel: String = "Remove {name}",
    /** The question. `{name}` is the passkey's name. */
    val removeConfirm: String = "Remove “{name}”? You will no longer be able to sign in with it.",
    /** The button that removes it. */
    val removeConfirmButton: String = "Remove passkey",
    /** Said once it is gone. */
    val passkeyRemoved: String = "The passkey was removed.",
    /** The step-up's title. */
    val stepUpTitle: String = "Confirm it is you",
    /** Under it, for the password. */
    val stepUpPassword: String = "Enter your password to continue.",
    /** A wrong password, at its field. */
    val passwordWrong: String = "That password is incorrect.",
    /** For an authenticator's code. */
    val stepUpTotp: String = "Enter the 6-digit code from your authenticator app to continue.",
    /** For a backup code. */
    val stepUpBackup: String = "Enter one of your backup codes to continue. Each code works once.",
    /** Before an emailed code was asked for. */
    val stepUpEmailPrompt: String = "To continue, we will email you a 6-digit code.",
    /** Asks for it. */
    val stepUpEmailSend: String = "Email me a code",
    /** `{destination}` is the masked address. */
    val stepUpEmailSent: String = "Enter the 6-digit code we sent to {destination}.",
    /** Before a texted code was asked for. */
    val stepUpSmsPrompt: String = "To continue, we will text a 6-digit code to the phone number on your account.",
    /** Asks for it. */
    val stepUpSmsSend: String = "Text me a code",
    /** `{destination}` is the masked number. */
    val stepUpSmsSent: String = "Enter the 6-digit code we texted to {destination}.",
    /** For a passkey. */
    val stepUpPasskey: String = "Use your passkey to continue.",
    /** A passkey the server did not take. */
    val stepUpPasskeyRefused: String = "That passkey was not accepted. Try again, or confirm it is you another way.",
    /** The button that sends the proof. */
    val stepUpSubmit: String = "Continue",
    /** The link to the password. */
    val passwordInstead: String = "Use your password instead",
    /** The link to an emailed code. */
    val emailInstead: String = "Email me a code instead",
    /** The link to a texted code. */
    val smsInstead: String = "Text me a code instead",
    /** No way this app can take: the way out. */
    val stepUpNoMethod: String = "For your security, sign out and sign in again to continue.",
    /** After a step-up whose form lost what was typed. */
    val stepUpDone: String = "Confirmed. Enter it again to continue.",
)
