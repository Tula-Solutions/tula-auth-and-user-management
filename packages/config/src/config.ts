import {
  type ActivityType,
  CreateHookRequestSchema,
  CreateWebhookEndpointRequestSchema,
  type EnvironmentSettingsInput,
  EnvironmentSettingsInputSchema,
  type HookFailureMode,
  type HookPoint,
  MAX_WEBHOOK_ENDPOINTS,
  type MicrosoftTenant,
  MicrosoftTenantSchema,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  UpdateWebhookEndpointRequestSchema,
} from '@tula/contract'
import { z } from 'zod'
import { ConfigError, type ConfigIssue, invalidConfig } from './errors'

/** An environment variable's name, as shells accept it and as CI systems write it. */
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/

/** An environment's name in a config file: what `--env` takes. */
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,31}$/

/**
 * A secret, by the name of the environment variable that holds it. The only form a secret may
 * take in a config file.
 *
 * @example
 * ```ts
 * const secret: SecretRef = env('GOOGLE_CLIENT_SECRET')
 * ```
 */
export interface SecretRef {
  /** The variable's name. */
  readonly $env: string
}

/**
 * Refer to a secret by the environment variable that holds it.
 *
 * A config file is committed, reviewed and printed in diffs; a secret in it is leaked. So a
 * provider's `clientSecret` or `privateKey` is typed as a reference and nothing else: a string
 * there does not compile and is refused when the file is loaded. The variable is read only by
 * `tula apply`, at the moment the provider is written.
 *
 * @param name - The variable's name: capitals, digits and underscores.
 * @returns The reference.
 * @throws ConfigError `config.invalid` when `name` is not a variable name.
 *
 * @example
 * ```ts
 * providers: { google: { clientId: '1234.apps.googleusercontent.com', clientSecret: env('GOOGLE_CLIENT_SECRET') } }
 * ```
 */
export function env(name: string): SecretRef {
  if (typeof name !== 'string' || !VARIABLE_NAME.test(name)) {
    throw invalidConfig([
      {
        path: 'env()',
        message: 'takes the name of an environment variable, e.g. GOOGLE_CLIENT_SECRET',
      },
    ])
  }
  return { $env: name }
}

/**
 * Whether a value is a secret reference made by {@link env}.
 *
 * @param value - Anything.
 * @returns `true` for `{ $env: 'NAME' }` and nothing else.
 *
 * @example
 * ```ts
 * isSecretRef(env('A')) // true
 * isSecretRef('a literal') // false
 * ```
 */
export function isSecretRef(value: unknown): value is SecretRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  const name = (value as { $env?: unknown }).$env
  return (
    keys.length === 1 && keys[0] === '$env' && typeof name === 'string' && VARIABLE_NAME.test(name)
  )
}

const SECRET_MESSAGE =
  "must be env('NAME'): a secret is read from an environment variable, never written in the config file"

const Secret = z.custom<SecretRef>(isSecretRef, { message: SECRET_MESSAGE })

const text = (max: number) => z.string().trim().min(1).max(max)

const ClientProvider = z.strictObject({
  clientId: text(512),
  clientSecret: Secret,
  enabled: z.boolean().default(true),
})

const AppleProvider = z.strictObject({
  clientId: text(512),
  teamId: text(64),
  keyId: text(64),
  privateKey: Secret,
  enabled: z.boolean().default(true),
})

// The tenant is the admin API's own field (`PUT /v1/admin/oauth-providers/microsoft`): an
// alias or a tenant id, lower-cased. It is required, as it is there: which accounts may sign
// in is a decision, and a default would make it for the operator.
const MicrosoftProvider = z.strictObject({
  clientId: text(512),
  clientSecret: Secret,
  tenant: MicrosoftTenantSchema,
  enabled: z.boolean().default(true),
})

const Providers = z.strictObject({
  google: ClientProvider.optional(),
  github: ClientProvider.optional(),
  apple: AppleProvider.optional(),
  microsoft: MicrosoftProvider.optional(),
  discord: ClientProvider.optional(),
  linkedin: ClientProvider.optional(),
})

// An endpoint's fields are the admin API's own (`POST` and `PATCH
// /v1/admin/webhook-endpoints`): the address and the event types as a registration takes
// them, `enabled` as a change does, with no default. Nothing is declared a second time here.
const WebhookAddress = CreateWebhookEndpointRequestSchema.shape.url
const WebhookEventTypes = CreateWebhookEndpointRequestSchema.shape.eventTypes
const WebhookEnabled = UpdateWebhookEndpointRequestSchema.shape.enabled

/** Whether an address has a user name or a password in front of its host. */
function carriesCredentials(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.username !== '' || parsed.password !== ''
  } catch {
    // Not an address a parser reads: the server's guard is the judge of that, not this file.
    return false
  }
}

const CREDENTIALS_MESSAGE =
  'must not carry a user name or a password (user:password@host): the server refuses such an address, and an address is printed in plans and logs'

const WebhookEndpoint = z.strictObject({
  // The server refuses credentials in an address when the endpoint is registered. Here they
  // are refused sooner: `tula diff` prints every address, into terminals and pipeline logs,
  // before the server is ever asked. Only in the file's schema, not the contract's: the API
  // answers such an address with its own error (`webhook.url_not_allowed`), which callers
  // of the API already rely on.
  url: WebhookAddress.refine((url) => !carriesCredentials(url), { message: CREDENTIALS_MESSAGE }),
  // A set: each type is checked where it was written, then repeats are dropped and the order
  // fixed, so that neither is a difference to `tula diff` or to the config's fingerprint.
  eventTypes: z
    .array(WebhookEventTypes.element)
    .transform((types) => [...new Set(types)].sort())
    .pipe(WebhookEventTypes),
  enabled: WebhookEnabled,
})

const Webhooks = z.array(WebhookEndpoint).superRefine((endpoints, context) => {
  if (endpoints.length > MAX_WEBHOOK_ENDPOINTS) {
    context.addIssue({
      code: 'custom',
      message: `an environment has at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints`,
    })
  }
  const firstAt = new Map<string, number>()
  endpoints.forEach((endpoint, index) => {
    const first = firstAt.get(endpoint.url)
    if (first === undefined) {
      firstAt.set(endpoint.url, index)
      return
    }
    // By position, never by value: an address may carry a token in its path or query.
    context.addIssue({
      code: 'custom',
      path: [index, 'url'],
      message: `the same address as webhooks.${first}: an endpoint is identified by its address, so each is listed once`,
    })
  })
})

// A hook's fields are the admin API's own (`POST /v1/admin/hooks`), with its defaults: a
// hook in the file is whole, so what an entry leaves out is what a registration that leaves
// it out gets (on, two seconds, refuse on failure). There is no point field: the key is the
// point. And no secret field: the server makes the secret.
const HookEntry = z.strictObject({
  // Refused here for the same reason as a webhook endpoint's: every address is printed.
  url: CreateHookRequestSchema.shape.url.refine((url) => !carriesCredentials(url), {
    message: CREDENTIALS_MESSAGE,
  }),
  enabled: CreateHookRequestSchema.shape.enabled,
  deadlineMs: CreateHookRequestSchema.shape.deadlineMs,
  failureMode: CreateHookRequestSchema.shape.failureMode,
})

// One key per point of the contract's `HOOK_POINTS`, and no other: an environment has at
// most one hook per point, so the point is what names a hook in the file.
const Hooks = z.strictObject({
  before_sign_up: HookEntry.optional(),
  before_session: HookEntry.optional(),
  before_token: HookEntry.optional(),
} satisfies Record<HookPoint, unknown>)

const Environment = z.strictObject({
  kind: z.enum(['development', 'production']).optional(),
  settings: EnvironmentSettingsInputSchema.prefault({}),
  providers: Providers.prefault({}),
  webhooks: Webhooks.optional(),
  hooks: Hooks.optional(),
})

const Config = z.strictObject({
  environments: z.record(z.string(), Environment).superRefine((environments, context) => {
    const names = Object.keys(environments)
    if (names.length === 0) {
      context.addIssue({ code: 'custom', message: 'at least one environment is needed' })
    }
    for (const name of names) {
      if (!ENVIRONMENT_NAME.test(name)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message:
            'an environment’s name is lowercase letters, digits and dashes, e.g. dev or prod',
        })
      }
    }
  }),
})

/**
 * The credentials of a provider that takes a client id and a client secret and nothing else
 * (Google, GitHub, Discord, LinkedIn), for one environment.
 *
 * @example
 * ```ts
 * const github: OAuthClientConfig = { clientId: 'Iv1.abc', clientSecret: env('GITHUB_CLIENT_SECRET') }
 * ```
 */
export interface OAuthClientConfig {
  /** The OAuth client id. Not a secret. */
  clientId: string
  /** The client secret, by reference: `env('NAME')`. */
  clientSecret: SecretRef
  /** Whether sign-in offers the provider. Defaults to `true`. */
  enabled?: boolean
}

/**
 * Apple's credentials for one environment.
 *
 * @example
 * ```ts
 * const apple: AppleProviderConfig = {
 *   clientId: 'app.northline.web',
 *   teamId: 'A1B2C3D4E5',
 *   keyId: 'K1L2M3N4O5',
 *   privateKey: env('APPLE_PRIVATE_KEY'),
 * }
 * ```
 */
export interface AppleProviderConfig {
  /** The Services ID. */
  clientId: string
  /** The developer team id. */
  teamId: string
  /** The id of the signing key. */
  keyId: string
  /** The `.p8` file's contents (PKCS#8 PEM), by reference: `env('NAME')`. */
  privateKey: SecretRef
  /** Whether sign-in offers the provider. Defaults to `true`. */
  enabled?: boolean
}

/**
 * Microsoft's credentials for one environment.
 *
 * @example
 * ```ts
 * const microsoft: MicrosoftProviderConfig = {
 *   clientId: '6731de76-14a6-49ae-97bc-6eba6914391e',
 *   clientSecret: env('MICROSOFT_CLIENT_SECRET'),
 *   tenant: 'organizations',
 * }
 * ```
 */
export interface MicrosoftProviderConfig {
  /** The application (client) id of the app registration. Not a secret. */
  clientId: string
  /** The client secret's value, by reference: `env('NAME')`. */
  clientSecret: SecretRef
  /**
   * Which Microsoft accounts may sign in: `common` (any), `organizations` (work and school
   * accounts), `consumers` (personal accounts) or one tenant's id. Not a secret. A domain
   * name is refused: a token names its tenant by id.
   */
  tenant: MicrosoftTenant
  /** Whether sign-in offers the provider. Defaults to `true`. */
  enabled?: boolean
}

/**
 * The OAuth providers of one environment. A provider left out is not managed by the file:
 * `tula apply` leaves it alone unless it is run with `--prune`.
 *
 * @example
 * ```ts
 * const providers: ProvidersConfig = { google: { clientId: 'g', clientSecret: env('GOOGLE_CLIENT_SECRET') } }
 * ```
 */
export interface ProvidersConfig {
  /** Google. */
  google?: OAuthClientConfig
  /** GitHub. */
  github?: OAuthClientConfig
  /** Sign in with Apple. */
  apple?: AppleProviderConfig
  /** Microsoft (Entra ID and personal accounts). */
  microsoft?: MicrosoftProviderConfig
  /** Discord. */
  discord?: OAuthClientConfig
  /** LinkedIn (Sign In with LinkedIn using OpenID Connect). */
  linkedin?: OAuthClientConfig
}

/**
 * One webhook endpoint of an environment: where its events are posted, and which.
 *
 * There is no field for the signing secret, on purpose: the server makes it and returns it
 * once, when `tula apply` registers the endpoint (`--secrets-file`, `--show-secrets`). A
 * `secret` key does not compile and is refused when the file is loaded.
 *
 * An endpoint has no name: it is **its address**. `tula` matches an entry to the server's
 * endpoint with exactly the same `url`, so changing the address means a new endpoint (a new
 * secret) and, with `--prune`, the removal of the old one.
 *
 * @example
 * ```ts
 * const endpoint: WebhookEndpointConfig = {
 *   url: 'https://api.northline.app/webhooks/tula',
 *   eventTypes: ['user.created', 'user.deleted'],
 * }
 * ```
 */
export interface WebhookEndpointConfig {
  /** Where events are posted: `https`, no credentials, a host the server may call. */
  url: string
  /** The event types delivered to it: a set, so order and repeats mean nothing. At least one. */
  eventTypes: ActivityType[]
  /**
   * Whether events are delivered. Left out, the switch is **not managed**: a new endpoint
   * starts switched on and an existing one is left as the server has it, including one the
   * server switched off because it kept failing. Written, `tula apply` sets it.
   */
  enabled?: boolean
}

/**
 * One hook of an environment: the address the server asks at a point, and what a call that
 * fails does.
 *
 * There is no field for the signing secret, on purpose: the server makes it and returns it
 * once, when `tula apply` registers the hook (`--secrets-file`, `--show-secrets`). A `secret`
 * key does not compile and is refused when the file is loaded.
 *
 * A hook is named by its **point** (the key it is written under), so a changed address is the
 * same hook with the same secret.
 *
 * @example
 * ```ts
 * const hook: HookConfig = { url: 'https://api.northline.app/hooks/sign-up', deadlineMs: 1500 }
 * ```
 */
export interface HookConfig {
  /** Where the question is posted: `https`, no credentials, a host the server may call. */
  url: string
  /** Whether the hook is asked. Defaults to `true`. Switching one off is a weakening. */
  enabled?: boolean
  /** How long the server waits for the answer, in milliseconds: 100 to 5000. Defaults to 2000. */
  deadlineMs?: number
  /**
   * What a call that fails does: `deny` (the default) refuses what was asked about, `allow`
   * lets it happen as if there were no hook. `allow` is a weakening: `tula diff` flags it and
   * `tula apply --yes` needs `--allow-weaker`.
   */
  failureMode?: HookFailureMode
}

/**
 * The hooks of one environment, by point. A point left out is not managed by the file:
 * `tula apply` leaves the server's hook for it alone unless it is run with `--prune`.
 *
 * @example
 * ```ts
 * const hooks: HooksConfig = { before_sign_up: { url: 'https://api.northline.app/hooks/sign-up' } }
 * ```
 */
export type HooksConfig = Partial<Record<HookPoint, HookConfig>>

/**
 * The settings document of one environment, as it is written in a config file: every field
 * optional. It is the body of `PUT /v1/admin/settings` (`EnvironmentSettingsInput`).
 *
 * @example
 * ```ts
 * const settings: EnvironmentSettingsConfig = { mfa: { policy: 'required' } }
 * ```
 */
export type EnvironmentSettingsConfig = z.input<typeof EnvironmentSettingsInputSchema>

/**
 * Which kind of environment an entry is for. `tula` refuses a secret key of the other kind
 * (`tula_sk_dev_…` against `production`), so a prod config is never applied with a dev key.
 *
 * @example
 * ```ts
 * const kind: EnvironmentKind = 'production'
 * ```
 */
export type EnvironmentKind = 'development' | 'production'

/**
 * One environment in a config file, as written.
 *
 * @example
 * ```ts
 * const dev: EnvironmentConfigInput = { kind: 'development', settings: { app: { name: 'Northline' } } }
 * ```
 */
export interface EnvironmentConfigInput {
  /** The kind of environment this entry is for; checked against the secret key. */
  kind?: EnvironmentKind
  /** The settings document. A field left out takes its default. */
  settings?: EnvironmentSettingsConfig
  /** The OAuth providers the file manages. */
  providers?: ProvidersConfig
  /**
   * The webhook endpoints. Left out, webhooks are **not managed** by the file: `tula` neither
   * reads nor changes them. Written (an empty list included), the list is what the
   * environment should have; an endpoint the server has and the list does not is left alone
   * and shown as unmanaged, and `tula apply --prune` removes it.
   */
  webhooks?: WebhookEndpointConfig[]
  /**
   * The hooks, by point. Left out, hooks are **not managed** by the file: `tula` neither reads
   * nor changes them. Written (an empty object included), a point with an entry is made what
   * the entry says; a hook the server has for a point without one is left alone and shown as
   * unmanaged, and `tula apply --prune` removes it.
   */
  hooks?: HooksConfig
}

/**
 * A config file's content, as written: what {@link defineConfig} takes.
 *
 * @example
 * ```ts
 * const config: TulaConfigInput = { environments: { dev: {}, prod: { kind: 'production' } } }
 * ```
 */
export interface TulaConfigInput {
  /** The environments the file describes, by the name `tula --env <name>` takes. */
  environments: Record<string, EnvironmentConfigInput>
}

/**
 * One environment of a validated config: defaults filled in.
 *
 * `settings.password` and `settings.urls.allowedOrigins` stay absent when the file leaves them
 * out: their defaults are the deployment's (`PASSWORD_POLICY`, `CORS_ORIGINS`), which only the
 * server knows.
 *
 * @example
 * ```ts
 * const environment: EnvironmentConfig = selectEnvironment(config, 'prod')
 * ```
 */
export interface EnvironmentConfig {
  /** The kind of environment this entry is for, when the file says. */
  kind?: EnvironmentKind
  /** The settings document. */
  settings: EnvironmentSettingsInput
  /** The providers the file manages. */
  providers: {
    google?: Required<OAuthClientConfig>
    github?: Required<OAuthClientConfig>
    apple?: Required<AppleProviderConfig>
    microsoft?: Required<MicrosoftProviderConfig>
    discord?: Required<OAuthClientConfig>
    linkedin?: Required<OAuthClientConfig>
  }
  /**
   * The webhook endpoints, when the file manages them: each address once, its event types
   * sorted and without repeats. Absent when the file does not mention webhooks.
   */
  webhooks?: WebhookEndpointConfig[]
  /**
   * The hooks, by point, when the file manages them: every field of each filled in. Absent
   * when the file does not mention hooks.
   */
  hooks?: Partial<Record<HookPoint, Required<HookConfig>>>
}

/**
 * A validated config.
 *
 * @example
 * ```ts
 * const { config } = await loadConfig('tula.config.ts')
 * Object.keys(config.environments) // ['dev', 'prod']
 * ```
 */
export interface TulaConfig {
  /** The environments, by name. */
  environments: Record<string, EnvironmentConfig>
}

/** `a.b.c` for an issue path, with the unknown keys of a strict object as one issue each. */
function toIssues(error: z.ZodError): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  for (const issue of error.issues) {
    const path = issue.path.map(String)
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        issues.push({ path: [...path, key].join('.'), message: 'unknown key' })
      }
    } else {
      issues.push({ path: path.join('.'), message: issue.message })
    }
  }
  return issues
}

/**
 * Validate a config.
 *
 * @param input - A config file's content, of unknown shape.
 * @returns The config with defaults filled in.
 * @throws ConfigError `config.invalid` listing every problem by its path.
 */
export function parseConfig(input: unknown): TulaConfig {
  const result = Config.safeParse(input)
  if (!result.success) {
    throw invalidConfig(toIssues(result.error))
  }
  return result.data as TulaConfig
}

/**
 * Define the config of a `tula.config.ts`.
 *
 * Typed, so an editor completes every setting, and validated with the contract's schemas, so a
 * mistake fails when the file is loaded and not half-way through an apply. Unknown keys are
 * errors (a misspelt `pasword` section would otherwise silently mean "the default policy").
 *
 * One file can describe several environments. The name is only a label: which environment a
 * run changes is decided by the secret key it is given (`tula diff --env prod` with
 * `TULA_SECRET_KEY`), and an entry's `kind` makes the CLI refuse a key of the other kind.
 *
 * @param config - The environments, each with its settings and providers.
 * @returns The validated config, defaults filled in.
 * @throws ConfigError `config.invalid` listing every problem by its path.
 *
 * @example
 * ```ts
 * import { defineConfig, env } from '@tula/config'
 *
 * export default defineConfig({
 *   environments: {
 *     prod: {
 *       kind: 'production',
 *       settings: {
 *         app: { name: 'Northline', supportEmail: 'help@northline.app' },
 *         signIn: { methods: { emailCode: { enabled: true } } },
 *         urls: { allowedOrigins: ['https://app.northline.app'] },
 *         mfa: { policy: 'required' },
 *       },
 *       providers: {
 *         google: { clientId: '1234.apps.googleusercontent.com', clientSecret: env('GOOGLE_CLIENT_SECRET') },
 *       },
 *     },
 *   },
 * })
 * ```
 */
export function defineConfig(config: TulaConfigInput): TulaConfig {
  return parseConfig(config)
}

/**
 * Pick one environment of a config by name.
 *
 * @param config - The validated config.
 * @param name - The environment's name; may be left out when the file has exactly one.
 * @returns The environment.
 * @throws ConfigError `config.environment_required` when the file has several and none was
 *   named, `config.environment_unknown` when the name is not in the file.
 *
 * @example
 * ```ts
 * const prod = selectEnvironment(config, 'prod')
 * ```
 */
export function selectEnvironment(config: TulaConfig, name: string | undefined): EnvironmentConfig {
  const names = Object.keys(config.environments)
  const chosen = name ?? (names.length === 1 ? names[0] : undefined)
  if (chosen === undefined) {
    throw new ConfigError(
      'config.environment_required',
      `The config has several environments (${names.join(', ')}): say which with --env <name>.`
    )
  }
  const environment = Object.hasOwn(config.environments, chosen)
    ? config.environments[chosen]
    : undefined
  if (!environment) {
    throw new ConfigError(
      'config.environment_unknown',
      `The config has no environment "${chosen}". It has: ${names.join(', ')}.`
    )
  }
  return environment
}

/**
 * Read a secret from the environment.
 *
 * @param ref - The reference from the config.
 * @param variables - The environment to read (`process.env`).
 * @returns The secret.
 * @throws ConfigError `config.secret_missing`, naming the variable, when it is unset or blank.
 *
 * @example
 * ```ts
 * const clientSecret = resolveSecret(provider.clientSecret, process.env)
 * ```
 */
export function resolveSecret(
  ref: SecretRef,
  variables: Readonly<Record<string, string | undefined>>
): string {
  const value = Object.hasOwn(variables, ref.$env) ? variables[ref.$env] : undefined
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      'config.secret_missing',
      `The environment variable ${ref.$env} is not set. It holds a secret the config refers to.`
    )
  }
  return value
}

/**
 * The environment variable each configured provider's secret is read from.
 *
 * @param providers - The providers of one environment.
 * @returns Provider → variable name, in provider-name order.
 *
 * @example
 * ```ts
 * requiredSecrets(environment.providers) // { google: 'GOOGLE_CLIENT_SECRET' }
 * ```
 */
export function requiredSecrets(
  providers: EnvironmentConfig['providers']
): Partial<Record<OAuthProvider, string>> {
  const names: Partial<Record<OAuthProvider, string>> = {}
  for (const provider of [...OAUTH_PROVIDERS].sort()) {
    const ref = providerSecret(providers, provider)
    if (ref) {
      names[provider] = ref.$env
    }
  }
  return names
}

/**
 * The secret reference of one provider in a config.
 *
 * @param providers - The providers of one environment.
 * @param provider - The provider.
 * @returns Its `privateKey` (Apple) or `clientSecret` (every other provider), or `undefined`
 *   when the file does not configure the provider.
 *
 * @example
 * ```ts
 * providerSecret(environment.providers, 'apple')?.$env // 'APPLE_PRIVATE_KEY'
 * ```
 */
export function providerSecret(
  providers: EnvironmentConfig['providers'],
  provider: OAuthProvider
): SecretRef | undefined {
  return provider === 'apple' ? providers.apple?.privateKey : providers[provider]?.clientSecret
}

/** The `<env>` segment of a secret key (`tula_sk_<env>_…`), by environment kind. */
const KEY_SEGMENT: Record<EnvironmentKind, string> = { development: 'dev', production: 'prod' }

/**
 * Whether a secret key is of the kind a config entry says it is for.
 *
 * A key carries its environment's kind in clear (`tula_sk_dev_…`, `tula_sk_prod_…`). This is a
 * guard against a mix-up, not a security check: the server alone decides what a key may do.
 *
 * @param kind - The entry's `kind`, or `undefined` when the file does not say.
 * @param secretKey - The secret key the run was given.
 * @returns `false` only when the entry names a kind and the key is of another.
 *
 * @example
 * ```ts
 * secretKeyMatchesKind('production', 'tula_sk_dev_…') // false
 * ```
 */
export function secretKeyMatchesKind(
  kind: EnvironmentKind | undefined,
  secretKey: string
): boolean {
  return kind === undefined || secretKey.startsWith(`tula_sk_${KEY_SEGMENT[kind]}_`)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * The environment as it is hashed: without the two defaults JWT templates added to every
 * settings document (no templates; a profile that names none).
 *
 * The fingerprint says which version of the file is applied. A field that every document
 * gained by upgrading must not change it, or each applied environment would report a new
 * version of a file nobody touched.
 */
function withoutUnusedTemplates(environment: EnvironmentConfig): unknown {
  const { sessions } = environment.settings
  const { jwtTemplates, ...rest } = sessions
  const profiles = Object.fromEntries(
    Object.entries(sessions.profiles).map(([name, profile]) => {
      const { jwtTemplate, ...limits } = profile
      return [name, jwtTemplate === null ? limits : profile]
    })
  )
  return {
    ...environment,
    settings: {
      ...environment.settings,
      sessions: {
        ...rest,
        profiles,
        ...(Object.keys(jwtTemplates).length > 0 && { jwtTemplates }),
      },
    },
  }
}

/**
 * A fingerprint of one environment's config: what `tula apply` records with the settings it
 * writes, so the dashboard and a later `tula diff` can say which version of the file is in
 * force.
 *
 * It covers the settings, the providers, the webhook endpoints and the hooks as written, with
 * each secret as the **name** of its variable: no secret value is hashed, so the fingerprint
 * reveals nothing about one. An endpoint's event types count as a set, and an environment
 * that does not mention webhooks or hooks hashes as it did before they could be written (a
 * hook's defaults count as written). So does one
 * that defines no JWT template and whose profiles name none; the order templates and their
 * claims are written in never counts.
 *
 * @param environment - The environment's validated config.
 * @returns `sha256:` and 64 hex characters. The same for the same content in any key order.
 *
 * @example
 * ```ts
 * await hashEnvironmentConfig(selectEnvironment(config, 'prod')) // 'sha256:9f2c…'
 * ```
 */
export async function hashEnvironmentConfig(environment: EnvironmentConfig): Promise<string> {
  const text = JSON.stringify(canonical(withoutUnusedTemplates(environment)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}
