// How an identity provider's attributes (SAML) and claims (OIDC) become a profile.
// Zod-free: the names are shared by the API, the dashboard and the docs.
import type { SsoProtocol } from './sso'

/** The identity providers whose default attribute names are built in. */
export const SSO_IDP_PRESETS = [
  'okta',
  'entra',
  'google_workspace',
  'jumpcloud',
  'onelogin',
  'ping',
  'generic',
] as const

/** One of {@link SSO_IDP_PRESETS}; `generic` is "generic SAML" or "generic OIDC" by protocol. */
export type SsoIdpPreset = (typeof SSO_IDP_PRESETS)[number]

/** The names an operator can override; each is one attribute or claim name. */
export interface SsoAttributeMapping {
  idp?: SsoIdpPreset
  email?: string
  firstName?: string
  lastName?: string
  groups?: string
}

/** The attribute or claim names read for each field, first one present wins. */
export interface SsoAttributeNames {
  email: string[]
  firstName: string[]
  lastName: string[]
  groups: string[]
}

const CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims'
const MS_GROUPS = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups'

const OIDC_STANDARD = { email: ['email'], firstName: ['given_name'], lastName: ['family_name'] }

/**
 * The default names per protocol and identity provider. An IdP lets its administrator name
 * SAML attributes freely, so these are the names its own documentation suggests; a connection
 * overrides any of them.
 */
export const SSO_ATTRIBUTE_DEFAULTS: Record<
  SsoProtocol,
  Record<SsoIdpPreset, SsoAttributeNames>
> = {
  saml: {
    okta: {
      email: ['email'],
      firstName: ['firstName'],
      lastName: ['lastName'],
      groups: ['groups'],
    },
    entra: {
      email: [`${CLAIM}/emailaddress`],
      firstName: [`${CLAIM}/givenname`],
      lastName: [`${CLAIM}/surname`],
      groups: [MS_GROUPS],
    },
    google_workspace: {
      email: ['email'],
      firstName: ['firstName'],
      lastName: ['lastName'],
      groups: ['groups'],
    },
    jumpcloud: {
      email: ['email'],
      firstName: ['firstname'],
      lastName: ['lastname'],
      groups: ['memberOf'],
    },
    onelogin: {
      email: ['User.email'],
      firstName: ['User.FirstName'],
      lastName: ['User.LastName'],
      groups: ['memberOf'],
    },
    ping: { email: ['mail'], firstName: ['givenName'], lastName: ['sn'], groups: ['memberOf'] },
    generic: {
      email: ['email', 'mail', `${CLAIM}/emailaddress`, 'urn:oid:0.9.2342.19200300.100.1.3'],
      firstName: ['givenName', 'firstName', `${CLAIM}/givenname`],
      lastName: ['sn', 'surname', 'lastName', `${CLAIM}/surname`],
      groups: ['groups', 'memberOf', MS_GROUPS],
    },
  },
  oidc: {
    okta: { ...OIDC_STANDARD, groups: ['groups'] },
    entra: { ...OIDC_STANDARD, groups: ['groups'] },
    google_workspace: { ...OIDC_STANDARD, groups: ['groups'] },
    jumpcloud: { ...OIDC_STANDARD, groups: ['groups'] },
    onelogin: { ...OIDC_STANDARD, groups: ['groups'] },
    ping: { ...OIDC_STANDARD, groups: ['memberOf'] },
    generic: { ...OIDC_STANDARD, groups: ['groups'] },
  },
}

/**
 * The names a connection reads: its preset's defaults (the protocol's generic ones when it has
 * none), each replaced by the connection's own override.
 *
 * @param protocol - The connection's protocol.
 * @param mapping - The connection's mapping, or `null`.
 * @returns The names to read for each field.
 */
export function effectiveAttributeNames(
  protocol: SsoProtocol,
  mapping: SsoAttributeMapping | null
): SsoAttributeNames {
  const base = SSO_ATTRIBUTE_DEFAULTS[protocol][mapping?.idp ?? 'generic']
  return {
    email: mapping?.email ? [mapping.email] : base.email,
    firstName: mapping?.firstName ? [mapping.firstName] : base.firstName,
    lastName: mapping?.lastName ? [mapping.lastName] : base.lastName,
    groups: mapping?.groups ? [mapping.groups] : base.groups,
  }
}
