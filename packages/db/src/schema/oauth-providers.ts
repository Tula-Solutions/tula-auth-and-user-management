import { boolean, jsonb, text, unique } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints } from '../tenant-columns'
import { tula } from './pg-schema'

/** The OAuth providers an environment can configure (ADR 0026). */
export const OAUTH_PROVIDERS = [
  'google',
  'github',
  'apple',
  'microsoft',
  'discord',
  'linkedin',
  'x',
  'facebook',
] as const

/** What a provider needs besides a client id and a secret. Never a secret itself. */
export interface OAuthProviderConfig {
  /** Apple: the developer team id (the `iss` of the client-secret JWT). */
  teamId?: string
  /** Apple: the id of the key the client-secret JWT is signed with. */
  keyId?: string
  /** Microsoft: which accounts may sign in (`common`, `organizations`, `consumers`, a tenant id). */
  tenant?: string
  /**
   * Google: the client ids of the operator's native apps, whose ID tokens a native sign-in
   * accepts beside `client_id`'s (ADR 0045). Sorted, without repeats. Read tolerantly: an
   * entry that is not a client id is not an accepted audience.
   */
  additionalClientIds?: string[]
}

/**
 * An environment's own credentials for one OAuth provider (ADR 0026).
 *
 * One row per environment and provider. `secret` is the provider's secret material (a client
 * secret, or Apple's private key) sealed with AES-256-GCM under `TULA_MASTER_KEY` and bound to
 * the environment and the provider, so a ciphertext copied to another row does not decrypt. It
 * is never returned by any API. `client_id`, `config` and `enabled` are not secrets.
 *
 * No provider access or refresh token is ever stored: there is no column for one.
 */
export const oauthProviders = tula.table(
  'oauth_providers',
  {
    id: primaryKey(),
    ...tenantColumns(),
    provider: text('provider', { enum: OAUTH_PROVIDERS }).notNull(),
    clientId: text('client_id').notNull(),
    secret: text('secret').notNull(),
    config: jsonb('config').$type<OAuthProviderConfig>().notNull().default({}),
    /** A configured provider is offered at sign-in only while this is on. */
    enabled: boolean('enabled').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('oauth_providers_environment_provider_key').on(t.environmentId, t.provider),
    ...tenantConstraints('oauth_providers', t),
  ]
)

/** An OAuth provider row. */
export type OAuthProviderRow = typeof oauthProviders.$inferSelect
/** Insert shape for an OAuth provider. */
export type NewOAuthProviderRow = typeof oauthProviders.$inferInsert
