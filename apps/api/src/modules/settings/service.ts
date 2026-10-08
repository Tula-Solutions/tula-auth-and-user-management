import {
  AT_LEAST_ONE_SIGN_IN_METHOD,
  type ClientConfig,
  CONFIG_HASH_HEADER,
  CONFIG_HASH_PATTERN,
  CONFIG_MANAGED_BY_HEADER,
  CONFIG_TOOL_PATTERN,
  CONFIG_UNMANAGED,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  type EnvironmentSettingsInput,
  EnvironmentSettingsSchema,
  hasEnabledSignInMethod,
  isPhoneNumberAllowed,
  type OAuthProvider,
  type SignInMethod,
  settingsWeakenings,
} from '@tula/contract'
import type { AppConfig, Deps, Tenant } from '~/dependencies'
import { AuthError, ServiceException, ValidationError } from '~/exceptions'
import type { Actor } from '~/lib/actor'
import * as Audit from '~/modules/audit/service'
import type { EnvironmentSettingsState } from '~/modules/settings/schema'
import type {
  SettingsManagerInput,
  StoredEnvironmentSettings,
} from '~/ports/environment-settings-store'

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
  return stored
    ? toState(stored)
    : { revision: 0, settings: defaults(deps.config), managedBy: null }
}

/**
 * Stored settings as the service answers them: with the managing tool on record, if any, and
 * whether the settings were replaced since it last applied (its revision is behind).
 */
function toState(stored: StoredEnvironmentSettings): EnvironmentSettingsState {
  const { managedBy } = stored
  return {
    revision: stored.revision,
    settings: stored.settings,
    managedBy: managedBy ? { ...managedBy, drifted: managedBy.revision !== stored.revision } : null,
  }
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

/**
 * The JWT templates are compared whole, like a list: "the templates changed", not which one
 * or which claim. Their claims would otherwise be up to 160 names, more than an event's
 * `changed` may hold together with the rest of the document. And a template's name, unlike a
 * profile's, is also a **value** in the document (a profile's `jwtTemplate`), so naming it
 * here would put a string an admin typed into an event's payload, which goes to third
 * parties (ADR 0012). A profile that changes its template is named by its field.
 */
const WHOLE = /^sessions\.jwtTemplates$/

/** A value whose keys are in a fixed order, so that two equal maps compare equal as text. */
function ordered(value: unknown): unknown {
  if (!isRecord(value)) {
    return Array.isArray(value) ? value.map(ordered) : value
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered(value[key])])
  )
}

function flatten(value: unknown, path: string, into: Map<string, string>): void {
  if (WHOLE.test(path)) {
    // The order templates and their claims are written in means nothing.
    into.set(path, JSON.stringify(ordered(value)))
    return
  }
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

/**
 * Whether replacing `before` with `after` makes an account easier to take over, or a takeover
 * harder to notice: the definition behind the audit entry's `weakened` flag.
 *
 * The definition itself is the contract's `settingsWeakenings` (which lists what got weaker),
 * so that `tula diff` warns about exactly what this records: a weaker password policy, an
 * audit retention period set or shortened (older entries are then deleted), a security
 * notice switched off, an MFA policy moved towards `off`, or sessions that live longer or can
 * be had more freely.
 *
 * @param before - The settings being replaced.
 * @param after - The new settings.
 * @returns `true` when at least one setting got weaker.
 */
export function weakened(before: EnvironmentSettings, after: EnvironmentSettings): boolean {
  return settingsWeakenings(before, after).length > 0
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

/**
 * Refuse settings that would leave an environment with no way to sign in.
 *
 * A document may switch every method of its own off when an OAuth provider is enabled
 * (ADR 0026): providers are configured apart from the settings document, so the schema cannot
 * make this check and it is made here, against the provider store. The converse (disabling or
 * removing the last provider of an environment whose methods are all off) is refused by
 * `~/modules/oauth/service`.
 *
 * @throws ValidationError (422) on `signIn.methods`.
 */
async function requireWayIn(
  deps: Pick<Deps, 'oauthProviders'>,
  tenant: Pick<Tenant, 'environmentId'>,
  settings: EnvironmentSettings
): Promise<void> {
  if (hasEnabledSignInMethod(settings)) {
    return
  }
  const providers = await deps.oauthProviders.list(tenant.environmentId)
  if (!providers.some((provider) => provider.enabled)) {
    throw new ValidationError({
      errors: [
        {
          field: 'signIn.methods',
          code: 'validation.failed',
          message: AT_LEAST_ONE_SIGN_IN_METHOD,
        },
      ],
    })
  }
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
  /**
   * The tool applying these settings from a config file (recorded with them), `null` to remove
   * the record, or left out for a change made by hand: the record is then kept and shows as
   * drifted. See {@link managerFromHeaders}.
   */
  manager?: SettingsManagerInput | null
}

/**
 * Read the managing tool a replace names from its two headers (ADR 0030).
 *
 * @param tool - `x-tula-managed-by`: a tool's name, or `none`.
 * @param configHash - `x-tula-config-hash`: the config's fingerprint.
 * @returns The manager to record, `null` for `none`, `undefined` when neither header was sent.
 * @throws ValidationError (422) naming the header: a tool without a hash or the reverse, a hash
 *   sent with `none`, or a value that is not a tool name or a SHA-256 fingerprint.
 */
export function managerFromHeaders(
  tool: string | undefined,
  configHash: string | undefined
): SettingsManagerInput | null | undefined {
  const refuse = (field: string, message: string) =>
    new ValidationError({ errors: [{ field, code: 'validation.failed', message }] })
  if (tool === undefined) {
    if (configHash !== undefined) {
      throw refuse(CONFIG_MANAGED_BY_HEADER, `is required with ${CONFIG_HASH_HEADER}`)
    }
    return undefined
  }
  if (tool === CONFIG_UNMANAGED) {
    if (configHash !== undefined) {
      throw refuse(CONFIG_HASH_HEADER, `cannot be sent with ${CONFIG_UNMANAGED}`)
    }
    return null
  }
  if (!CONFIG_TOOL_PATTERN.test(tool)) {
    throw refuse(CONFIG_MANAGED_BY_HEADER, 'must be a tool name such as tula-apply')
  }
  if (configHash === undefined || !CONFIG_HASH_PATTERN.test(configHash)) {
    throw refuse(CONFIG_HASH_HEADER, 'must be sha256: followed by 64 hex characters')
  }
  return { tool, configHash }
}

/** Whether a replace would change which tool is on record as managing the settings. */
function managerChanges(
  before: EnvironmentSettingsState,
  manager: SettingsManagerInput | null | undefined
): boolean {
  if (manager === undefined) {
    return false
  }
  const current = before.managedBy
  if (manager === null) {
    return current !== null
  }
  return (
    current === null ||
    current.tool !== manager.tool ||
    current.configHash !== manager.configHash ||
    // The same file again after a change made around it: that apply is what ends the drift.
    current.drifted
  )
}

/**
 * Replace an environment's settings, if they are still at the revision the caller read.
 *
 * The change is recorded as `environment.settings_updated` in the same transaction, with the
 * keys that changed and never their values, and `weakened: true` when it weakened anything
 * the contract's `settingsWeakenings` lists (see {@link weakened}). A document identical to the current one changes
 * nothing: no new revision and no audit entry, unless the replace also changes which tool is
 * on record as managing the settings (`input.manager`), which is a write of its own.
 *
 * @param deps - Settings store, config, ids and clock.
 * @param tenant - The environment.
 * @param input - The revision being replaced and the new document.
 * @param actor - Who is changing the settings, for the audit log.
 * @returns The settings now in force and their revision.
 * @throws ValidationError (422) when a deployment default the request relied on cannot be
 *   stored (see {@link withDeploymentDefaults}), or when the document enables no sign-in method
 *   and the environment has no OAuth provider enabled.
 * @throws ServiceException `precondition.failed` (412) when the settings are no longer at
 *   `expectedRevision`; `params.revision` is the current one.
 */
export async function replace(
  deps: ReadDeps & Pick<Deps, 'ids' | 'clock' | 'oauthProviders' | 'environmentLock'>,
  tenant: Pick<Tenant, 'projectId' | 'environmentId'>,
  input: ReplaceInput,
  actor: Actor
): Promise<EnvironmentSettingsState> {
  // Before anything else, so a document that cannot be stored is refused whatever the revision
  // and even when it would change nothing.
  const settings = withDeploymentDefaults(deps.config, input.settings)
  // "At least one sign-in method" is decided from this document and the provider rows, which
  // another route writes. Both take the environment's lock and check inside it, so neither
  // decides against a state the other is about to change.
  return deps.environmentLock.runExclusive(tenant.environmentId, 'sign_in_methods', async () => {
    await requireWayIn(deps, tenant, settings)
    // Read past the cache: both the revision check and the list of changed keys must be made
    // against what is really stored, not against what this instance last saw.
    const before = await read(deps, tenant, true)
    if (before.revision !== input.expectedRevision) {
      throw new ServiceException('precondition.failed', { params: { revision: before.revision } })
    }
    const changed = changedKeys(before.settings, settings)
    const { manager } = input
    const managed = managerChanges(before, manager)
    if (changed.length === 0 && !managed) {
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
          // Which tool applied a config file, or that its record was removed (`null`).
          ...(manager && { managedBy: manager.tool }),
          ...(manager === null && { managedBy: null }),
          // Settings a config file manages, changed around it: the next `tula diff` shows it.
          ...(manager === undefined && before.managedBy !== null && { outsideConfig: true }),
        },
      }),
      manager
    )
    if (!replaced) {
      // Another writer got in between the read and the write.
      throw new ServiceException('precondition.failed')
    }
    return toState(replaced)
  })
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
 * @param oauth - The OAuth providers the environment has enabled.
 * @param smsSender - Whether the deployment has a way to send a text message
 *   (`deps.sms.configured`). Without one no phone number is offered, whatever the settings
 *   say: every try would be refused.
 * @returns App name and support address, enabled sign-in methods and providers, whether a
 *   sign-up needs a password, the password policy and whether a phone number can be added.
 */
export function clientConfig(
  settings: EnvironmentSettings,
  oauth: readonly OAuthProvider[] = [],
  smsSender = false
): ClientConfig {
  return {
    app: { name: settings.app.name, supportEmail: settings.app.supportEmail },
    signIn: {
      methods: Object.entries(settings.signIn.methods)
        .filter(([, method]) => method.enabled)
        .map(([name]) => name),
      oauth: [...oauth],
    },
    signUp: { password: settings.signUp.password },
    password: settings.password,
    mfa: { policy: settings.mfa.policy },
    // Whether a number can be added at all, and nothing of which countries.
    phone: {
      enabled: smsSender && settings.sms.enabled && settings.sms.allowedCountries.length > 0,
    },
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

/**
 * Refuse a request that would send a text message the environment does not allow.
 *
 * The one place the `sms` settings are checked: every step that sends a code by SMS, or
 * accepts one, calls this first, before anything is counted, spent or sent, so a code asked
 * for before SMS was switched off (or its country taken off the list) is not honoured after.
 *
 * Off, and on with an empty country list, are the same answer: nothing can be sent. The two
 * refusals are told apart on purpose: the caller is the signed-in owner of the request, and
 * both say something about the environment and the number they typed, nothing about anyone
 * else.
 *
 * @param deps - Settings store and config.
 * @param tenant - The environment.
 * @param phoneNumber - The destination in E.164 form. Left out where no number is known
 *   yet: only the switch and "any country at all" are then checked.
 * @throws AuthError `sms.disabled` (403) when SMS is off or no country is allowed, or
 *   `sms.country_not_allowed` (422) when the number's country is not on the list.
 */
export async function requireSms(
  deps: ReadDeps,
  tenant: Pick<Tenant, 'environmentId'>,
  phoneNumber?: string
): Promise<void> {
  const { sms } = await current(deps, tenant)
  if (!sms.enabled || sms.allowedCountries.length === 0) {
    throw new AuthError('sms.disabled')
  }
  if (phoneNumber !== undefined && !isPhoneNumberAllowed(phoneNumber, sms.allowedCountries)) {
    throw new AuthError('sms.country_not_allowed')
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
