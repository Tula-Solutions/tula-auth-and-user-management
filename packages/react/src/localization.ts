import type { Messages, PasswordRule } from '@tula/core'

/**
 * Every string the components show, for one language. Placeholders are `{name}`.
 *
 * Messages for errors the API reports are not here: they come from `@tula/core`'s table, keyed
 * by error code. Translate those through {@link TulaLocalization.errors}.
 *
 * @example
 * ```tsx
 * const es: LocalizationOverrides = {
 *   locale: 'es',
 *   signIn: { title: 'Inicia sesión', continue: 'Continuar' },
 *   errors: { 'auth.invalid_credentials': 'El correo o la contraseña no son correctos.' },
 * }
 * <TulaProvider publishableKey={key} baseUrl={url} localization={es}>…</TulaProvider>
 * ```
 */
export interface TulaLocalization {
  /** A BCP 47 tag, used to format relative times (`Intl.RelativeTimeFormat`). */
  locale: string
  /** Strings several screens share. */
  common: {
    loading: string
    required: string
    /** `{time}` is a duration from `seconds` or `minutesSeconds`. */
    retryIn: string
    /** `{seconds}`. */
    seconds: string
    /** `{minutes}`, `{seconds}`. */
    minutesSeconds: string
    back: string
    securedBy: string
  }
  /** `<SignIn>`. */
  signIn: {
    title: string
    /** `{appName}`. */
    subtitle: string
    /** Shown until the app's name is known. */
    subtitleNoApp: string
    emailLabel: string
    /** The first field's label where a texted code is among the ways to sign in. */
    identifierLabel: string
    /** Under that field: how to write a phone number. */
    identifierHint: string
    continue: string
    passwordTitle: string
    passwordLabel: string
    submit: string
    forgotPassword: string
    changeEmail: string
    noAccount: string
    signUpLink: string
    signedIn: string
    /** The accessible name of the list of other ways to sign in. */
    otherMethods: string
    usePassword: string
    emailCode: string
    emailLink: string
    emailTitle: string
    /** Before a code was asked for. */
    emailCodePrompt: string
    /** Before a link was asked for. */
    emailLinkPrompt: string
    /** `{destination}` is the masked address. */
    emailCodeSubtitle: string
    /** `{destination}`. */
    emailLinkSubtitle: string
    /** Shown while the page waits for the emailed link to be opened. */
    emailLinkWaiting: string
    /** Says that the code in the same email works from any device. */
    emailLinkCodeHint: string
    emailCodeSubmit: string
    emailResend: string
    /** `{time}`. */
    emailResendIn: string
    emailResent: string
    /** The button that asks for a texted code, and the title before one was asked for. */
    smsCode: string
    /** Before a code was asked for. */
    smsCodePrompt: string
    /** The title once a code was asked for. */
    smsTitle: string
    /**
     * `{destination}` is the masked number (`***42`). It must not say that a message was
     * sent: the server answers the same for a number that signs nobody in, and sends nothing.
     */
    smsCodeSubtitle: string
    smsResend: string
    /** `{time}`. */
    smsResendIn: string
    /** After asking again. Like the subtitle, it promises no message. */
    smsResent: string
    /** A texted code that did not sign in: wrong, expired, or a number that signs nobody in. */
    smsCodeWrong: string
  }
  /** `<SignUp>`. */
  signUp: {
    title: string
    subtitle: string
    firstNameLabel: string
    lastNameLabel: string
    emailLabel: string
    passwordLabel: string
    /** The label where the environment lets a sign-up leave the password out. */
    passwordOptionalLabel: string
    passwordOptionalHint: string
    continue: string
    haveAccount: string
    signInLink: string
  }
  /** `<EmailLinkCallback>`: the page an emailed sign-in link leads to. */
  emailLink: {
    loadingTitle: string
    loadingMessage: string
    verifiedTitle: string
    verifiedMessage: string
    differentBrowserTitle: string
    differentBrowserMessage: string
    expiredTitle: string
    expiredMessage: string
    noneTitle: string
    noneMessage: string
    errorTitle: string
    /** The link back to `<SignIn>`. */
    signIn: string
  }
  /** Signing in with a provider (Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X, Facebook), and the page it returns to. */
  oauth: {
    /** `{provider}` is the provider's name. */
    continueWith: string
    /** Between the provider buttons and the form. */
    divider: string
    loadingTitle: string
    loadingMessage: string
    differentBrowserTitle: string
    differentBrowserMessage: string
    accountExistsTitle: string
    accountExistsMessage: string
    cancelledTitle: string
    refusedTitle: string
    noneTitle: string
    noneMessage: string
    linkedTitle: string
    /** `{provider}`. */
    linkedMessage: string
    errorTitle: string
    /** The button that asks again after a request that got no answer. */
    tryAgain: string
    /** The link back to `<SignIn>`. */
    signIn: string
    /** The link back to the account page after connecting an account. */
    backToAccount: string
  }
  /** Passkeys: the sign-in button, the second-factor and step-up screens, the profile section. */
  passkey: {
    /** The button on `<SignIn>`, and the title of the screen that offers it after an address. */
    signIn: string
    /** Under the title of that screen. */
    signInPrompt: string
    /** Shown quietly when the browser's passkey dialog was dismissed or timed out. */
    cancelled: string
    /** The second-factor screen's text, above its button. */
    secondFactorSubtitle: string
    /** The step-up dialog's text, above its button. */
    stepUpSubtitle: string
    /** The button that opens the browser's passkey dialog for a second factor or a step-up. */
    use: string
    /** The link that switches to the passkey from another method. */
    useInstead: string
    /** Where a passkey is the only method on offer and the browser has no WebAuthn. */
    unsupported: string
    /** The profile section. */
    sectionTitle: string
    intro: string
    loading: string
    empty: string
    add: string
    added: string
    /** In place of "Add a passkey" in a browser without WebAuthn. */
    addUnsupported: string
    /**
     * In place of "Add a passkey" where the environment has passkeys switched off and the user
     * still has some: they can be renamed and removed, not added.
     */
    addUnavailable: string
    /** A passkey its authenticator keeps on more than one device. */
    synced: string
    /** A passkey that lives on one device or security key. */
    deviceBound: string
    /** `{date}`. */
    created: string
    /** `{date}`. */
    lastUsed: string
    neverUsed: string
    rename: string
    /** `{name}`: the accessible name of a row's "Rename". */
    renameLabel: string
    nameLabel: string
    nameRequired: string
    save: string
    cancel: string
    renamed: string
    remove: string
    /** `{name}`: the accessible name of a row's "Remove". */
    removeLabel: string
    /** `{name}`: asked before a passkey is removed. */
    removeConfirm: string
    removeConfirmButton: string
    removed: string
  }
  /** The emailed-code screen of every flow. */
  verification: {
    title: string
    /** `{destination}` is the masked address. */
    subtitle: string
    codeLabel: string
    codeHint: string
    codeIncomplete: string
    submit: string
    resend: string
    /** `{time}`. */
    resendIn: string
    resent: string
    /** `{count}` wrong guesses left before the code is retired. */
    attemptsRemaining: string
    attemptsRemainingOne: string
  }
  /** Forgotten password, inside `<SignIn>`. */
  resetPassword: {
    title: string
    subtitle: string
    emailLabel: string
    sendCode: string
    newPasswordTitle: string
    /** `{destination}`. */
    newPasswordSubtitle: string
    newPasswordLabel: string
    submit: string
    backToSignIn: string
  }
  /** A sign-in stopped because the password is older than the environment allows. */
  expiredPassword: {
    title: string
    subtitle: string
    newPasswordLabel: string
    submit: string
  }
  /** Password fields and the live checklist. */
  password: {
    show: string
    hide: string
    requirements: string
    met: string
    unmet: string
    /** `{passed}`, `{total}`. */
    summary: string
    /** One line per rule; `{min}` and `{max}` come from the policy. */
    rules: Record<PasswordRule, string>
    /** The history rule, which only the server can judge. `{count}`: the policy's number. */
    history: string
    /** The history rule where the policy remembers only the current password. */
    historyCurrent: string
    /** The state of the history rule before the server has answered. */
    checkedOnSave: string
  }
  /** Two-step verification: the second factor at sign-in, enrolment, backup codes. */
  mfa: {
    secondFactorTitle: string
    totpSubtitle: string
    totpLabel: string
    totpHint: string
    codeIncomplete: string
    submit: string
    useBackupCode: string
    useAuthenticator: string
    backupSubtitle: string
    backupLabel: string
    backupHint: string
    backupRequired: string
    enrolTitle: string
    /** Shown when the app requires two-step verification before a sign-in completes. */
    enrolRequired: string
    enrolStart: string
    scanInstruction: string
    /** The accessible name of the QR code. */
    qrLabel: string
    qrLoading: string
    secretLabel: string
    secretHint: string
    confirmSubmit: string
    cancel: string
    backupCodesTitle: string
    backupCodesIntro: string
    /** The accessible name of the list of codes. */
    backupCodesList: string
    copy: string
    copied: string
    copyFailed: string
    download: string
    /** The name of the downloaded text file. */
    downloadFileName: string
    saved: string
    savedRequired: string
    done: string
    sectionTitle: string
    statusLoading: string
    statusOff: string
    /** `{date}`. */
    statusOn: string
    /** `{count}`. */
    codesRemaining: string
    codesRemainingOne: string
    turnOn: string
    turnOff: string
    turnedOn: string
    turnedOff: string
    regenerate: string
    regenerated: string
    /** Shown instead of "Turn off" where the app requires two-step verification. */
    requiredByApp: string
  }
  /** The profile's "Phone number" section (ADR 0037). */
  phone: {
    sectionTitle: string
    none: string
    verified: string
    add: string
    change: string
    /** The accessible name of "Change". */
    changeLabel: string
    remove: string
    /** The accessible name of "Remove". */
    removeLabel: string
    numberLabel: string
    numberHint: string
    send: string
    /** `{digits}` is the last digits of the number the code was texted to. */
    codeSent: string
    verify: string
    differentNumber: string
    cancel: string
    added: string
    removed: string
  }
  /** The dialog that asks a signed-in user to prove who they are before a sensitive change. */
  stepUp: {
    title: string
    passwordSubtitle: string
    passwordLabel: string
    passwordWrong: string
    totpSubtitle: string
    backupSubtitle: string
    /** `{destination}` (masked). Above the code field once the email was sent. */
    emailSubtitle: string
    /** While the email is being sent. */
    emailSending: string
    /** The button that sends the email after a send that failed or was refused for now. */
    emailSend: string
    /** Offered next to the password: switch to a code by email. */
    emailInstead: string
    /** Offered next to the emailed code: switch back to the password. */
    passwordInstead: string
    submit: string
    cancel: string
    /** Shown when the user has nothing to step up with: they must sign in again. */
    noMethod: string
    close: string
  }
  /** A step this version of the components cannot draw. */
  unsupported: {
    title: string
    message: string
    restart: string
  }
  /** The dialog the provider shows when a sign-out did not reach the server. */
  signOutFailed: {
    title: string
    /** Announced as an alert: the session may still be active on this device. */
    message: string
    retry: string
    close: string
  }
  /** `<UserButton>`. */
  userButton: {
    /** `{name}`. The trigger's accessible name. */
    trigger: string
    manageAccount: string
    signOut: string
    close: string
  }
  /** `<UserProfile>`. */
  userProfile: {
    title: string
    profileTitle: string
    emailVerified: string
    emailUnverified: string
    passwordTitle: string
    /**
     * `{forgotPassword}` is the sign-in screen's "Forgot password?" label. Shown instead of the
     * change-password form to a user who has no password (they signed up through a provider or
     * by email).
     */
    passwordNotSet: string
    currentPasswordLabel: string
    currentPasswordWrong: string
    newPasswordLabel: string
    changePassword: string
    passwordChanged: string
    sessionsTitle: string
    sessionsLoading: string
    thisDevice: string
    activeNow: string
    /** `{time}` is a relative time such as "2 days ago". */
    lastActive: string
    /** `{browser}`, `{os}`. */
    deviceOn: string
    unknownDevice: string
    signOutDevice: string
    /** `{device}`. The accessible name of a row's sign-out button. */
    signOutDeviceLabel: string
    deviceSignedOut: string
    signOutOthers: string
    /** `{count}`. */
    othersSignedOut: string
    signOutTitle: string
    signOut: string
    connectedTitle: string
    connectedLoading: string
    connectedEmpty: string
    /** `{provider}`. */
    connect: string
    disconnect: string
    /** `{provider}`. The accessible name of a row's disconnect button. */
    disconnectLabel: string
    /** `{provider}`. */
    disconnected: string
  }
  /**
   * Messages for error codes, replacing `@tula/core`'s English ones. Codes left out stay
   * English. The provider hands this table to the client (`setMessages`).
   */
  errors: Messages
}

/**
 * Part of a {@link TulaLocalization}: any subset of its strings. The rest stay English.
 *
 * @example
 * ```ts
 * const overrides: LocalizationOverrides = { signUp: { title: 'Join Northline' } }
 * ```
 */
export type LocalizationOverrides = DeepPartial<Omit<TulaLocalization, 'errors'>> & {
  /** Messages by error code; see {@link TulaLocalization.errors}. */
  errors?: Messages
}

type DeepPartial<T> = { [Key in keyof T]?: T[Key] extends string ? string : DeepPartial<T[Key]> }

/**
 * The English strings: the default, and the starting point for a translation.
 *
 * @example
 * ```ts
 * EN_LOCALIZATION.signIn.title // 'Sign in'
 * ```
 */
export const EN_LOCALIZATION: TulaLocalization = {
  locale: 'en',
  common: {
    loading: 'Loading…',
    required: 'This field is required.',
    retryIn: 'Try again in {time}.',
    seconds: '{seconds}s',
    minutesSeconds: '{minutes}m {seconds}s',
    back: 'Back',
    securedBy: 'Secured by Tula',
  },
  signIn: {
    title: 'Sign in',
    subtitle: 'to continue to {appName}',
    subtitleNoApp: 'Welcome back',
    emailLabel: 'Email address',
    identifierLabel: 'Email address or phone number',
    identifierHint: 'For a phone number, include the country code, for example +1 415 555 0142.',
    continue: 'Continue',
    passwordTitle: 'Enter your password',
    passwordLabel: 'Password',
    submit: 'Sign in',
    forgotPassword: 'Forgot password?',
    changeEmail: 'Change',
    noAccount: 'New here?',
    signUpLink: 'Create an account',
    signedIn: 'You are signed in.',
    otherMethods: 'Other ways to sign in',
    usePassword: 'Use your password',
    emailCode: 'Email me a code',
    emailLink: 'Email me a link',
    emailTitle: 'Check your email',
    emailCodePrompt: 'We will email you a 6-digit code to sign in with.',
    emailLinkPrompt: 'We will email you a link that signs you in on this device.',
    emailCodeSubtitle: 'Enter the 6-digit code we sent to {destination}.',
    emailLinkSubtitle:
      'We sent a sign-in link to {destination}. Open it in this browser and you will be signed in here.',
    emailLinkWaiting: 'Waiting for you to open the link…',
    emailLinkCodeHint:
      'Reading the email on another device? Enter the 6-digit code from the same email here instead.',
    emailCodeSubmit: 'Sign in',
    emailResend: 'Send a new email',
    emailResendIn: 'Send a new email in {time}',
    emailResent: 'A new email is on its way.',
    smsCode: 'Text me a code',
    smsCodePrompt: 'We will text a 6-digit code to this number, if you can sign in with it.',
    smsTitle: 'Check your phone',
    smsCodeSubtitle:
      'If you can sign in with the number ending in {destination}, we texted it a 6-digit code. Enter it here.',
    smsResend: 'Text a new code',
    smsResendIn: 'Text a new code in {time}',
    smsResent: 'If you can sign in with this number, a new code is on its way.',
    smsCodeWrong:
      'That code did not sign you in. Check it, ask for a new one, or sign in another way.',
  },
  signUp: {
    title: 'Create your account',
    subtitle: 'Welcome! Sign up to get started.',
    firstNameLabel: 'First name',
    lastNameLabel: 'Last name',
    emailLabel: 'Email address',
    passwordLabel: 'Password',
    passwordOptionalLabel: 'Password (optional)',
    passwordOptionalHint: 'Leave it empty to sign in with a code we email you instead.',
    continue: 'Continue',
    haveAccount: 'Already have an account?',
    signInLink: 'Sign in',
  },
  emailLink: {
    loadingTitle: 'Signing you in…',
    loadingMessage: 'Checking your sign-in link.',
    verifiedTitle: 'Continue in your other tab',
    verifiedMessage:
      'Your link was accepted. Go back to the tab where you started signing in: it finishes there. If you closed that tab, sign in again.',
    differentBrowserTitle: 'Open this link where you started',
    differentBrowserMessage:
      'For your security this link only works in the browser where you asked for it. Open it there, or enter the 6-digit code from the same email there. You can also start again on this device.',
    expiredTitle: 'This link has expired',
    expiredMessage: 'A sign-in link works once, for ten minutes. Sign in again to get a new one.',
    noneTitle: 'No sign-in link here',
    noneMessage:
      'This page finishes a sign-in started from an emailed link, and this address does not carry one.',
    errorTitle: 'We could not check your link',
    signIn: 'Sign in',
  },
  oauth: {
    continueWith: 'Continue with {provider}',
    divider: 'or',
    loadingTitle: 'Signing you in…',
    loadingMessage: 'Finishing sign-in.',
    differentBrowserTitle: 'Start again in this browser',
    differentBrowserMessage:
      'This sign-in was started in another browser or tab, so it cannot be finished here. Nothing was changed. Start again on this device.',
    accountExistsTitle: 'You already have an account',
    accountExistsMessage:
      'An account with this email address already exists. Sign in the way you usually do, then connect this provider under “Connected accounts” in your account.',
    cancelledTitle: 'Sign-in was cancelled',
    refusedTitle: 'We could not sign you in',
    noneTitle: 'Nothing to finish here',
    noneMessage:
      'This page finishes a sign-in with a provider such as Google or Microsoft, and this address does not carry one.',
    linkedTitle: 'Account connected',
    linkedMessage: 'Your {provider} account is connected. You can now use it to sign in.',
    errorTitle: 'We could not finish signing you in',
    tryAgain: 'Try again',
    signIn: 'Sign in',
    backToAccount: 'Back to your account',
  },
  passkey: {
    signIn: 'Sign in with a passkey',
    signInPrompt:
      'Use the passkey saved on this device, in your password manager or on a security key.',
    cancelled:
      'The passkey request was cancelled or timed out. Nothing was changed; you can try again.',
    secondFactorSubtitle: 'Use your passkey to finish signing in.',
    stepUpSubtitle: 'Use your passkey to continue.',
    use: 'Use your passkey',
    useInstead: 'Use your passkey instead',
    unsupported: 'This browser cannot use passkeys. Open this page in a browser that can.',
    sectionTitle: 'Passkeys',
    intro:
      'A passkey signs you in with your fingerprint, face or screen lock instead of a password.',
    loading: 'Loading your passkeys…',
    empty: 'You have no passkeys yet.',
    add: 'Add a passkey',
    added: 'Your passkey was added.',
    addUnsupported:
      'This browser cannot create passkeys. You can still rename or remove the ones you have.',
    addUnavailable:
      'New passkeys cannot be added right now. You can still rename or remove the ones you have.',
    synced: 'Synced across your devices',
    deviceBound: 'On this device only',
    created: 'Added {date}',
    lastUsed: 'Last used {date}',
    neverUsed: 'Not used yet',
    rename: 'Rename',
    renameLabel: 'Rename {name}',
    nameLabel: 'Passkey name',
    nameRequired: 'Enter a name.',
    save: 'Save',
    cancel: 'Cancel',
    renamed: 'The passkey was renamed.',
    remove: 'Remove',
    removeLabel: 'Remove {name}',
    removeConfirm: 'Remove “{name}”? You will no longer be able to sign in with it.',
    removeConfirmButton: 'Remove passkey',
    removed: 'The passkey was removed.',
  },
  verification: {
    title: 'Check your email',
    subtitle: 'Enter the 6-digit code we sent to {destination}.',
    codeLabel: 'Verification code',
    codeHint: '6 digits',
    codeIncomplete: 'Enter the 6-digit code.',
    submit: 'Verify',
    resend: 'Resend code',
    resendIn: 'Resend code in {time}',
    resent: 'A new code is on its way.',
    attemptsRemaining: '{count} attempts left.',
    attemptsRemainingOne: '1 attempt left.',
  },
  resetPassword: {
    title: 'Reset your password',
    subtitle: 'Enter your email address and we will send you a code.',
    emailLabel: 'Email address',
    sendCode: 'Send code',
    newPasswordTitle: 'Choose a new password',
    newPasswordSubtitle: 'Enter the 6-digit code we sent to {destination} and a new password.',
    newPasswordLabel: 'New password',
    submit: 'Reset password',
    backToSignIn: 'Back to sign in',
  },
  expiredPassword: {
    title: 'Your password has expired',
    subtitle: 'Choose a new password to finish signing in.',
    newPasswordLabel: 'New password',
    submit: 'Save password and sign in',
  },
  password: {
    show: 'Show password',
    hide: 'Hide password',
    requirements: 'Password requirements',
    met: 'Met',
    unmet: 'Not met',
    summary: '{passed} of {total} password requirements met',
    rules: {
      min_length: '{min} or more characters',
      max_length: 'No more than {max} characters',
      lowercase: 'One lowercase letter',
      uppercase: 'One uppercase letter',
      number: 'One number',
      special: 'One special character',
      character_classes: 'A mix of {min} kinds: lowercase, uppercase, numbers, symbols',
      user_info: 'Does not contain your name or email',
      common: 'Not a commonly used password',
      repeated_characters: 'No more than {max} repeated characters in a row',
      sequence: 'No sequences like "abcd" or "1234"',
    },
    history: 'Not one of your last {count} passwords',
    historyCurrent: 'Not your current password',
    checkedOnSave: 'Checked when you save',
  },
  mfa: {
    secondFactorTitle: 'Two-step verification',
    totpSubtitle: 'Enter the 6-digit code from your authenticator app.',
    totpLabel: 'Authentication code',
    totpHint: '6 digits',
    codeIncomplete: 'Enter the 6-digit code.',
    submit: 'Verify',
    useBackupCode: 'Use a backup code',
    useAuthenticator: 'Use your authenticator app',
    backupSubtitle: 'Enter one of your backup codes. Each code works once.',
    backupLabel: 'Backup code',
    backupHint: '10 characters, for example abcde-fghjk',
    backupRequired: 'Enter a backup code.',
    enrolTitle: 'Set up two-step verification',
    enrolRequired:
      'This app requires two-step verification. Set up an authenticator app to finish signing in.',
    enrolStart: 'Set up authenticator app',
    scanInstruction:
      'Scan this QR code with your authenticator app, or enter the setup key by hand. Then enter the 6-digit code the app shows.',
    qrLabel: 'QR code for your authenticator app. If you cannot scan it, use the setup key.',
    qrLoading: 'Preparing the QR code…',
    secretLabel: 'Setup key',
    secretHint: 'Keep this key private. It is shown only now.',
    confirmSubmit: 'Turn on',
    cancel: 'Cancel',
    backupCodesTitle: 'Save your backup codes',
    backupCodesIntro:
      'Each code signs you in once if you cannot use your authenticator app. Keep them somewhere safe: they will not be shown again.',
    backupCodesList: 'Backup codes',
    copy: 'Copy',
    copied: 'Copied.',
    copyFailed: 'Could not copy. Select the codes and copy them by hand.',
    download: 'Download',
    downloadFileName: 'backup-codes.txt',
    saved: 'I have saved these codes',
    savedRequired: 'Confirm that you have saved the codes.',
    done: 'Done',
    sectionTitle: 'Two-step verification',
    statusLoading: 'Checking two-step verification…',
    statusOff: 'Off. Add a code from an authenticator app as a second step when you sign in.',
    statusOn: 'On since {date}.',
    codesRemaining: '{count} backup codes left.',
    codesRemainingOne: '1 backup code left.',
    turnOn: 'Turn on',
    turnOff: 'Turn off',
    turnedOn: 'Two-step verification is on.',
    turnedOff: 'Two-step verification is off.',
    regenerate: 'New backup codes',
    regenerated: 'Your earlier backup codes no longer work.',
    requiredByApp: 'This app requires two-step verification, so it cannot be turned off.',
  },
  phone: {
    sectionTitle: 'Phone number',
    none: 'No phone number.',
    verified: 'Verified',
    add: 'Add a phone number',
    change: 'Change',
    changeLabel: 'Change phone number',
    remove: 'Remove',
    removeLabel: 'Remove phone number',
    numberLabel: 'Phone number',
    numberHint: 'Include the country code, for example +1 415 555 0142.',
    send: 'Send code',
    codeSent: 'We sent a 6-digit code by text message to the number ending in {digits}.',
    verify: 'Verify',
    differentNumber: 'Use a different number',
    cancel: 'Cancel',
    added: 'Your phone number was added.',
    removed: 'Your phone number was removed.',
  },
  stepUp: {
    title: 'Confirm it is you',
    passwordSubtitle: 'Enter your password to continue.',
    passwordLabel: 'Password',
    passwordWrong: 'That password is incorrect.',
    totpSubtitle: 'Enter the 6-digit code from your authenticator app to continue.',
    backupSubtitle: 'Enter one of your backup codes to continue. Each code works once.',
    emailSubtitle: 'Enter the 6-digit code we sent to {destination}.',
    emailSending: 'Sending you a code…',
    emailSend: 'Send code',
    emailInstead: 'Email me a code instead',
    passwordInstead: 'Use your password instead',
    submit: 'Continue',
    cancel: 'Cancel',
    noMethod: 'For your security, sign out and sign in again to continue.',
    close: 'Close',
  },
  unsupported: {
    title: 'This step is not supported',
    message:
      'This sign-in step is not supported by this version of the app. Update the app, or start again and choose another way to sign in.',
    restart: 'Start again',
  },
  signOutFailed: {
    title: 'Sign-out did not finish',
    message:
      'We could not confirm the sign-out, so you may still be signed in on this device. Try again.',
    retry: 'Try again',
    close: 'Close',
  },
  userButton: {
    trigger: 'Account menu for {name}',
    manageAccount: 'Manage account',
    signOut: 'Sign out',
    close: 'Close',
  },
  userProfile: {
    title: 'Account',
    profileTitle: 'Profile',
    emailVerified: 'Verified',
    emailUnverified: 'Not verified',
    passwordTitle: 'Password',
    passwordNotSet:
      'This account has no password: you sign in another way. To add one, sign out and choose “{forgotPassword}” on the sign-in screen. We will email you a code to set it.',
    currentPasswordLabel: 'Current password',
    currentPasswordWrong: 'That is not your current password.',
    newPasswordLabel: 'New password',
    changePassword: 'Update password',
    passwordChanged: 'Your password was changed. Your other devices were signed out.',
    sessionsTitle: 'Where you’re signed in',
    sessionsLoading: 'Loading your devices…',
    thisDevice: 'This device',
    activeNow: 'Active now',
    lastActive: 'Last active {time}',
    deviceOn: '{browser} on {os}',
    unknownDevice: 'Unknown device',
    signOutDevice: 'Sign out',
    signOutDeviceLabel: 'Sign out {device}',
    deviceSignedOut: 'That device was signed out.',
    signOutOthers: 'Sign out of all other devices',
    othersSignedOut: 'Signed out of {count} other devices.',
    signOutTitle: 'Sign out',
    signOut: 'Sign out',
    connectedTitle: 'Connected accounts',
    connectedLoading: 'Loading your connected accounts…',
    connectedEmpty: 'No accounts are connected.',
    connect: 'Connect {provider}',
    disconnect: 'Disconnect',
    disconnectLabel: 'Disconnect {provider}',
    disconnected: '{provider} was disconnected.',
  },
  errors: {},
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeInto<T extends Record<string, unknown>>(base: T, overrides: unknown): T {
  if (!isPlainObject(overrides)) {
    return base
  }
  const merged: Record<string, unknown> = { ...base }
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(overrides, key)) {
      continue
    }
    const current = base[key]
    const next = overrides[key]
    if (isPlainObject(current)) {
      merged[key] = mergeInto(current, next)
    } else if (typeof next === 'string') {
      merged[key] = next
    }
  }
  return merged as T
}

/**
 * Lay overrides over the English strings. Only known keys with string values are taken, so a
 * table from an untyped source (a JSON file) cannot put anything but text on the page.
 *
 * @param overrides - Any subset of the strings.
 * @returns The complete table.
 *
 * @example
 * ```ts
 * resolveLocalization({ signIn: { title: 'Log in' } }).signIn.title // 'Log in'
 * ```
 */
export function resolveLocalization(overrides?: LocalizationOverrides): TulaLocalization {
  if (!overrides) {
    return EN_LOCALIZATION
  }
  const { errors: _errors, ...text } = EN_LOCALIZATION
  const merged = mergeInto(text as Record<string, unknown>, overrides) as Omit<
    TulaLocalization,
    'errors'
  >
  // Error messages are keyed by code, not by a fixed set of keys: core validates them itself.
  return {
    ...merged,
    errors: isPlainObject(overrides.errors) ? (overrides.errors as Messages) : {},
  }
}

/**
 * Fill a string's `{name}` placeholders. A placeholder with no value is left as it is.
 *
 * @param template - The string.
 * @param values - Values by placeholder name.
 * @returns The filled string.
 *
 * @example
 * ```ts
 * formatText('to continue to {appName}', { appName: 'Northline' }) // 'to continue to Northline'
 * ```
 */
export function formatText(
  template: string,
  values: Record<string, string | number | boolean>
): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder
  )
}
