import { z } from 'zod'
import { RoleKeySchema } from './organization'
import { OrganizationDomainNameSchema } from './organization-domain'
import {
  MAX_SAML_CERTIFICATES,
  MAX_SSO_CONNECTION_DOMAINS,
  MAX_SSO_GROUP_ROLES,
  SSO_CONNECTION_STATUSES,
  SSO_PROTOCOLS,
} from './sso'
import { SSO_IDP_PRESETS } from './sso-attributes'

// The admin API's shapes for an enterprise connection (ADR 0067). The client secret is
// accepted on create and update and never returned: the view says only that one is set.

const Domains = z.array(OrganizationDomainNameSchema).max(MAX_SSO_CONNECTION_DOMAINS)

/** An `https` address: the issuer of an OIDC connection. Whether it may be called is checked on save. */
const IssuerSchema = z.url({ protocol: /^https?$/ }).max(2048)

/**
 * The identity provider values of a SAML connection, given in one of three ways: the IdP's
 * metadata XML pasted (`metadataXml`), a metadata address the server fetches (`metadataUrl`),
 * or by hand (`idpEntityId`, `ssoUrl` and one or two `certificates`, PEM or bare base64).
 * Whether exactly one way was used is checked by the service (`sso.saml_invalid`).
 */
export const SamlSettingsInputSchema = z
  .strictObject({
    metadataXml: z
      .string()
      .min(1)
      .max(512 * 1024)
      .optional(),
    metadataUrl: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .optional(),
    idpEntityId: z.string().min(1).max(1024).optional(),
    ssoUrl: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .optional(),
    certificates: z
      .array(
        z
          .string()
          .min(1)
          .max(16 * 1024)
      )
      .min(1)
      .max(MAX_SAML_CERTIFICATES)
      .optional(),
  })
  .meta({ ref: 'SamlSettingsInput' })

/** Which attribute or claim carries each field; one left out uses the IdP preset's default. */
export const SsoAttributeMappingSchema = z
  .strictObject({
    idp: z.enum(SSO_IDP_PRESETS).optional(),
    email: z.string().trim().min(1).max(512).optional(),
    firstName: z.string().trim().min(1).max(512).optional(),
    lastName: z.string().trim().min(1).max(512).optional(),
    groups: z.string().trim().min(1).max(512).optional(),
  })
  .meta({ ref: 'SsoAttributeMapping' })

/**
 * An organization's IdP group to role mapping. The order is the precedence: a user in several
 * mapped groups gets the role of the first of their groups in this list (ADR 0067).
 */
export const SsoGroupRolesSchema = z
  .strictObject({
    mappings: z
      .array(z.strictObject({ group: z.string().min(1).max(256), role: RoleKeySchema }))
      .max(MAX_SSO_GROUP_ROLES),
  })
  .meta({ ref: 'SsoGroupRoles' })

/** The group to role mapping of an organization. */
export type SsoGroupRoles = z.infer<typeof SsoGroupRolesSchema>

/**
 * The mapping as a setup link's portal sees it: `locked` marks a mapping to a role with a
 * system permission (`org:sys:*`), which the portal shows and cannot change (ADR 0067).
 */
export const SetupGroupRolesSchema = z
  .strictObject({
    mappings: z.array(
      z.strictObject({
        group: z.string().min(1).max(256),
        role: RoleKeySchema,
        locked: z.boolean(),
      })
    ),
  })
  .meta({ ref: 'SetupGroupRoles' })

/** The group to role mapping as a setup link's portal sees it. */
export type SetupGroupRoles = z.infer<typeof SetupGroupRolesSchema>

/** The body that creates a connection, as a draft. An OIDC one takes `issuer`, `clientId` and `clientSecret`; a SAML one `saml`. */
export const CreateSsoConnectionRequestSchema = z
  .strictObject({
    organizationId: z.uuid(),
    protocol: z.enum(SSO_PROTOCOLS).default('oidc'),
    name: z.string().trim().min(1).max(100),
    issuer: IssuerSchema.optional(),
    clientId: z.string().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(4096).optional(),
    saml: SamlSettingsInputSchema.optional(),
    attributeMapping: SsoAttributeMappingSchema.optional(),
    defaultRole: RoleKeySchema.default('member'),
    domains: Domains.default([]),
  })
  .meta({ ref: 'CreateSsoConnectionRequest' })

/**
 * The body a signed-in organization admin creates a connection with: the admin body without
 * `organizationId`, which is the organization of the path (a client cannot name another).
 */
export const CreateMySsoConnectionRequestSchema = CreateSsoConnectionRequestSchema.omit({
  organizationId: true,
}).meta({ ref: 'CreateMySsoConnectionRequest' })

/** The body that changes a connection: every field is optional and an absent one is kept. */
export const UpdateSsoConnectionRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    issuer: IssuerSchema,
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    saml: SamlSettingsInputSchema,
    attributeMapping: SsoAttributeMappingSchema,
    defaultRole: RoleKeySchema,
    enforced: z.boolean(),
    breakGlassRole: RoleKeySchema.nullable(),
    trustIdpMfa: z.boolean(),
    domains: Domains,
    status: z.enum(SSO_CONNECTION_STATUSES),
  })
  .partial()
  .meta({ ref: 'UpdateSsoConnectionRequest' })

/** A SAML connection's identity provider values and the service provider values to give the IdP. */
export const SamlConnectionViewSchema = z
  .object({
    idpEntityId: z.string(),
    ssoUrl: z.string(),
    metadataUrl: z.string().nullable(),
    /** The signing certificates, each with its expiry, so a coming one can be rotated in. */
    certificates: z.array(
      z.object({ fingerprint: z.string(), notAfter: z.iso.datetime(), expired: z.boolean() })
    ),
    spEntityId: z.string(),
    acsUrl: z.string(),
    spMetadataUrl: z.string(),
  })
  .meta({ ref: 'SamlConnection' })

/** A connection as the admin API returns it. Never carries the client secret. */
export const SsoConnectionSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    protocol: z.enum(SSO_PROTOCOLS),
    name: z.string(),
    status: z.enum(SSO_CONNECTION_STATUSES),
    issuer: z.string(),
    clientId: z.string(),
    clientSecretSet: z.boolean(),
    saml: SamlConnectionViewSchema.nullable(),
    attributeMapping: SsoAttributeMappingSchema.nullable(),
    defaultRole: z.string(),
    enforced: z.boolean(),
    breakGlassRole: z.string().nullable(),
    trustIdpMfa: z.boolean(),
    domains: z.array(z.string()),
    /** Whether a test sign-in has passed against the current settings: required to activate. */
    tested: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ ref: 'SsoConnection' })

/** A list of connections. */
export const SsoConnectionListSchema = z
  .object({ connections: z.array(SsoConnectionSchema) })
  .meta({ ref: 'SsoConnectionList' })

/** The query of the list route: the organization whose connections to list; left out, the whole environment's. */
export const SsoConnectionListQuerySchema = z.object({ organizationId: z.uuid().optional() })

/** The identity provider values of a SAML connection, as given. */
export type SamlSettingsInput = z.infer<typeof SamlSettingsInputSchema>
/** The body that creates a connection. */
export type CreateSsoConnectionRequest = z.infer<typeof CreateSsoConnectionRequestSchema>
/** The body an organization admin creates a connection with. */
export type CreateMySsoConnectionRequest = z.infer<typeof CreateMySsoConnectionRequestSchema>
/** The body that changes a connection. */
export type UpdateSsoConnectionRequest = z.infer<typeof UpdateSsoConnectionRequestSchema>
/** A connection as the admin API returns it. */
export type SsoConnection = z.infer<typeof SsoConnectionSchema>

/**
 * Start a single sign-on step of a sign-in attempt: where the app's page is that the browser
 * returns to. The connection is the one the attempt's email domain is bound to; the client never
 * names it. The answer is an `OAuthStart` (the provider's URL, the binding, the attempt).
 */
export const SsoStartRequestSchema = z
  .object({ redirectUrl: z.string().max(2048) })
  .meta({ ref: 'SsoStartRequest' })

/** Single sign-on start request body. */
export type SsoStartRequest = z.infer<typeof SsoStartRequestSchema>
