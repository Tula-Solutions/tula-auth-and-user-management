import type { Recorded } from '~/ports/activity-log'

/** Where a connection is in its life: only an `active` one signs anybody in (ADR 0067). */
export type SsoConnectionStatus = 'draft' | 'active' | 'disabled'

/** An organization's single sign-on connection as stored. */
export interface SsoConnectionRecord {
  id: string
  projectId: string
  environmentId: string
  organizationId: string
  protocol: 'oidc'
  name: string
  status: SsoConnectionStatus
  issuer: string
  clientId: string
  /** Sealed with the secret box; no route returns it. */
  clientSecretSealed: string
  /** The role key given to a user this connection provisions. */
  defaultRole: string
  /** Enforced: an identifier on the domains is offered `sso` only (TULA-140). */
  enforced: boolean
  /** The organization role whose members keep their other methods under enforcement, or `null`. */
  breakGlassRole: string | null
  /** Whether the identity provider's own MFA stands in for Tula's second step. */
  trustIdpMfa: boolean
  /** The verified domains of the organization this connection is bound to, sorted. */
  domains: string[]
  createdAt: Date
  updatedAt: Date
}

/** The fields of a connection an update may change; one left out keeps its value. */
export interface SsoConnectionChanges {
  name?: string
  issuer?: string
  clientId?: string
  clientSecretSealed?: string
  defaultRole?: string
  enforced?: boolean
  breakGlassRole?: string | null
  trustIdpMfa?: boolean
  /** The whole new set of bound domains. */
  domains?: string[]
  status?: SsoConnectionStatus
}

/** Why an update wrote nothing. */
export type SsoWriteRefusal = 'missing' | 'name_taken' | 'domain_taken'

/** A user's account at a connection's provider. */
export interface SsoIdentityRecord {
  connectionId: string
  userId: string
  subject: string
}

/**
 * SSO connections, their domain bindings and their identities, always inside one environment.
 *
 * The database decides the two races: a name is one per organization, and a domain belongs to
 * at most one **active** connection (`domain_taken`).
 */
export interface SsoConnectionStore {
  /**
   * @param environmentId - The environment.
   * @param organizationId - The organization whose connections to list.
   * @returns Its connections, oldest first.
   */
  list(environmentId: string, organizationId: string): Promise<SsoConnectionRecord[]>

  /**
   * @param environmentId - The environment.
   * @param id - The connection.
   * @returns The connection, or `null` when this environment has none with that id.
   */
  find(environmentId: string, id: string): Promise<SsoConnectionRecord | null>

  /**
   * @param environmentId - The environment.
   * @param domain - A lower-case domain.
   * @returns The one **active** connection bound to the domain, or `null`.
   */
  findActiveByDomain(environmentId: string, domain: string): Promise<SsoConnectionRecord | null>

  /**
   * Store a new connection; a draft binds its domains without claiming them.
   *
   * @param record - The connection.
   * @param activity - Recorded in the same transaction, only if the connection was stored.
   * @returns The connection as stored, or `name_taken` / `domain_taken`.
   */
  insert(
    record: SsoConnectionRecord,
    activity: Recorded
  ): Promise<SsoConnectionRecord | 'name_taken' | 'domain_taken'>

  /**
   * Change a connection; a domain set or a status change is judged by the database's
   * one-active-connection-per-domain rule.
   *
   * @param environmentId - The environment.
   * @param id - The connection.
   * @param changes - The fields to set.
   * @param updatedAt - When the change is made.
   * @param activity - Recorded in the same transaction, only if the row was written.
   * @returns The connection as it is now, or why nothing was written.
   */
  update(
    environmentId: string,
    id: string,
    changes: SsoConnectionChanges,
    updatedAt: Date,
    activity: Recorded
  ): Promise<SsoConnectionRecord | SsoWriteRefusal>

  /**
   * Remove a connection that no one has signed in through.
   *
   * @param environmentId - The environment.
   * @param id - The connection.
   * @param activity - Recorded in the same transaction, only if something was removed.
   * @returns `deleted`, `missing`, or `in_use` when an identity exists (disable it instead).
   */
  delete(
    environmentId: string,
    id: string,
    activity: Recorded
  ): Promise<'deleted' | 'missing' | 'in_use'>

  /**
   * @param environmentId - The environment.
   * @param connectionId - The connection.
   * @param subject - The provider's `sub`.
   * @returns The identity, or `null`.
   */
  findIdentity(
    environmentId: string,
    connectionId: string,
    subject: string
  ): Promise<SsoIdentityRecord | null>

  /**
   * Remember that a user is this subject at this connection.
   *
   * @param environmentId - The environment.
   * @param identity - The pair to store.
   * @param at - When it is stored.
   * @param recorded - The audit entry written in the same transaction (`user.sso_linked`).
   * @returns `false` when the subject, or the user at this connection, already has one.
   */
  linkIdentity(
    environmentId: string,
    identity: SsoIdentityRecord,
    at: Date,
    recorded: Recorded
  ): Promise<boolean>
}
