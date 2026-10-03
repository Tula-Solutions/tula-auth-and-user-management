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
  }
  /** A step this version of the components cannot draw. */
  unsupported: {
    title: string
    message: string
    restart: string
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
  },
  unsupported: {
    title: 'This step is not supported',
    message:
      'This sign-in step is not supported by this version of the app. Update the app, or start again and choose another way to sign in.',
    restart: 'Start again',
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
