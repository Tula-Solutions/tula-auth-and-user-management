import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import {
  tenantColumns,
  tenantConstraints,
  tenantForeignKey,
  tenantParentKey,
} from '../tenant-columns'
import { organizations } from './organizations'
import { tula } from './pg-schema'
import { users } from './users'

/** Where a connection is in its life (ADR 0067): only an `active` one signs anybody in. */
export const SSO_CONNECTION_STATUSES = ['draft', 'active', 'disabled'] as const

/** The protocols a connection can speak. */
export const SSO_PROTOCOLS = ['oidc', 'saml'] as const

/**
 * An organization's enterprise single sign-on connection (ADR 0067).
 *
 * The client secret is sealed with the secret box (`client_secret_sealed`, bound to the
 * connection and environment) and never read back out by a route. Enforcement, break-glass
 * and MFA trust (TULA-140) are columns to add here later; nothing reads a column that is not
 * declared.
 */
export const ssoConnections = tula.table(
  'sso_connections',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    protocol: text('protocol', { enum: SSO_PROTOCOLS }).notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: SSO_CONNECTION_STATUSES }).notNull().default('draft'),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    /** Sealed with `~/lib/secret-box`; never returned by a route. */
    clientSecretSealed: text('client_secret_sealed').notNull(),
    /**
     * A SAML connection's identity provider values: entity id, SSO URL, metadata URL and up to
     * two signing certificates with the expiry of each. `null` for an OIDC connection. A SAML
     * row keeps `issuer` as the entity id and `''` in the two client columns.
     */
    saml: jsonb('saml').$type<{
      idpEntityId: string
      ssoUrl: string
      metadataUrl: string | null
      certificates: { pem: string; notAfter: string }[]
    }>(),
    /** The role key a user provisioned by this connection gets in the organization. */
    defaultRole: text('default_role').notNull(),
    /**
     * Fingerprint of the settings a passing test sign-in ran against (TULA-145). A connection
     * can be activated only while its current settings hash to this, so any change to them
     * is a reset with nothing to clear.
     */
    testedFingerprint: text('tested_fingerprint'),
    ...timestamps(),
  },
  (t) => [
    unique('sso_connections_organization_name_key').on(t.organizationId, t.name),
    tenantForeignKey('sso_connections_organization_fk', t, t.organizationId, organizations),
    index('sso_connections_organization_idx').on(t.environmentId, t.organizationId),
    check('sso_connections_status_known', sql`${t.status} in ('draft', 'active', 'disabled')`),
    check('sso_connections_protocol_known', sql`${t.protocol} in ('oidc', 'saml')`),
    check('sso_connections_saml_iff_saml', sql`(${t.protocol} = 'saml') = (${t.saml} is not null)`),
    check('sso_connections_name_bounds', sql`char_length(${t.name}) between 1 and 100`),
    tenantParentKey('sso_connections', t),
    ...tenantConstraints('sso_connections', t),
  ]
)

/**
 * A domain bound to a connection: an identifier on it is offered the connection's sign-in.
 *
 * `active` is a copy of the connection being active, kept by the store in the statement that
 * changes the connection, so that `sso_connection_domains_active_domain_key` can make a
 * domain one active connection's in the database: of two activations at once, one fails.
 */
export const ssoConnectionDomains = tula.table(
  'sso_connection_domains',
  {
    id: primaryKey(),
    ...tenantColumns(),
    connectionId: uuid('connection_id').notNull(),
    domain: text('domain').notNull(),
    active: boolean('active').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique('sso_connection_domains_connection_domain_key').on(t.connectionId, t.domain),
    uniqueIndex('sso_connection_domains_active_domain_key')
      .on(t.environmentId, t.domain)
      .where(sql`${t.active}`),
    tenantForeignKey('sso_connection_domains_connection_fk', t, t.connectionId, ssoConnections),
    ...tenantConstraints('sso_connection_domains', t),
  ]
)

/** A user's account at a connection's identity provider: unique on (connection, subject). */
export const ssoIdentities = tula.table(
  'sso_identities',
  {
    id: primaryKey(),
    ...tenantColumns(),
    connectionId: uuid('connection_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** The provider's `sub`. */
    subject: text('subject').notNull(),
    lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique('sso_identities_connection_subject_key').on(t.connectionId, t.subject),
    unique('sso_identities_connection_user_key').on(t.connectionId, t.userId),
    tenantForeignKey('sso_identities_connection_fk', t, t.connectionId, ssoConnections),
    tenantForeignKey('sso_identities_user_fk', t, t.userId, users),
    index('sso_identities_user_idx').on(t.environmentId, t.userId),
    ...tenantConstraints('sso_identities', t),
  ]
)

/** A connection row. */
export type SsoConnectionRow = typeof ssoConnections.$inferSelect
/** A connection's domain row. */
export type SsoConnectionDomainRow = typeof ssoConnectionDomains.$inferSelect
/** An SSO identity row. */
export type SsoIdentityRow = typeof ssoIdentities.$inferSelect
