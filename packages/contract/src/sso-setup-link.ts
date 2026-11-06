import { z } from 'zod'
import { OrganizationDomainNameSchema } from './organization-domain'
import { SSO_PROTOCOLS } from './sso'
import {
  SamlSettingsInputSchema,
  SsoAttributeMappingSchema,
  SsoConnectionSchema,
} from './sso-connection'

// A setup link lets an organization's IT administrator set up single sign-on without an
// account. The portal's routes take the subset of an SSO
// connection's fields below and nothing else: no enforcement, MFA trust, break-glass role or
// default role, which stay with the operator and the organization's administrators.

/** Days a setup link lives when the request names none. */
export const DEFAULT_SETUP_LINK_DAYS = 7

/** The longest life a setup link may be given, in days. */
export const MAX_SETUP_LINK_DAYS = 30

const IssuerSchema = z.url({ protocol: /^https?$/ }).max(2048)

/** A setup link as the admin and client routes list it: never the token. */
export const SetupLinkSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    name: z.string(),
    prefix: z.string().describe('The start of the token, to tell links apart in a list.'),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'SetupLink' })

/** A new setup link: the one answer that holds the token and the address built from it. */
export const CreatedSetupLinkSchema = SetupLinkSchema.extend({
  token: z.string().describe('The setup token. Shown once; only its hash is stored.'),
  url: z
    .string()
    .describe('The address to send to the IT administrator. The token is in its fragment.'),
}).meta({ ref: 'CreatedSetupLink' })

/** The setup links of one organization. */
export const SetupLinkListSchema = z
  .object({ links: z.array(SetupLinkSchema) })
  .meta({ ref: 'SetupLinkList' })

/** The body that creates a setup link. */
export const CreateSetupLinkRequestSchema = z
  .strictObject({
    organizationId: z.uuid(),
    name: z.string().trim().min(1).max(100).default('SSO setup'),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_SETUP_LINK_DAYS)
      .default(DEFAULT_SETUP_LINK_DAYS),
  })
  .meta({ ref: 'CreateSetupLinkRequest' })

/** The body that creates a setup link from a signed-in administrator: the organization is in the path. */
export const CreateMySetupLinkRequestSchema = CreateSetupLinkRequestSchema.omit({
  organizationId: true,
}).meta({ ref: 'CreateMySetupLinkRequest' })

/** The body that creates a connection from the portal: the organization is the link's. */
export const SetupConnectionCreateSchema = z
  .strictObject({
    protocol: z.enum(SSO_PROTOCOLS).default('oidc'),
    name: z.string().trim().min(1).max(100),
    issuer: IssuerSchema.optional(),
    clientId: z.string().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(4096).optional(),
    saml: SamlSettingsInputSchema.optional(),
    attributeMapping: SsoAttributeMappingSchema.optional(),
    domains: z.array(OrganizationDomainNameSchema).max(20).default([]),
  })
  .meta({ ref: 'SetupConnectionCreate' })

/** The body that changes a connection from the portal; `status` can only be `active`. */
export const SetupConnectionUpdateSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    issuer: IssuerSchema,
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
    saml: SamlSettingsInputSchema,
    attributeMapping: SsoAttributeMappingSchema,
    domains: z.array(OrganizationDomainNameSchema).max(20),
    status: z.literal('active'),
  })
  .partial()
  .meta({ ref: 'SetupConnectionUpdate' })

/** The body that creates a SCIM token from the portal: the organization is the link's. */
export const SetupScimTokenCreateSchema = z
  .strictObject({ name: z.string().trim().min(1).max(100) })
  .meta({ ref: 'SetupScimTokenCreate' })

/** What the portal shows first: the organization, its verified domains and the link's life. */
export const SetupPortalSchema = z
  .object({
    organization: z.object({ id: z.uuid(), name: z.string() }),
    domains: z.array(z.string()).describe('The organization’s verified domains.'),
    expiresAt: z.iso.datetime(),
    connections: z.array(SsoConnectionSchema),
  })
  .meta({ ref: 'SetupPortal' })

/** A setup link as the admin and client routes list it. */
export type SetupLink = z.infer<typeof SetupLinkSchema>
/** A new setup link, with its token and address. */
export type CreatedSetupLink = z.infer<typeof CreatedSetupLinkSchema>
/** The body that creates a setup link. */
export type CreateSetupLinkRequest = z.infer<typeof CreateSetupLinkRequestSchema>
/** The body that creates a connection from the portal. */
export type SetupConnectionCreate = z.infer<typeof SetupConnectionCreateSchema>
/** The body that changes a connection from the portal. */
export type SetupConnectionUpdate = z.infer<typeof SetupConnectionUpdateSchema>
/** The body that creates a SCIM token from the portal. */
export type SetupScimTokenCreate = z.infer<typeof SetupScimTokenCreateSchema>
/** What the portal shows first. */
export type SetupPortal = z.infer<typeof SetupPortalSchema>
