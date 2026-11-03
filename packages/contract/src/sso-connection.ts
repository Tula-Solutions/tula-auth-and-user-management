import { z } from 'zod'
import { RoleKeySchema } from './organization'
import { OrganizationDomainNameSchema } from './organization-domain'
import {
  MAX_SAML_CERTIFICATES,
  MAX_SSO_CONNECTION_DOMAINS,
  SSO_CONNECTION_STATUSES,
  SSO_PROTOCOLS,
} from './sso'

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
    defaultRole: RoleKeySchema.default('member'),
    domains: Domains.default([]),
  })
  .meta({ ref: 'CreateSsoConnectionRequest' })

/** The body that changes a connection: every field is optional and an absent one is kept. */
export const UpdateSsoConnectionRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    issuer: IssuerSchema,
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    saml: SamlSettingsInputSchema,
    defaultRole: RoleKeySchema,
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
    defaultRole: z.string(),
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

/** The query of the list route: the organization whose connections to list. */
export const SsoConnectionListQuerySchema = z.object({ organizationId: z.uuid() })

/** The identity provider values of a SAML connection, as given. */
export type SamlSettingsInput = z.infer<typeof SamlSettingsInputSchema>
/** The body that creates a connection. */
export type CreateSsoConnectionRequest = z.infer<typeof CreateSsoConnectionRequestSchema>
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
