import {
  type ClientConfig,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type EnvironmentSettingsInput,
  EnvironmentSettingsSchema,
  type PasswordPolicy,
  type SignInMethod,
} from '@tula/contract'
import type { AppConfig, Deps, Tenant } from '~/dependencies'
import { AuthError, ServiceException, ValidationError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import type { EnvironmentSettingsState } from '~/modules/settings/schema'

type ReadDeps = Pick<Deps, 'environmentSettings' | 'config'>

/**
 * The settings of an environment that has saved none: the contract's defaults, with the
 * deployment's `PASSWORD_POLICY` and `CORS_ORIGINS`.
 *
 * Those two variables are **defaults, not overrides**: once an environment saves settings, its
 * own document is the whole truth and the variables no longer apply to it. `CORS_ORIGINS` is
 * taken as written, so a default list can hold an entry the settings API would refuse (plain
 * `http` for a non-local host); it has to be fixed when the document is first saved.
 *
 * @param config - The deployment's configuration.
 * @returns The default document.
 */
export function defaults(
  config: Pick<AppConfig, 'passwordPolicy' | 'corsOrigins'>
): EnvironmentSettings {
  return {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    password: config.passwordPolicy,
    urls: { ...DEFAULT_ENVIRONMENT_SETTINGS.urls, allowedOrigins: [...config.corsOrigins] },
  }
}

async function read(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  fresh: boolean
): Promise<EnvironmentSettingsState> {
  const stored = await deps.environmentSettings.get(tenant.environmentId, fresh)
  return stored ?? { revision: 0, settings: defaults(deps.config) }
}

/**
 * An environment's settings and their revision.
 *
 * By default served from this instance's cache, so they can trail a change made on another
 * instance by the bound documented on `cacheEnvironmentSettings`.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @param fresh - `true` to read past the cache, so the revision is the one a replace will be
 *   checked against. The admin API reads this way; request paths do not.
 * @returns The saved settings, or revision 0 with the {@link defaults}. Do not mutate the result.
 */
export function get(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  fresh = false
): Promise<EnvironmentSettingsState> {
  return read(deps, tenant, fresh)
}

/**
 * The settings that apply in an environment right now. What every other module reads.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @returns The settings. Do not mutate the result.
 *
 * @example
 * ```ts
 * const { password } = await Settings.current(deps, tenant)
 * ```
 */
export async function current(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>
): Promise<EnvironmentSettings> {
  return (await read(deps, tenant, false)).settings
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function flatten(value: unknown, path: string, into: Map<string, string>): void {
  if (!isRecord(value)) {
    // Lists are compared whole: "the allowed origins changed", not which entry.
    into.set(path, JSON.stringify(value))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, path ? `${path}.${key}` : key, into)
  }
}

/**
 * Which settings differ between two documents, as dotted keys.
 *
 * Only the keys: this is what the audit log records, and a value can be something an operator
 * would not want copied there (an origin list, a support address).
 *
 * @param before - The document being replaced.
 * @param after - The new document.
 * @returns The changed keys, sorted, e.g. `['password.minLength', 'urls.allowedOrigins']`.
 */
export function changedKeys(before: EnvironmentSettings, after: EnvironmentSettings): string[] {
  const [was, is] = [new Map<string, string>(), new Map<string, string>()]
  flatten(before, '', was)
  flatten(after, '', is)
  return [...new Set([...was.keys(), ...is.keys()])]
    .filter((key) => was.get(key) !== is.get(key))
    .sort()
}

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
] as const satisfies readonly (keyof EnvironmentSettings['notifications'])[]

/**
 * Whether replacing `before` with `after` makes an account easier to take over, or a takeover
 * harder to notice: the definition behind the audit entry's `weakened` flag.
 *
 * True when a security notice that was on is switched off (`notifications.passwordChanged`,
 * `notifications.newSignIn`: the owner would no longer be told), or when the new password
 * policy, compared with the old one:
 * - allows a shorter password (`minLength` is lower);
 * - checks breached passwords less strictly (`block` → `warn` → `off`);
 * - turns off a rule that was on (a required character kind, `disallowUserInfo`,
 *   `disallowCommon`, `blockSequences`);
 * - asks for fewer character classes, allows longer runs of one character (a higher
 *   `maxRepeatedChars`, or none), or remembers fewer previous passwords (`history`).
 *
 * One of these is enough, whatever else became stricter. Not counted: `maxLength`,
 * `specialChars`, the `preset` label and `expiryDays` (forced rotation is not a strength
 * measure), and every other setting. Disabling a sign-in method removes a way in; it is not a
 * weakening.
 *
 * @param before - The settings being replaced.
 * @param after - The new settings.
 * @returns `true` when the password policy got weaker in at least one respect, or a security
 *   notice was switched off.
 */
export function weakened(before: EnvironmentSettings, after: EnvironmentSettings): boolean {
  const [was, is] = [before.password, after.password]
  const repeats = (policy: PasswordPolicy) => policy.maxRepeatedChars ?? Number.POSITIVE_INFINITY
  return (
    is.minLength < was.minLength ||
    BREACH_CHECK_STRENGTH[is.breachCheck] < BREACH_CHECK_STRENGTH[was.breachCheck] ||
    SWITCHED_RULES.some((rule) => was[rule] && !is[rule]) ||
    is.minCharacterClasses < was.minCharacterClasses ||
    repeats(is) > repeats(was) ||
    is.history < was.history ||
    NOTICES.some((notice) => before.notifications[notice] && !after.notifications[notice])
  )
}

/** What to tell an operator whose deployment default cannot be stored, by the field left out. */
const UNSTORABLE_DEFAULTS = [
  {
    field: 'password',
    message:
      'The deployment’s default password policy cannot be stored in settings. Send password explicitly.',
  },
  {
    field: 'urls.allowedOrigins',
    message:
      'The deployment’s default origins (CORS_ORIGINS) include an entry settings cannot store. Send urls.allowedOrigins explicitly.',
  },
] as const

/**
 * Turn the body of a replace into the whole document to store: the sections it left out take
 * the deployment's defaults instead of the schema's, and the result is validated again.
 *
 * The one place this rule lives. Left to the schema, an omitted `password` would be the
 * `recommended` preset and an omitted `urls.allowedOrigins` an empty list: `PUT {}` would then
 * weaken a deployment that runs `PASSWORD_POLICY=strict` and lock every browser app of a
 * deployment that lists its origins in `CORS_ORIGINS` out, cookie refresh included. So those
 * two take what {@link defaults} gives, on every replace, whatever was saved before. Anything
 * the request did send, an empty list included, is left as sent.
 *
 * The deployment's values are not validated at boot, so `CORS_ORIGINS` can hold an entry a
 * settings document must not (plain `http` for a non-local host). **Nothing reaches the store
 * that the document's own schema refuses**: the completed document is validated strictly, and
 * when a deployment default is what fails, the request is refused with a field error telling
 * the operator to send that field explicitly. The error names the field and never the entry.
 *
 * @param config - The deployment's configuration.
 * @param input - The validated request body.
 * @returns The whole, valid document to store.
 * @throws ValidationError (422) with an error on `password` or `urls.allowedOrigins` when the
 *   deployment's default for a field that was left out cannot be stored.
 */
export function withDeploymentDefaults(
  config: Pick<AppConfig, 'passwordPolicy' | 'corsOrigins'>,
  input: EnvironmentSettingsInput
): EnvironmentSettings {
  const fallback = defaults(config)
  const completed = EnvironmentSettingsSchema.safeParse({
    ...input,
    password: input.password ?? fallback.password,
    urls: {
      ...input.urls,
      allowedOrigins: input.urls.allowedOrigins ?? fallback.urls.allowedOrigins,
    },
  })
  if (completed.success) {
    return completed.data
  }
  // `input` was already valid, so what fails now is something this function filled in.
  const failed = completed.error.issues.map((issue) => issue.path.join('.'))
  throw new ValidationError({
    errors: UNSTORABLE_DEFAULTS.filter(({ field }) =>
      failed.some((path) => path === field || path.startsWith(`${field}.`))
    ).map(({ field, message }) => ({ field, code: 'validation.failed', message })),
    internalMessage: 'a deployment default (PASSWORD_POLICY or CORS_ORIGINS) is not storable',
  })
}

/** A replace of an environment's settings. */
export interface ReplaceInput {
  /** The revision the caller read, from `If-Match`. */
  expectedRevision: number
  /**
   * The request body, validated. Its type keeps `password` and `urls.allowedOrigins` absent
   * when they were left out, so they cannot be stored without {@link withDeploymentDefaults}
   * deciding what they are.
   */
  settings: EnvironmentSettingsInput
}

/**
 * Replace an environment's settings, if they are still at the revision the caller read.
 *
 * The change is recorded as `environment.settings_updated` in the same transaction, with the
 * keys that changed and never their values, and `weakened: true` when it made the password
 * policy weaker or switched a security notice off (see {@link weakened}). A document identical to the current one changes
 * nothing: no new revision and no audit entry.
 *
 * @param deps - Settings store, config, ids and clock.
 * @param tenant - The environment.
 * @param input - The revision being replaced and the new document.
 * @param actor - Who is changing the settings, for the audit log.
 * @returns The settings now in force and their revision.
 * @throws ValidationError (422) when a deployment default the request relied on cannot be
 *   stored (see {@link withDeploymentDefaults}).
 * @throws ServiceException `precondition.failed` (412) when the settings are no longer at
 *   `expectedRevision`; `params.revision` is the current one.
 */
export async function replace(
  deps: ReadDeps & Pick<Deps, 'ids' | 'clock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: ReplaceInput,
  actor: Actor
): Promise<EnvironmentSettingsState> {
  // Before anything else, so a document that cannot be stored is refused whatever the revision
  // and even when it would change nothing.
  const settings = withDeploymentDefaults(deps.config, input.settings)
  // Read past the cache: both the revision check and the list of changed keys must be made
  // against what is really stored, not against what this instance last saw.
  const before = await read(deps, tenant, true)
  if (before.revision !== input.expectedRevision) {
    throw new ServiceException('precondition.failed', { params: { revision: before.revision } })
  }
  const changed = changedKeys(before.settings, settings)
  if (changed.length === 0) {
    return before
  }
  const replaced = await deps.environmentSettings.replace(
    tenant.environmentId,
    input.expectedRevision,
    settings,
    deps.clock.now(),
    Audit.entry(deps, tenant, {
      type: 'environment.settings_updated',
      actor,
      target: { type: 'environment', id: tenant.environmentId },
      data: {
        revision: input.expectedRevision + 1,
        changed,
        // A flag, never the values: enough to find the change that loosened the policy.
        ...(weakened(before.settings, settings) && { weakened: true }),
      },
    })
  )
  if (!replaced) {
    // Another writer got in between the read and the write.
    throw new ServiceException('precondition.failed')
  }
  return replaced
}

/**
 * Read the revision out of an `If-Match` header.
 *
 * The header must be the quoted revision exactly as `ETag` gave it, e.g. `"3"`. `*` and weak
 * validators are not accepted: either would let a write through without naming what it replaces.
 *
 * @param header - The header value, if present.
 * @returns The revision the caller expects.
 * @throws ServiceException `precondition.required` (428) when the header is missing, or
 *   `precondition.failed` (412) when it is not a quoted revision (it cannot match any).
 */
export function expectedRevision(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new ServiceException('precondition.required')
  }
  const matched = /^"(0|[1-9][0-9]{0,8})"$/.exec(header.trim())
  if (!matched) {
    throw new ServiceException('precondition.failed')
  }
  return Number(matched[1])
}

/**
 * The `ETag` of a settings revision.
 *
 * @param revision - The revision.
 * @returns The quoted revision, e.g. `"3"`.
 */
export function etag(revision: number): string {
  return `"${revision}"`
}

/**
 * What a client may know about an environment: enough to draw a sign-in screen.
 *
 * @param settings - The environment's settings.
 * @returns App name and support address, enabled sign-in methods, whether a sign-up needs a
 *   password, and the password policy.
 */
export function clientConfig(settings: EnvironmentSettings): ClientConfig {
  return {
    app: { name: settings.app.name, supportEmail: settings.app.supportEmail },
    signIn: {
      methods: Object.entries(settings.signIn.methods)
        .filter(([, method]) => method.enabled)
        .map(([name]) => name),
    },
    signUp: { password: settings.signUp.password },
    password: settings.password,
  }
}

/**
 * Refuse a request for a sign-in method the environment has switched off.
 *
 * The one place a method's switch is checked: every flow that starts with a given method calls
 * this first, before it looks at the identifier, so the answer says nothing about any account.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @param method - The method the request uses.
 * @throws AuthError `auth.method_disabled` (403) when the method is not enabled.
 */
export async function requireMethod(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  method: SignInMethod
): Promise<void> {
  const { signIn } = await current(deps, tenant)
  if (!signIn.methods[method].enabled) {
    throw new AuthError('auth.method_disabled', { method })
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Whether `url` is a plain `http://` URL on this machine: no credentials and no fragment. */
function isLoopbackUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'http:' &&
    LOOPBACK_HOSTS.has(parsed.hostname) &&
    parsed.username === '' &&
    parsed.password === '' &&
    !url.includes('#')
  )
}

/**
 * Refuse a URL a flow is asked to send the user to unless the environment allows it.
 *
 * The match is **exact**: the URL must be, character for character, an entry of
 * `urls.allowedRedirectUrls`. No prefix, pattern or "same host" rule, because each of those has
 * turned an allow-list into an open redirect somewhere. In the `local` tier any `http://` URL on
 * a loopback host is allowed as well, mirroring the CORS rule, so local development needs no
 * setup. It depends only on the environment, never on an account.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @param url - The URL the request asked for, if any.
 * @returns The URL, now known to be allowed.
 * @throws AuthError `request.redirect_not_allowed` (400) when it is missing or not allowed.
 */
export async function requireRedirectUrl(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  url: string | undefined
): Promise<string> {
  if (url !== undefined) {
    const { urls } = await current(deps, tenant)
    if (
      urls.allowedRedirectUrls.includes(url) ||
      (deps.config.tier === 'local' && isLoopbackUrl(url))
    ) {
      return url
    }
  }
  throw new AuthError('request.redirect_not_allowed')
}
