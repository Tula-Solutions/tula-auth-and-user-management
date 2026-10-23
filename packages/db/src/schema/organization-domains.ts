import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from '../mixins'
import { tenantColumns, tenantConstraints, tenantForeignKey } from '../tenant-columns'
import { organizations } from './organizations'
import { tula } from './pg-schema'

/** What a verified domain does for a user who signs up with a verified address on it. */
export const ORGANIZATION_DOMAIN_MODES = ['suggest', 'auto_join'] as const

/**
 * A domain an organization claims (ADR 0065, "Verified domains").
 *
 * A row is **pending** until the code emailed to an address on the domain is entered:
 * `verified_at` is null and the row holds the code's keyed hash (`code_hash`, never the code),
 * when it stops working and how many guesses it has had. A pending row grants nothing. Entering
 * the code sets `verified_at` and `expires_at` and clears the code in one statement
 * (`..._state`: a pending row always has a code, and `expires_at` is set exactly when
 * `verified_at` is).
 *
 * **A verification lapses** (migration 0042, ADR 0065 "Lapse"): from `expires_at` on, the row
 * matches nobody; it is not deleted, so a manager verifies it again. Re-verifying a verified
 * row stores a new code beside `verified_at` (the row keeps matching until it lapses) and
 * entering it moves both dates. `reminded_days` is the smallest reminder threshold the
 * managers were emailed for since the last verification (null: none), so each is sent once.
 *
 * **A domain is verified for one organization per environment**:
 * `organization_domains_verified_domain_key` is a unique index over the verified rows only, so
 * any number of organizations may have a pending claim on a name, and of two verifications at
 * once the database lets one succeed. `organization_domains_organization_domain_key` keeps
 * one row per organization and name.
 *
 * `domain` is held to the contract's grammar by the database (`..._domain_shape`: lower-case
 * ASCII labels, the last one letters or punycode). The public-domain list is the contract's and
 * the API's: a rule that changes does not belong in a migration.
 *
 * Rows go with their organization by cascade. The retention job deletes pending rows whose
 * code expired. The runtime role may change `mode`, the code columns, `verified_at`,
 * `expires_at`, `reminded_days` and `updated_at` only.
 */
export const organizationDomains = tula.table(
  'organization_domains',
  {
    id: primaryKey(),
    ...tenantColumns(),
    organizationId: uuid('organization_id').notNull(),
    domain: text('domain').notNull(),
    mode: text('mode', { enum: ORGANIZATION_DOMAIN_MODES }).notNull(),
    /** When the code was entered; null while the claim is pending. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** When the verification lapses; null while the claim is pending. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Days-before-lapse of the last reminder sent for this verification; null: none yet. */
    remindedDays: integer('reminded_days'),
    /** HMAC of the emailed code (see `~/lib/keyed-hash`); null when no code is waiting. */
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    /** Guesses made at the current code; reset with the code. */
    codeAttempts: integer('code_attempts').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    unique('organization_domains_organization_domain_key').on(t.organizationId, t.domain),
    // The rule that makes a domain one organization's: among verified rows only.
    uniqueIndex('organization_domains_verified_domain_key')
      .on(t.environmentId, t.domain)
      .where(sql`${t.verifiedAt} is not null`),
    tenantForeignKey('organization_domains_organization_fk', t, t.organizationId, organizations),
    index('organization_domains_organization_idx').on(t.environmentId, t.organizationId),
    // What the retention job scans.
    index('organization_domains_pending_expiry_idx')
      .on(t.codeExpiresAt)
      .where(sql`${t.verifiedAt} is null`),
    check(
      'organization_domains_domain_shape',
      sql`char_length(${t.domain}) between 4 and 253 and ${t.domain} ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+([a-z]{2,}|xn--[a-z0-9-]*[a-z0-9])$'`
    ),
    check('organization_domains_mode_known', sql`${t.mode} in ('suggest', 'auto_join')`),
    // What the reminder job scans: verified rows by deadline.
    index('organization_domains_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.verifiedAt} is not null`),
    check(
      'organization_domains_state',
      sql`(${t.verifiedAt} is null) = (${t.expiresAt} is null) and (${t.verifiedAt} is not null or ${t.codeHash} is not null) and (${t.codeHash} is null) = (${t.codeExpiresAt} is null)`
    ),
    check('organization_domains_reminded', sql`${t.remindedDays} is null or ${t.remindedDays} > 0`),
    check('organization_domains_attempts', sql`${t.codeAttempts} >= 0`),
    ...tenantConstraints('organization_domains', t),
  ]
)

/** A domain row. */
export type OrganizationDomainRow = typeof organizationDomains.$inferSelect
/** Insert shape for a domain. */
export type NewOrganizationDomainRow = typeof organizationDomains.$inferInsert
