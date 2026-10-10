import { durationToMs } from './duration'
import type { EnvironmentSettings } from './environment-settings'
import { type JwtTemplateClaim, jwtTemplateOfProfile } from './jwt-template'
import type { PasswordPolicy } from './password-policy'
import { DEFAULT_STEP_UP_AFTER, type SessionProfile, type SessionSettings } from './session-profile'

/** Password rules that are either on or off. Turning one off weakens the policy. */
const SWITCHED_RULES = [
  'requireLowercase',
  'requireUppercase',
  'requireNumber',
  'requireSpecial',
  'disallowUserInfo',
  'disallowCommon',
  'blockSequences',
] as const satisfies readonly (keyof PasswordPolicy)[]

const BREACH_CHECK_STRENGTH: Record<PasswordPolicy['breachCheck'], number> = {
  off: 0,
  warn: 1,
  block: 2,
}

/** The security notices an environment can switch off. Switching one off is a weakening. */
const NOTICES = [
  'passwordChanged',
  'newSignIn',
  'mfaChanged',
  'identityChanged',
] as const satisfies readonly (keyof EnvironmentSettings['notifications'])[]

/** How much each MFA policy asks of an account. Moving to a lower one is a weakening. */
const MFA_POLICY_STRENGTH: Record<EnvironmentSettings['mfa']['policy'], number> = {
  off: 0,
  optional: 1,
  required: 2,
}

/** A duration in milliseconds, with what "none" means for the field it came from. */
function span(duration: string | null, none: number): number {
  return duration === null ? none : durationToMs(duration)
}

/**
 * Whether `is` lets a session live longer than `than` does: a longer idle or absolute timeout,
 * access-token lifetime or refresh grace window, or a step-up asked for later (none of its own
 * is the default window).
 */
function looser(is: SessionProfile, than: SessionProfile): boolean {
  const never = Number.POSITIVE_INFINITY
  const stepUp = durationToMs(DEFAULT_STEP_UP_AFTER)
  return (
    span(is.idleTimeout, never) > span(than.idleTimeout, never) ||
    span(is.absoluteTimeout, never) > span(than.absoluteTimeout, never) ||
    span(is.accessTokenTtl, never) > span(than.accessTokenTtl, never) ||
    span(is.refresh.reuseGracePeriod, 0) > span(than.refresh.reuseGracePeriod, 0) ||
    span(is.stepUpAfter, stepUp) > span(than.stepUpAfter, stepUp)
  )
}

function passwordWeakenings(was: PasswordPolicy, is: PasswordPolicy): string[] {
  const repeats = (policy: PasswordPolicy) => policy.maxRepeatedChars ?? Number.POSITIVE_INFINITY
  const fields: (keyof PasswordPolicy)[] = []
  if (is.minLength < was.minLength) {
    fields.push('minLength')
  }
  if (BREACH_CHECK_STRENGTH[is.breachCheck] < BREACH_CHECK_STRENGTH[was.breachCheck]) {
    fields.push('breachCheck')
  }
  fields.push(...SWITCHED_RULES.filter((rule) => was[rule] && !is[rule]))
  if (is.minCharacterClasses < was.minCharacterClasses) {
    fields.push('minCharacterClasses')
  }
  if (repeats(is) > repeats(was)) {
    fields.push('maxRepeatedChars')
  }
  if (is.history < was.history) {
    fields.push('history')
  }
  return fields.map((field) => `password.${field}`)
}

/**
 * Whether the new audit retention period deletes entries the old one kept: a period where
 * there was none (`null` keeps entries for ever), or a shorter one. A longer period, the same
 * one, or none where there was one deletes nothing more.
 */
function shorterRetention(was: number | null, is: number | null): boolean {
  return is !== null && (was === null || is < was)
}

/** The custom claims a profile's sessions carry: its template's, or none. */
function claimsOf(
  settings: SessionSettings,
  profile: SessionProfile
): Record<string, JwtTemplateClaim> {
  return jwtTemplateOfProfile(settings, profile)?.template.claims ?? {}
}

/**
 * Whether sessions that carried the claims `was` lose one, or get one that is read from
 * somewhere else, when they carry `is` instead. A claim that is only added is not counted, and
 * neither is the order the claims are written in.
 */
function claimsLost(
  was: Record<string, JwtTemplateClaim>,
  is: Record<string, JwtTemplateClaim>
): boolean {
  return Object.entries(was).some(
    ([key, claim]) => !Object.hasOwn(is, key) || JSON.stringify(is[key]) !== JSON.stringify(claim)
  )
}

/**
 * Where the `sessions` section got weaker:
 *
 * - the concurrent-session limit was raised or removed;
 * - a profile that existed now lets its sessions live longer (see `looser`) or became
 *   selectable by clients;
 * - a profile that was removed: it is compared with the built-in `web` profile its sessions
 *   fall back to;
 * - a **new** profile that clients may select and that is looser in any limit than the
 *   built-in `web` profile of the same document. A client that names it gets a session the
 *   built-in would not have given, which is exactly how sessions come to "be had more
 *   freely". One that is no looser than `web`, or that clients cannot select (nothing can
 *   get it), weakens nothing.
 *
 * - `sessions.profiles.<name>.jwtTemplate`: the sessions of a profile that existed lose a
 *   custom claim they carried, or a claim they carried is now read from another source or
 *   holds another constant (see `claimsLost`). What is compared is what the sessions carry,
 *   not how it is written: the profile stopped using its template, uses another, or its
 *   template changed; a removed profile is compared with the built-in `web`. An application
 *   may be authorizing on that claim, and one that reads a missing claim as permission would
 *   open up. Adding a claim or a template, and changing a template no profile uses, is not
 *   listed.
 *
 * Changing `onLimit` or a profile's `type` is not a weakening either way.
 */
function sessionWeakenings(before: SessionSettings, after: SessionSettings): string[] {
  const paths: string[] = []
  if (
    before.maxPerUser !== null &&
    (after.maxPerUser === null || after.maxPerUser > before.maxPerUser)
  ) {
    paths.push('sessions.maxPerUser')
  }
  for (const [name, was] of Object.entries(before.profiles)) {
    const is = Object.hasOwn(after.profiles, name) ? (after.profiles[name] ?? was) : null
    const weaker = is
      ? looser(is, was) || (is.clientSelectable && !was.clientSelectable)
      : looser(after.profiles.web, was)
    if (weaker) {
      paths.push(`sessions.profiles.${name}`)
    }
    if (claimsLost(claimsOf(before, was), claimsOf(after, is ?? after.profiles.web))) {
      paths.push(`sessions.profiles.${name}.jwtTemplate`)
    }
  }
  for (const [name, is] of Object.entries(after.profiles)) {
    if (
      !Object.hasOwn(before.profiles, name) &&
      is.clientSelectable &&
      looser(is, after.profiles.web)
    ) {
      paths.push(`sessions.profiles.${name}`)
    }
  }
  return paths
}

/**
 * Where the `sms` section lets text messages cost more than before (ADR 0037):
 * `sms.dailyMessageLimit` is raised. It is the most an attack on the environment can make it
 * send in a day, and no value removes it. Lowering it is not listed, and neither, here, is
 * the switch or the country list: the limit holds wherever messages go. (What they mean for
 * signing in is {@link smsSignInWeakenings}.)
 */
function smsWeakenings(before: EnvironmentSettings['sms'], after: EnvironmentSettings['sms']) {
  return after.dailyMessageLimit > before.dailyMessageLimit ? ['sms.dailyMessageLimit'] : []
}

/**
 * Whether these settings let a text message go anywhere: text messages are on and at least
 * one country may be sent to. (Whether the deployment has a sender is not a setting, and is
 * not asked here.)
 */
function textsGo(settings: EnvironmentSettings): boolean {
  return settings.sms.enabled && settings.sms.allowedCountries.length > 0
}

/** Whether `after` allows a country that `before` did not. A reordering adds none. */
function countryAdded(before: EnvironmentSettings, after: EnvironmentSettings): boolean {
  const had = new Set(before.sms.allowedCountries)
  return after.sms.allowedCountries.some((country) => !had.has(country))
}

/**
 * Whether a texted code can sign someone in under these settings: the method is on, text
 * messages are on, and at least one country may be sent to.
 */
function smsSignsIn(settings: EnvironmentSettings): boolean {
  return settings.signIn.methods.smsCode.enabled && textsGo(settings)
}

/**
 * Where signing in with a texted code (ADR 0037) opens up:
 *
 * - `signIn.methods.smsCode`: a texted code can sign someone in where it could not before.
 *   That is the method switched on, and equally text messages switched on, or a first
 *   country allowed, under a method that was on already: whichever key changed, what got
 *   weaker is this method, and it is listed under its own path. An account that has proven a
 *   phone number can then be entered by whoever receives that number's messages (a swapped
 *   SIM, a recycled number, a forwarded line), with no password and no inbox.
 * - `sms.allowedCountries`: while a texted code signs people in, before and after, a country
 *   is allowed that was not: the accounts whose numbers are in it gain that way in. A list
 *   that only shrinks, or is reordered, is not listed.
 */
function smsSignInWeakenings(before: EnvironmentSettings, after: EnvironmentSettings): string[] {
  if (!smsSignsIn(after)) {
    return []
  }
  if (!smsSignsIn(before)) {
    return ['signIn.methods.smsCode']
  }
  return countryAdded(before, after) ? ['sms.allowedCountries'] : []
}

/**
 * Where a texted code as the second step (ADR 0025) opens up. All of it is under one
 * condition, the one the switch has had since it existed: **after the change the switch is
 * on and the policy is `required`**, so that the policy can be met with a text message, the
 * second step that is easiest to take. Under `optional` and `off` nothing here is listed: a
 * texted code then only adds a second step where an account had none, it is never asked for
 * beside a stronger one, and a wider reach of it is a wider reach of that addition.
 *
 * - `mfa.smsCode`: the switch is turned on (whether or not a text message can go anywhere
 *   yet: the decision is the switch's, and it is asked about when it is made); or, under a
 *   switch that was on already, text messages are switched on or a first country is allowed,
 *   which is when a texted code can first be that step. Whichever key changed, what got
 *   weaker is this second step, and it is listed under its own path.
 * - `sms.allowedCountries`: under a switch that was on, with text messages going before and
 *   after, a country is allowed that was not: the accounts whose numbers are in it can now
 *   meet the policy with a text message. A list that only shrinks, or is reordered, is not
 *   listed.
 *
 * Making the policy `required` over a switch, text messages and countries that were all
 * there already is not listed: it asks more of every account than before, and takes nothing
 * from any.
 */
function smsSecondStepWeakenings(
  before: EnvironmentSettings,
  after: EnvironmentSettings
): string[] {
  if (!after.mfa.smsCode.enabled || after.mfa.policy !== 'required') {
    return []
  }
  if (!before.mfa.smsCode.enabled) {
    return ['mfa.smsCode']
  }
  if (!textsGo(after)) {
    return []
  }
  if (!textsGo(before)) {
    return ['mfa.smsCode']
  }
  return countryAdded(before, after) ? ['sms.allowedCountries'] : []
}

/**
 * Where replacing `before` with `after` makes an account easier to take over, a takeover
 * harder to notice or to look into afterwards, or an attack on the environment dearer for
 * its operator. It is the one definition of "weakened": the server's audit entry carries
 * `weakened: true` exactly when this is not empty, and `tula diff` warns with these paths
 * before anything is applied.
 *
 * A path is listed when:
 * - `password.*`: the new policy allows a shorter password (`minLength`), checks breached
 *   passwords less strictly (`breachCheck`: `block` → `warn` → `off`), turns off a rule that
 *   was on (a required character kind, `disallowUserInfo`, `disallowCommon`,
 *   `blockSequences`), asks for fewer character classes, allows longer runs of one character
 *   (a higher `maxRepeatedChars`, or none), or remembers fewer previous passwords (`history`);
 * - `audit.retentionDays`: a period is set where there was none, or is made shorter. The
 *   server then deletes the audit entries older than it, for good: the record of what
 *   happened gets shorter. A longer period, or none where there was one, is not listed;
 * - `notifications.*`: a security notice that was on is switched off (the owner would no
 *   longer be told);
 * - `mfa.policy`: the policy moves towards `off` (`required` → `optional` → `off`);
 * - `mfa.smsCode`: a texted code becomes a way to meet a `required` policy: the switch is
 *   turned on where the policy is `required` after the change, or, under a switch that was
 *   on, text messages are switched on or a first country is allowed. A texted code is
 *   easier to take than an authenticator app. Under `optional` it is not listed (it adds a
 *   second step where there was none, and is never used beside a stronger one), and
 *   switching it off never is (nobody's factor is dropped; ADR 0025);
 * - `sessions.maxPerUser`, `sessions.profiles.<name>`: sessions live longer or can be had
 *   more freely (a raised or removed limit, a looser profile, one clients may now select);
 * - `sessions.profiles.<name>.jwtTemplate`: the profile's sessions lose a custom claim, or
 *   one of their claims changes its source or its constant (ADR 0036). It is listed because
 *   an application decides on those claims: taking one away can lock users out, and opens up
 *   an application that reads a missing claim as permission;
 * - `sms.dailyMessageLimit`: more text messages can be sent in a day (ADR 0037). It makes no
 *   account easier to take: it enlarges what someone abusing the environment's SMS can make
 *   its operator pay, which is why a change that does it is asked about like the others;
 * - `signIn.methods.smsCode`: a texted code can sign someone in where it could not before
 *   (the method switched on; or, with the method already on, text messages switched on or a
 *   first country allowed). A phone number is easier to take than an inbox;
 * - `sms.allowedCountries`: a country is added while a texted code signs people in, or
 *   while one may be the second step a `required` policy asks for (listed once).
 *
 * One of these is enough, whatever else became stricter. Not counted: `maxLength`,
 * `specialChars`, the `preset` label and `expiryDays` (forced rotation is not a strength
 * measure), and every other setting. Disabling a sign-in method removes a way in; it is not a
 * weakening, and neither is switching on any method but the SMS code. Switching SMS on or
 * off, or a wider or narrower country list, is not one **while no texted code signs anyone
 * in and none can meet a required second step**: a phone number is then contact data that
 * no account is signed in to or recovered with, or a second step added where there was none
 * (ADR 0037, ADR 0025), and the daily limit bounds what the messages can cost wherever they
 * go.
 *
 * @param before - The settings being replaced.
 * @param after - The new settings.
 * @returns The paths that got weaker, in document order; empty when nothing did.
 *
 * @example
 * ```ts
 * settingsWeakenings(current, { ...current, mfa: { policy: 'off' } }) // ['mfa.policy']
 * ```
 */
export function settingsWeakenings(
  before: EnvironmentSettings,
  after: EnvironmentSettings
): string[] {
  const paths = passwordWeakenings(before.password, after.password)
  if (shorterRetention(before.audit.retentionDays, after.audit.retentionDays)) {
    paths.push('audit.retentionDays')
  }
  for (const notice of NOTICES) {
    if (before.notifications[notice] && !after.notifications[notice]) {
      paths.push(`notifications.${notice}`)
    }
  }
  if (MFA_POLICY_STRENGTH[after.mfa.policy] < MFA_POLICY_STRENGTH[before.mfa.policy]) {
    paths.push('mfa.policy')
  }
  // A texted code as a way to meet a required second step (ADR 0025). Its country path is
  // held back, to be listed once with the sign-in's, in document order.
  const secondStep = smsSecondStepWeakenings(before, after)
  paths.push(...secondStep.filter((path) => path === 'mfa.smsCode'))
  paths.push(...sessionWeakenings(before.sessions, after.sessions))
  paths.push(...smsWeakenings(before.sms, after.sms))
  const signIn = smsSignInWeakenings(before, after)
  paths.push(...signIn)
  if (secondStep.includes('sms.allowedCountries') && !signIn.includes('sms.allowedCountries')) {
    paths.push('sms.allowedCountries')
  }
  return paths
}
