import { S, type Shape } from './sanitize'

const ENABLED = S.object({ enabled: S.boolean })

const SESSION_PROFILE = S.object({
  type: S.string(20),
  accessTokenTtl: S.string(20),
  idleTimeout: S.string(20),
  absoluteTimeout: S.string(20),
  stepUpAfter: S.string(20),
  clientSelectable: S.boolean,
  // `none`, `optional` or `required`: a closed word of the settings, not a key.
  deviceBinding: S.string(20),
  refresh: S.object({ reuseGracePeriod: S.string(20) }),
})

/**
 * What a tool may return of an environment's settings document: the one allow-list of
 * settings. `get_settings` returns exactly these fields, and `draft_settings_change`
 * drafts an edit for these and no other (ADR 0056): a setting that is not named here cannot
 * be read through a tool and cannot be put into a config edit by one.
 *
 * Not named, on purpose: an email's and a text message's wording (`emails`,
 * `sms.templates`: long free text an operator wrote, ADR 0039 and ADR 0042) and the JWT
 * templates (`sessions.jwtTemplates`, with a profile's `jwtTemplate`: a claim's key says
 * what an application authorizes on, ADR 0036).
 *
 * @example
 * ```ts
 * project(document, SETTINGS_DOCUMENT_SHAPE) // the named settings, cleaned and capped
 * ```
 */
export const SETTINGS_DOCUMENT_SHAPE: Shape = S.object({
  version: S.number,
  app: S.object({ name: S.string(200), supportEmail: S.string(320) }),
  password: S.object({
    preset: S.string(20),
    minLength: S.number,
    maxLength: S.number,
    requireLowercase: S.boolean,
    requireUppercase: S.boolean,
    requireNumber: S.boolean,
    requireSpecial: S.boolean,
    minCharacterClasses: S.number,
    specialChars: S.string(100),
    disallowUserInfo: S.boolean,
    disallowCommon: S.boolean,
    breachCheck: S.string(20),
    maxRepeatedChars: S.number,
    blockSequences: S.boolean,
    history: S.number,
    expiryDays: S.number,
  }),
  signIn: S.object({
    methods: S.object({
      password: ENABLED,
      emailCode: ENABLED,
      emailLink: ENABLED,
      passkey: ENABLED,
      smsCode: ENABLED,
    }),
  }),
  signUp: S.object({ password: S.string(20) }),
  urls: S.object({
    allowedOrigins: S.array(S.string(300), 50),
    allowedRedirectUrls: S.array(S.string(300), 50),
  }),
  audit: S.object({ retentionDays: S.number }),
  notifications: S.object({
    passwordChanged: S.boolean,
    newSignIn: S.boolean,
    mfaChanged: S.boolean,
    identityChanged: S.boolean,
  }),
  mfa: S.object({ policy: S.string(20), smsCode: ENABLED }),
  // Two-letter country codes, at most as many as there are countries; the most messages a day.
  // Not `templates`: a message's wording is long free text an operator wrote (ADR 0042).
  sms: S.object({
    enabled: S.boolean,
    allowedCountries: S.array(S.string(2), 100),
    dailyMessageLimit: S.number,
  }),
  passkeys: S.object({ rpId: S.string(253) }),
  // Whether a production environment accepts an agent's proposals (ADR 0053). A boolean, so
  // that a tool refused with `production_environment` can say why; switching it on is a
  // person's change, and a weakening wherever it is drafted or applied.
  agents: S.object({ proposalsInProduction: S.boolean }),
  sessions: S.object({
    profiles: S.record(SESSION_PROFILE, 20),
    maxPerUser: S.number,
    onLimit: S.string(20),
  }),
})

/**
 * Who manages an environment's settings from a config file, as a tool returns it.
 * Without `configHash`: it identifies a config file's contents and tells a reader nothing.
 *
 * @example
 * ```ts
 * project(answer.managedBy, MANAGED_BY_SHAPE) // { tool, at, revision, drifted } or null
 * ```
 */
export const MANAGED_BY_SHAPE: Shape = S.object({
  tool: S.string(80),
  at: S.string(40),
  revision: S.number,
  drifted: S.boolean,
})

/**
 * What `get_settings` returns of the admin API's answer: the revision, the named settings
 * and who manages them.
 *
 * @example
 * ```ts
 * project(await reads.read('getEnvironmentSettings'), SETTINGS_SHAPE)
 * ```
 */
export const SETTINGS_SHAPE: Shape = S.object({
  revision: S.number,
  settings: SETTINGS_DOCUMENT_SHAPE,
  managedBy: MANAGED_BY_SHAPE,
})

/**
 * What a tool may return of an OAuth provider, as the admin API lists it.
 *
 * `clientId`, `teamId` and `keyId` are public identifiers the provider's own console shows,
 * and Microsoft's `tenant` is an alias or a tenant id every one of its tokens carries.
 * Google's `additionalClientIds` (ADR 0045) are the client ids of the operator's native
 * apps: as public as `clientId` (each is in every ID token made for it), at most eight.
 * The client secret and Apple's private key are write-only in the API and are not named here.
 *
 * @example
 * ```ts
 * project(provider, OAUTH_PROVIDER_SHAPE) // never a secret: none is named
 * ```
 */
export const OAUTH_PROVIDER_SHAPE: Shape = S.object({
  provider: S.string(40),
  configured: S.boolean,
  enabled: S.boolean,
  clientId: S.string(300),
  teamId: S.string(40),
  keyId: S.string(40),
  tenant: S.string(40),
  additionalClientIds: S.array(S.string(128), 8),
  callbackUrl: S.string(500),
  updatedAt: S.string(40),
})
