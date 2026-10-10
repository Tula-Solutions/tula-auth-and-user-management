import { z } from 'zod'
import {
  type EmailTemplateKind,
  hasHiddenCharacter,
  readStoredEmailTemplates,
} from './email-template'
import { EmailSettingsSchema } from './email-template-schema'
import { PASSWORD_POLICY_PRESETS, PasswordPolicySchema } from './password-policy'
import {
  DEFAULT_SMS_DAILY_MESSAGE_LIMIT,
  isSmsCountry,
  MAX_SMS_DAILY_MESSAGE_LIMIT,
  SMS_COUNTRIES,
} from './phone'
import { isRedirectUrl } from './redirect-url'
import { SessionSettingsSchema, StoredSessionSettingsSchema } from './session-profile'
import { readStoredSmsTemplates, type SmsTemplateKind } from './sms-template'
import { SmsTemplatesSchema } from './sms-template-schema'

/** App name used until an environment sets its own. Emails and prebuilt screens show it. */
export const DEFAULT_APP_NAME = 'Tula'

/** Longest app name, in characters. It is put in email subjects, so it stays short. */
export const MAX_APP_NAME_LENGTH = 64

/** Most web origins one environment may allow. */
export const MAX_ALLOWED_ORIGINS = 50

/** Most redirect URLs one environment may allow. */
export const MAX_ALLOWED_REDIRECT_URLS = 100

/**
 * Shortest `password.minLength` the settings API accepts (NIST SP 800-63B's minimum for a
 * user-chosen password). Every built-in preset is at or above it.
 */
export const MIN_PASSWORD_MIN_LENGTH = 8

/** Longest audit retention that can be set, in days (ten years). */
export const MAX_AUDIT_RETENTION_DAYS = 3650

// Control characters and line or paragraph separators. The name is written into email headers
// and HTML, so anything that could start a new header line is refused at the door.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]{2,45}\\])`
const PORT = '(?::([1-9][0-9]{0,4}))?'
const HTTPS_ORIGIN = new RegExp(`^https://${HOST}${PORT}$`)
const LOOPBACK_ORIGIN = new RegExp(`^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])${PORT}$`)

function isWebOrigin(value: string): boolean {
  const matched = HTTPS_ORIGIN.exec(value) ?? LOOPBACK_ORIGIN.exec(value)
  if (!matched) {
    return false
  }
  const port = matched[1] === undefined ? null : Number(matched[1])
  // Browsers leave the default port out of `Origin`, so an entry that spells it out could
  // never match a request.
  const defaultPort = value.startsWith('https://') ? 443 : 80
  return port === null || (port <= 65_535 && port !== defaultPort)
}

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/**
 * A web origin exactly as a browser sends it in `Origin`: scheme, lowercase host and an optional
 * non-default port. No path, no trailing slash and no wildcard, because origins are compared by
 * exact match. `http://` is accepted for `localhost`, `127.0.0.1` and `[::1]` only.
 */
export const WebOriginSchema = z
  .string()
  .max(255)
  .refine(isWebOrigin, {
    message:
      'must be an origin such as https://app.example.com (lowercase, no path, no wildcard; http only for localhost)',
  })
  .meta({ ref: 'WebOrigin' })

/**
 * A URL a flow may send the user back to ({@link redirectUrlKind}, ADR 0044): an absolute
 * `https://` URL (a web page or an app link), `http://` for `localhost`, `127.0.0.1` and
 * `[::1]`, or a custom scheme in reverse-domain form (`com.example.app:/oauth`). No
 * credentials, no fragment and no wildcard in any of them; a custom-scheme URL has no query
 * either. Compared exactly as written: nothing is normalised.
 */
export const RedirectUrlSchema = z
  .string()
  .max(2048)
  .refine(isRedirectUrl, {
    message:
      'must be an absolute https URL (http only for localhost) with no credentials, fragment or wildcard, or a custom scheme with a full stop such as com.example.app:/oauth (no query, no fragment)',
  })
  .meta({ ref: 'RedirectUrl' })

const App = z.object({
  /**
   * What the product is called. Every email names it in the subject and the body, and
   * `/v1/client/config` returns it. Defaults to {@link DEFAULT_APP_NAME}.
   */
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_APP_NAME_LENGTH)
    .refine((name) => !UNPRINTABLE.test(name), {
      message: 'must not contain control characters or line breaks',
    })
    .default(DEFAULT_APP_NAME),
  /** Where users can ask for help. Shown in emails and returned by `/v1/client/config`. */
  supportEmail: z.email().max(254).nullable().default(null),
})

// The name as it may be **set**: also without the characters no email template may hold
// (a text-direction control, a private-use or unassigned code point, half a surrogate
// pair), because the name is put into every subject and body (ADR 0039). On input only: a
// name saved before the rule is still read and still answered, and `displayName` cleans
// what it always cleaned. Joiners and variation selectors are allowed, and a name may be a
// domain name: the link rule of templates is not applied to it.
const AppInput = App.strict().refine((app) => !hasHiddenCharacter(app.name), {
  path: ['name'],
  message:
    'must not contain text-direction controls, private-use or unassigned characters, or half a surrogate pair',
})

const PasswordMethod = z.object({ enabled: z.boolean().default(true) })
// Methods added after the password are off until an environment switches them on, so a
// document saved before they existed keeps behaving as it did.
const OptionalMethod = z.object({ enabled: z.boolean().default(false) })

/**
 * The sign-in methods no account can be created with, so that none of them may be an
 * environment's only way in: `smsCode`. A phone number is added to an account that exists
 * (ADR 0037); there is no sign-up by phone number.
 */
export const SIGN_IN_METHODS_WITHOUT_SIGN_UP: readonly string[] = ['smsCode']

/**
 * What a settings document is refused with when it would leave an environment with no way to
 * sign in. The rule is the server's, not this schema's: an environment whose only method is an
 * OAuth provider (ADR 0026) switches every method below off, and whether a provider is enabled
 * is not part of this document.
 */
export const AT_LEAST_ONE_SIGN_IN_METHOD = 'at least one sign-in method must stay enabled'

/**
 * Whether a settings document enables at least one of its own sign-in methods that an account
 * can be made with (the password, the email code, the email link, a passkey). OAuth providers
 * are configured apart from it.
 *
 * **The SMS code does not count** ({@link SIGN_IN_METHODS_WITHOUT_SIGN_UP}): nobody signs up
 * with a phone number, so an environment whose only method is `smsCode` would let nobody in
 * who is not in already (ADR 0037).
 *
 * @param settings - The document, or just its `signIn` section.
 * @returns `true` when any such method is enabled.
 *
 * @example
 * ```ts
 * hasEnabledSignInMethod(DEFAULT_ENVIRONMENT_SETTINGS) // true: the password
 * ```
 */
export function hasEnabledSignInMethod(settings: {
  signIn: { methods: Record<string, { enabled: boolean }> }
}): boolean {
  return Object.entries(settings.signIn.methods).some(
    ([name, method]) => method.enabled && !SIGN_IN_METHODS_WITHOUT_SIGN_UP.includes(name)
  )
}

// An emailed link works only in the browser that asked for it, and the email always carries a
// code as the way in from any other device: a link without the code would strand those users.
const linkNeedsCode = {
  message: 'emailLink needs emailCode to be enabled as well',
  path: ['emailLink', 'enabled'],
}

function linkHasCode(methods: {
  emailCode: { enabled: boolean }
  emailLink: { enabled: boolean }
}): boolean {
  return !methods.emailLink.enabled || methods.emailCode.enabled
}

/** Whether a sign-up must choose a password. */
export const SignUpPasswordModeSchema = z
  .enum(['required', 'optional'])
  .meta({ ref: 'SignUpPasswordMode' })

/** Whether a sign-up must choose a password. */
export type SignUpPasswordMode = z.infer<typeof SignUpPasswordModeSchema>

const SignUp = z.object({
  /**
   * `required` (the default): a sign-up chooses a password. `optional`: a sign-up may leave it
   * out; the account then has no password and signs in with an emailed code or link, so
   * `signIn.methods.emailCode` must be enabled.
   */
  password: SignUpPasswordModeSchema.default('required'),
})

// An account created without a password can only get in by email.
const passwordlessNeedsCode = {
  message: 'an optional sign-up password needs signIn.methods.emailCode to be enabled',
  path: ['signUp', 'password'],
}

function passwordlessHasCode(settings: {
  signUp: { password: SignUpPasswordMode }
  signIn: { methods: { emailCode: { enabled: boolean } } }
}): boolean {
  return settings.signUp.password === 'required' || settings.signIn.methods.emailCode.enabled
}

const AllowedOrigins = z
  .array(WebOriginSchema)
  .max(MAX_ALLOWED_ORIGINS)
  .refine(distinct, { message: 'must not list an origin twice' })

const Urls = z.object({
  /** Browser origins that may call the client API and read its responses (CORS). */
  allowedOrigins: AllowedOrigins.default([]),
  /**
   * URLs a flow may send the user to: an emailed sign-in link and a provider sign-in lead only
   * to a URL listed here, matched exactly: no prefix, no wildcard. An `https` URL may be an
   * app link of a registered native app (ADR 0040); a custom scheme
   * (`com.example.app:/oauth`) is accepted for a provider sign-in from a native client with
   * a provider that binds its code with PKCE, and listing one is a weakening (ADR 0044).
   */
  allowedRedirectUrls: z
    .array(RedirectUrlSchema)
    .max(MAX_ALLOWED_REDIRECT_URLS)
    .refine(distinct, { message: 'must not list a URL twice' })
    .default([]),
})

const Audit = z.object({
  /**
   * Days an audit entry is kept; `null` (the default) keeps entries for ever. With a number
   * set, the server's retention job deletes the environment's entries older than that,
   * permanently (ADR 0017). **Saving a period, or a shorter one, deletes the older entries
   * for good**, starting with the server's next retention run (they run every ten minutes; a
   * large backlog takes several), which is why `settingsWeakenings` lists it.
   */
  retentionDays: z.number().int().min(1).max(MAX_AUDIT_RETENTION_DAYS).nullable().default(null),
})

const Notifications = z.object({
  /**
   * Email the account's address when its password is changed, reset, set by an administrator or
   * added. On by default; turning it off is recorded as a weakening.
   */
  passwordChanged: z.boolean().default(true),
  /**
   * Email the account's address when it is signed in to from a device family none of its other
   * sessions has (ADR 0023). On by default; turning it off is recorded as a weakening.
   */
  newSignIn: z.boolean().default(true),
  /**
   * Email the account's address when its two-step verification is turned on, turned off or
   * reset by an administrator, when its backup codes are replaced, and when one is used to sign
   * in (ADR 0025). On by default; turning it off is recorded as a weakening.
   */
  mfaChanged: z.boolean().default(true),
  /**
   * Email the account's address when a provider account (Google, GitHub, Apple, Microsoft, Discord, LinkedIn, X, Facebook) is connected
   * to it or disconnected from it (ADR 0026). On by default; turning it off is recorded as a
   * weakening.
   */
  identityChanged: z.boolean().default(true),
})

/** Whether users can, or must, protect their account with a second factor. */
export const MfaPolicySchema = z.enum(['off', 'optional', 'required']).meta({ ref: 'MfaPolicy' })

/** Whether users can, or must, protect their account with a second factor. */
export type MfaPolicy = z.infer<typeof MfaPolicySchema>

const Mfa = z.object({
  /**
   * - `optional` (the default): a user may turn two-step verification on in their profile.
   * - `required`: a user without a second factor must enrol one before a sign-in, sign-up or
   *   password reset completes (`needs_factor_enrolment`), and cannot turn it off.
   * - `off`: nobody can enrol. **A factor a user already has is still asked for** until they
   *   or an administrator remove it: switching the policy off never silently drops anyone's
   *   second factor.
   *
   * Moving towards `off` (`required` → `optional` → `off`) is recorded as a weakening.
   */
  policy: MfaPolicySchema.default('optional'),
  /**
   * A code texted to the account's phone number as a second factor (ADR 0025, "A texted code
   * as a second factor"). **Off by default.** On: a user who has proven a phone number, and
   * has neither an authenticator app nor a passkey, may make a texted code their second
   * step. It is the weakest second factor there is, and it is never used beside a stronger
   * one: a user with an authenticator app or a passkey is never offered it, at a sign-in or
   * a step-up, and cannot enrol it.
   *
   * It needs text messages (`sms.enabled`, a country, a deployment with a sender). Off, no
   * texted code is sent or accepted as a second factor: **a user whose only second factor
   * is a texted code then cannot finish a sign-in** until it is on again or an administrator
   * resets them. Switching it off never drops anyone's factor.
   *
   * Switching it on where `policy` is `required` is recorded as a weakening: the policy can
   * then be met with a texted code.
   */
  smsCode: z.object({ enabled: z.boolean().default(false) }).prefault({}),
})

/** `mfa` as a request may send it: an unknown key is refused, at either level. */
const MfaInput = Mfa.extend({
  smsCode: z.strictObject({ enabled: z.boolean().default(false) }).prefault({}),
}).strict()

const RP_ID = new RegExp(`^(?:localhost|${LABEL}(?:\\.${LABEL})+)$`)

/**
 * Whether a string can be a WebAuthn relying-party id: `localhost`, or a lowercase domain name
 * of at least two labels whose last label is not all digits (so never an IP address, which
 * WebAuthn does not allow). No scheme, port or path.
 *
 * @param value - The candidate.
 * @returns `true` when it has that shape.
 *
 * @example
 * ```ts
 * isRelyingPartyId('northline.app') // true
 * isRelyingPartyId('https://northline.app') // false
 * ```
 */
export function isRelyingPartyId(value: string): boolean {
  return value.length <= 253 && RP_ID.test(value) && !/(?:^|\.)[0-9]+$/.test(value)
}

/**
 * Whether a page on `origin` may use passkeys of the relying party `rpId`: its host is the id
 * itself or a subdomain of it. The same rule a browser applies before it lets a page name an
 * `rpId`.
 *
 * @param origin - A web origin as sent in `Origin`, e.g. `https://app.northline.app`.
 * @param rpId - The environment's relying-party id.
 * @returns `true` when the origin's host equals the id or ends with `.` + the id.
 *
 * @example
 * ```ts
 * originMatchesRelyingParty('https://app.northline.app', 'northline.app') // true
 * originMatchesRelyingParty('https://northline.app.evil.test', 'northline.app') // false
 * ```
 */
export function originMatchesRelyingParty(origin: string, rpId: string): boolean {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  return host === rpId || host.endsWith(`.${rpId}`)
}

const Passkeys = z.object({
  /**
   * The WebAuthn relying-party id every passkey of this environment is bound to: the app's
   * registrable domain (`northline.app`, which also covers `app.northline.app`), or
   * `localhost`. `null` (the default) means passkeys cannot be switched on.
   *
   * **Changing it orphans every existing passkey**: an authenticator only offers a credential
   * to the id it was made for.
   */
  rpId: z
    .string()
    .refine(isRelyingPartyId, {
      message: 'must be a domain such as example.com, or localhost (no scheme, port or path)',
    })
    .nullable()
    .default(null),
})

// A passkey is bound to a relying-party id; without one nothing could be registered or used.
const passkeyNeedsRpId = {
  message: 'passkey needs passkeys.rpId to be set',
  path: ['signIn', 'methods', 'passkey', 'enabled'],
}

function passkeyHasRpId(settings: {
  signIn: { methods: { passkey: { enabled: boolean } } }
  passkeys: { rpId: string | null }
}): boolean {
  return !settings.signIn.methods.passkey.enabled || settings.passkeys.rpId !== null
}

/**
 * A country SMS may be sent to: an ISO 3166-1 alpha-2 code in upper case that the contract's
 * calling-prefix table knows (`COUNTRY_CALLING_PREFIXES`). A code the table does not have is
 * refused rather than stored: it could never match a number.
 */
export const SmsCountrySchema = z
  .string()
  .refine(isSmsCountry, {
    message: 'must be an ISO 3166-1 alpha-2 country code in upper case, such as DE',
  })
  .meta({ ref: 'SmsCountry' })

const SmsCountries = z
  .array(SmsCountrySchema)
  .max(SMS_COUNTRIES.length)
  .refine(distinct, { message: 'must not list a country twice' })

const Sms = z.object({
  /**
   * Whether the server sends text messages for this environment at all. Off by default: a
   * message costs money, and an endpoint that sends one is what SMS pumping abuses.
   */
  enabled: z.boolean().default(false),
  /**
   * The countries a message may go to, as ISO 3166-1 alpha-2 codes in upper case; a set, in
   * no order. **Empty (the default) means nothing is sent**, whatever `enabled` says. A
   * number is matched by the longest calling prefix the contract's table has for it, and
   * countries that share a prefix count as one destination: listing `US` also allows
   * Canadian numbers (ADR 0037).
   */
  allowedCountries: SmsCountries.default([]),
  /**
   * The most text messages the server sends for this environment in one day (UTC, from
   * midnight). Once it is reached nothing more is sent until the next day: it is the fixed
   * maximum an attack on the environment can cost (ADR 0037). On by default
   * ({@link DEFAULT_SMS_DAILY_MESSAGE_LIMIT}), and there is no value that switches it off.
   * The hourly limits per environment and per destination prefix are shares of it, so this
   * one number scales them all.
   */
  dailyMessageLimit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SMS_DAILY_MESSAGE_LIMIT)
    .default(DEFAULT_SMS_DAILY_MESSAGE_LIMIT),
  /**
   * The environment's own sentence for each kind of text message (`SmsTemplates`, ADR 0042),
   * as plain text on one line with `{{name}}` placeholders. Empty by default: every message
   * is the built-in text. The origin-bound last line is the server's and is in no template.
   */
  templates: SmsTemplatesSchema.default({}),
})

const password = PasswordPolicySchema.default(PASSWORD_POLICY_PRESETS.recommended)
const version = z.literal(1).default(1)

const SignIn = z
  .strictObject({
    methods: z
      .strictObject({
        password: PasswordMethod.strict().prefault({}),
        emailCode: OptionalMethod.strict().prefault({}),
        emailLink: OptionalMethod.strict().prefault({}),
        passkey: OptionalMethod.strict().prefault({}),
        smsCode: OptionalMethod.strict().prefault({}),
      })
      .refine(linkHasCode, linkNeedsCode)
      .prefault({}),
  })
  .prefault({})

const minLengthFloor = {
  message: `must be at least ${MIN_PASSWORD_MIN_LENGTH}`,
  path: ['password', 'minLength'],
}

/**
 * An environment's settings: everything about how one tenant's sign-in behaves that is not a
 * secret. This is the whole document, as it is stored and as `GET /v1/admin/settings` returns
 * it. What `PUT /v1/admin/settings` accepts is {@link EnvironmentSettingsInputSchema}.
 *
 * Every field has a default, so `{}` is a valid document and means "the defaults". Because of
 * that an unknown key is refused rather than ignored: a misspelt `pasword` section would
 * otherwise silently reset the password policy to its default.
 *
 * - `version`: the format of this document, `1`.
 * - `app`: the product's name and support address.
 * - `password`: the password policy (see `PasswordPolicy`). `minLength` cannot be set below
 *   {@link MIN_PASSWORD_MIN_LENGTH}.
 * - `signIn.methods`: which first factors are offered: `password` (on by default), `emailCode`
 *   (a 6-digit code by email), `emailLink` (a link in that email, which needs `emailCode`
 *   too), `passkey` (WebAuthn, which needs `passkeys.rpId`) and `smsCode` (a 6-digit code
 *   texted to the phone number an account has proven; offered only while `sms` is on with a
 *   country, in a deployment that can send text messages; ADR 0037). At least one of the
 *   first four must stay enabled, unless an OAuth provider is (the server checks: providers
 *   are configured apart from this document, ADR 0026). `smsCode` does not count: nobody
 *   signs up with a phone number. Switching it on is a weakening (`settingsWeakenings`).
 * - `signUp.password`: whether a sign-up must choose a password (`required`, the default) or
 *   may leave it out (`optional`, which needs `emailCode`).
 * - `urls`: browser origins allowed by CORS, and URLs flows may redirect to.
 * - `audit.retentionDays`: how many days audit entries are kept before the server deletes
 *   them for good; `null` (the default) keeps them for ever.
 * - `notifications`: which security notices are emailed to an account's owner
 *   (`passwordChanged`, `newSignIn`, `mfaChanged`, `identityChanged`). All are on unless switched off.
 * - `mfa.policy`: whether two-step verification is `off`, `optional` (the default) or
 *   `required`.
 * - `mfa.smsCode`: whether a texted code may be a user's second factor (`enabled`, off by
 *   default). Never beside an authenticator app or a passkey (ADR 0025).
 * - `passkeys.rpId`: the WebAuthn relying-party id passkeys are bound to (ADR 0027).
 * - `sessions`: the named session profiles (`web` and `mobile` always exist) and the
 *   concurrent-session rule (`maxPerUser`, `onLimit`). See `SessionSettings` (ADR 0028).
 * - `sms`: whether text messages are sent (`enabled`, off by default), to which countries
 *   (`allowedCountries`, empty by default, which sends nothing) and how many in one day at
 *   most (`dailyMessageLimit`, 500 by default). See ADR 0037. `sms.templates` is the
 *   environment's own sentence for each kind of text message (`SmsTemplates`, ADR 0042);
 *   empty by default: every message is the built-in text.
 * - `emails.templates`: the environment's own subject and body for each kind of email, as
 *   plain text with `{{name}}` placeholders (`EmailTemplates`). Empty by default: every
 *   message is the built-in copy. See ADR 0039.
 */
export const EnvironmentSettingsSchema = z
  .strictObject({
    version,
    app: App.strict().prefault({}),
    password,
    signIn: SignIn,
    signUp: SignUp.strict().prefault({}),
    urls: Urls.strict().prefault({}),
    audit: Audit.strict().prefault({}),
    notifications: Notifications.strict().prefault({}),
    mfa: MfaInput.prefault({}),
    passkeys: Passkeys.strict().prefault({}),
    sessions: SessionSettingsSchema.prefault({}),
    sms: Sms.strict().prefault({}),
    emails: EmailSettingsSchema.prefault({}),
  })
  // On the document, not on `PasswordPolicy` itself: that shape is shared with every SDK and
  // with documents stored before the floor existed.
  .refine((settings) => settings.password.minLength >= MIN_PASSWORD_MIN_LENGTH, minLengthFloor)
  .refine(passwordlessHasCode, passwordlessNeedsCode)
  .refine(passkeyHasRpId, passkeyNeedsRpId)
  .meta({ ref: 'EnvironmentSettings' })

/** An environment's settings. */
export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>

/**
 * The body of `PUT /v1/admin/settings`: the settings document, except that two fields have **no
 * default of their own** and so stay absent when they are left out.
 *
 * - `password` left out takes the deployment's `PASSWORD_POLICY`.
 * - `urls.allowedOrigins` left out takes the deployment's `CORS_ORIGINS`.
 *
 * Those are the values `GET` returns at revision 0. The server fills them in, on every replace
 * and whatever was saved before, so saving a partial document never loosens the password policy
 * or locks browser apps out by accident. A value that is sent, an empty list included, is taken
 * as sent. Everything else is as in {@link EnvironmentSettingsSchema}: other fields left out
 * take their defaults, and unknown keys are refused.
 *
 * One rule is the input's alone: `app.name` is refused when it holds a text-direction
 * control, a private-use or unassigned character or half a surrogate pair. A name saved
 * before that rule is still read and returned; it has to be corrected at the next save.
 *
 * The shape says which of the two were sent, so a server cannot store the document without
 * first deciding what the missing ones are.
 */
export const EnvironmentSettingsInputSchema = z
  .strictObject({
    version,
    app: AppInput.prefault({}),
    password: PasswordPolicySchema.optional(),
    signIn: SignIn,
    signUp: SignUp.strict().prefault({}),
    urls: z
      .strictObject({
        /** Leave out to take the deployment's `CORS_ORIGINS`; send `[]` to allow no origin. */
        allowedOrigins: AllowedOrigins.optional(),
        allowedRedirectUrls: Urls.shape.allowedRedirectUrls,
      })
      .prefault({}),
    audit: Audit.strict().prefault({}),
    notifications: Notifications.strict().prefault({}),
    mfa: MfaInput.prefault({}),
    passkeys: Passkeys.strict().prefault({}),
    sessions: SessionSettingsSchema.prefault({}),
    sms: Sms.strict().prefault({}),
    emails: EmailSettingsSchema.prefault({}),
  })
  .refine(
    (settings) =>
      settings.password === undefined || settings.password.minLength >= MIN_PASSWORD_MIN_LENGTH,
    minLengthFloor
  )
  .refine(passwordlessHasCode, passwordlessNeedsCode)
  .refine(passkeyHasRpId, passkeyNeedsRpId)
  .meta({ ref: 'EnvironmentSettingsInput' })

/** A settings document as sent to `PUT /v1/admin/settings`. */
export type EnvironmentSettingsInput = z.infer<typeof EnvironmentSettingsInputSchema>

/** A sign-in method that can be switched on or off in {@link EnvironmentSettingsSchema}. */
export type SignInMethod = keyof EnvironmentSettings['signIn']['methods']

// The same document, but unknown keys are dropped instead of refused. Used for documents read
// back from storage, which a newer server may have written before a rollback.
const Stored = z.object({
  version,
  app: App.prefault({}),
  password,
  signIn: z
    .object({
      methods: z
        .object({
          password: PasswordMethod.prefault({}),
          emailCode: OptionalMethod.prefault({}),
          emailLink: OptionalMethod.prefault({}),
          passkey: OptionalMethod.prefault({}),
          smsCode: OptionalMethod.prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),
  signUp: SignUp.prefault({}),
  urls: Urls.prefault({}),
  audit: Audit.prefault({}),
  notifications: Notifications.prefault({}),
  mfa: Mfa.prefault({}),
  passkeys: Passkeys.prefault({}),
  sessions: StoredSessionSettingsSchema.prefault({}),
  sms: Sms.prefault({}),
  // Read through `readStoredEmailTemplates` first, which leaves out what would not pass.
  emails: EmailSettingsSchema.prefault({}),
})

/** The settings of an environment that has never saved any. */
export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = EnvironmentSettingsSchema.parse({})

/** A stored settings document as read back. */
export interface StoredEnvironmentSettingsRead {
  settings: EnvironmentSettings
  /** How many list entries were left out because this version would not accept them. */
  dropped: number
  /**
   * The kinds whose stored email template was left out because it no longer passes; their
   * messages are the built-in copy.
   */
  droppedEmailTemplates: EmailTemplateKind[]
  /** How many stored email templates were under a kind this version does not know. */
  unknownEmailTemplates: number
  /**
   * The kinds whose stored text message template was left out because it no longer passes;
   * their messages are the built-in text.
   */
  droppedSmsTemplates: SmsTemplateKind[]
  /** How many stored text message templates were under a kind this version does not know. */
  unknownSmsTemplates: number
}

interface ListRule {
  entry: z.ZodType<string>
  max: number
}

// The lists of a stored document that are read entry by entry, by section: each is an
// allow-list, so leaving an entry out only ever allows less.
const LIST_RULES: Record<string, Record<string, ListRule>> = {
  urls: {
    allowedOrigins: { entry: WebOriginSchema, max: MAX_ALLOWED_ORIGINS },
    allowedRedirectUrls: { entry: RedirectUrlSchema, max: MAX_ALLOWED_REDIRECT_URLS },
  },
  sms: {
    allowedCountries: { entry: SmsCountrySchema, max: SMS_COUNTRIES.length },
  },
}

/** The entries of a stored list this version accepts, and how many it does not. */
function usable(list: unknown, rule: ListRule): { kept: string[]; dropped: number } {
  if (!Array.isArray(list)) {
    // Something that is not a list at all counts as one unusable entry.
    return { kept: [], dropped: 1 }
  }
  const kept = new Set<string>()
  for (const entry of list) {
    if (kept.size < rule.max && rule.entry.safeParse(entry).success) {
      kept.add(entry)
    }
  }
  return { kept: [...kept], dropped: list.length - kept.size }
}

/**
 * Read a settings document that was stored earlier, possibly by another version of the server,
 * and say what had to be left out.
 *
 * Settings are read on the request path, so a stored document must not be able to take an
 * environment down:
 * - fields added since it was written take their defaults;
 * - keys this version does not know are dropped rather than refused (a rollback);
 * - an entry of `urls.allowedOrigins`, `urls.allowedRedirectUrls` or `sms.allowedCountries`
 *   that this version would not accept (not a valid origin, URL or country, a duplicate, or
 *   beyond the list's limit) is left out rather than failing the read. Leaving an entry out
 *   of an allow-list only ever allows less;
 * - an email template (`emails.templates`) of a kind this version does not know, or one that
 *   no longer passes its kind's rules, is left out whole: its message is the built-in copy;
 * - a text message template (`sms.templates`) likewise: its message is the built-in text.
 *
 * @param stored - The stored document.
 * @returns The settings, and how many list entries were left out.
 * @throws ZodError when another known field holds a value that is not valid. Nothing the API
 *   stores can do that: every document is validated in full before it is written.
 *
 * @example
 * ```ts
 * readStoredEnvironmentSettings({ urls: { allowedOrigins: ['http://app.lan'] } })
 * // { settings: { …, urls: { allowedOrigins: [], … } }, dropped: 1, … }
 * ```
 */
export function readStoredEnvironmentSettings(stored: unknown): StoredEnvironmentSettingsRead {
  if (typeof stored !== 'object' || stored === null) {
    return {
      settings: Stored.parse(stored),
      dropped: 0,
      droppedEmailTemplates: [],
      unknownEmailTemplates: 0,
      droppedSmsTemplates: [],
      unknownSmsTemplates: 0,
    }
  }
  const emails = readStoredEmailTemplates(
    (stored as { emails?: { templates?: unknown } | null }).emails?.templates
  )
  const sections: Record<string, unknown> = {}
  let dropped = 0
  for (const [name, rules] of Object.entries(LIST_RULES)) {
    const section = (stored as Record<string, unknown>)[name]
    if (typeof section !== 'object' || section === null) {
      // A section that is not a section at all is read as a missing one.
      sections[name] = undefined
      continue
    }
    const lists: Record<string, string[]> = {}
    for (const [key, rule] of Object.entries(rules)) {
      const list = (section as Record<string, unknown>)[key]
      if (list !== undefined) {
        const result = usable(list, rule)
        lists[key] = result.kept
        dropped += result.dropped
      }
    }
    sections[name] = { ...section, ...lists }
  }
  // The `sms` section as the list rules left it, with its templates read the tolerant way.
  // A section that is no section was read as a missing one above, and stays one.
  const smsSection = sections.sms as Record<string, unknown> | undefined
  const sms = readStoredSmsTemplates(smsSection?.templates)
  if (smsSection !== undefined) {
    sections.sms = { ...smsSection, templates: sms.templates }
  }
  return {
    settings: Stored.parse({ ...stored, ...sections, emails: { templates: emails.templates } }),
    dropped,
    droppedEmailTemplates: emails.dropped,
    unknownEmailTemplates: emails.unknown,
    droppedSmsTemplates: sms.dropped,
    unknownSmsTemplates: sms.unknown,
  }
}

/**
 * Read a settings document that was stored earlier: {@link readStoredEnvironmentSettings}
 * without the count.
 *
 * @param stored - The stored document.
 * @returns The settings.
 * @throws ZodError when a known field other than a list entry holds a value that is not valid.
 *
 * @example
 * ```ts
 * parseStoredEnvironmentSettings({ app: { name: 'Acme' } }).password.minLength // 10
 * ```
 */
export function parseStoredEnvironmentSettings(stored: unknown): EnvironmentSettings {
  return readStoredEnvironmentSettings(stored).settings
}

/** A managing tool's name: short, lowercase, nothing a page or a log could misread. */
export const CONFIG_TOOL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** A config fingerprint: `sha256:` and 64 lowercase hex characters. */
export const CONFIG_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/

/**
 * Which tool manages an environment's settings from a config file, as the admin API returns it
 * (ADR 0030).
 *
 * - `tool`: the tool that last applied a config (`tula-apply`).
 * - `configHash`: the fingerprint of the config it applied.
 * - `at`, `revision`: when it applied, and the settings revision that apply produced.
 * - `drifted`: the settings have been replaced since **without** the marker (by hand, in the
 *   dashboard), so they may no longer be what the file says. `tula diff` shows the difference;
 *   `tula apply` ends it.
 *
 * Only the settings document is covered: OAuth providers are configured by their own routes
 * and have no revision, so a provider changed by hand does not show here.
 */
export const SettingsManagedBySchema = z
  .object({
    tool: z.string().regex(CONFIG_TOOL_PATTERN),
    configHash: z.string().regex(CONFIG_HASH_PATTERN),
    at: z.iso.datetime(),
    revision: z.number().int().min(1),
    drifted: z.boolean(),
  })
  .meta({ ref: 'SettingsManagedBy' })

/** Which tool manages an environment's settings, and whether they drifted from it. */
export type SettingsManagedBy = z.infer<typeof SettingsManagedBySchema>

/**
 * What `GET /v1/client/config` returns: everything a client needs to draw a sign-in screen, and
 * nothing an operator would not put on that screen.
 *
 * - `app.supportEmail` is included because a sign-in screen links to it ("Need help?") and every
 *   email already shows it. It is `null` when none is set.
 * - `signIn.oauth` lists the enabled OAuth providers by name (`google`, `github`, `apple`, `microsoft`, `discord`, `linkedin`, `x`, `facebook`), for
 *   the "Continue with …" buttons. Optional, and plain strings: ignore the ones you do not know.
 * - `signIn.methods` lists the enabled methods by name (`password`, `emailCode`, `emailLink`, `passkey`, `smsCode`;
 *   `smsCode` only while a texted code can really be asked for: the method and `sms` are on, a
 *   country is allowed and the deployment has a sender). It
 *   is an array of plain strings, not an enum, so a client built against this version keeps
 *   working when a server offers a method it does not know; it should ignore those.
 * - `signUp.password` says whether the sign-up form must ask for a password. Optional in the
 *   schema, so a client reading an older server's answer treats a missing one as `required`.
 * - `mfa.policy` says whether a profile screen should offer two-step verification (`off`: hide
 *   it) and whether it can be turned off (`required`: it cannot). Optional in the schema, so a
 *   client reading an older server's answer treats a missing one as `off`. `mfa.smsCode` is
 *   `true` while a texted code can be enrolled as a second factor at all (the setting and
 *   text messages are on, a country is allowed, the deployment has a sender, the policy is
 *   not `off`); whether **this** user may enrol one is said by `GET /v1/client/me/factors`.
 * - `phone.enabled` says whether a profile screen should offer adding a phone number: SMS is
 *   on and at least one country is allowed. Which countries is not said. Optional in the
 *   schema, so a client reading an older server's answer treats a missing one as `false`.
 * - The allow-lists (`urls`, `sms.allowedCountries`), the audit settings, the email templates (`emails`), the notice switches (`notifications`) and
 *   everything under `sessions` (profiles, timeouts, the session limit) are deliberately
 *   absent: a client learns how its session is held from the response that starts it.
 */
export const ClientConfigSchema = z
  .object({
    app: z.object({ name: z.string(), supportEmail: z.string().nullable() }),
    signIn: z.object({
      methods: z.array(z.string()),
      oauth: z.array(z.string()).optional(),
    }),
    signUp: z.object({ password: SignUpPasswordModeSchema }).optional(),
    password: PasswordPolicySchema,
    mfa: z.object({ policy: MfaPolicySchema, smsCode: z.boolean().optional() }).optional(),
    phone: z.object({ enabled: z.boolean() }).optional(),
  })
  .meta({ ref: 'ClientConfig' })

/** The public configuration of an environment. */
export type ClientConfig = z.infer<typeof ClientConfigSchema>
