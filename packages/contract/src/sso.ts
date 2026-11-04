// Enterprise single sign-on (ADR 0067). Zod-free: the closed lists an SDK, the dashboard and
// the audit events share. A connection belongs to an organization and is bound to some of the
// organization's verified domains; only an `active` one signs anybody in.

/**
 * Where a connection is in its life. A `draft` is being set up, an `active` one signs users in
 * and a `disabled` one is kept (its identities stay) but offered to nobody.
 *
 * @example
 * ```ts
 * const status: SsoConnectionStatus = SSO_CONNECTION_STATUSES[0] // 'draft'
 * ```
 */
export const SSO_CONNECTION_STATUSES = ['draft', 'active', 'disabled'] as const

/** One of {@link SSO_CONNECTION_STATUSES}. */
export type SsoConnectionStatus = (typeof SSO_CONNECTION_STATUSES)[number]

/** The protocols a connection can speak. */
export const SSO_PROTOCOLS = ['oidc', 'saml'] as const

/** One of {@link SSO_PROTOCOLS}. */
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number]

/** The fields of a connection an update can change; the event names them, never a value. */
export const SSO_CONNECTION_FIELDS = [
  'name',
  'issuer',
  'clientId',
  'clientSecret',
  'saml',
  'defaultRole',
  'enforced',
  'breakGlassRole',
  'trustIdpMfa',
  'domains',
  'status',
  'attributeMapping',
  'groupRoles',
  'test',
] as const

/** One of {@link SSO_CONNECTION_FIELDS}. */
export type SsoConnectionField = (typeof SSO_CONNECTION_FIELDS)[number]

/** How many domains one connection can be bound to. */
export const MAX_SSO_CONNECTION_DOMAINS = 20

/** How many signing certificates a SAML connection holds: the current one and the next. */
export const MAX_SAML_CERTIFICATES = 2

/** How many IdP groups one organization can map to roles. */
export const MAX_SSO_GROUP_ROLES = 100
