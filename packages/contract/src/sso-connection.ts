import { z } from 'zod'
import { RoleKeySchema } from './organization'
import { OrganizationDomainNameSchema } from './organization-domain'
import { MAX_SSO_CONNECTION_DOMAINS, SSO_CONNECTION_STATUSES, SSO_PROTOCOLS } from './sso'

// The admin API's shapes for an enterprise connection (ADR 0067). The client secret is
// accepted on create and update and never returned: the view says only that one is set.

const Domains = z.array(OrganizationDomainNameSchema).max(MAX_SSO_CONNECTION_DOMAINS)

/** An `https` address: the issuer of an OIDC connection. Whether it may be called is checked on save. */
const IssuerSchema = z.url({ protocol: /^https?$/ }).max(2048)

/** The body that creates a connection, as a draft. */
export const CreateSsoConnectionRequestSchema = z
  .strictObject({
    organizationId: z.uuid(),
    protocol: z.enum(SSO_PROTOCOLS).default('oidc'),
    name: z.string().trim().min(1).max(100),
    issuer: IssuerSchema,
    clientId: z.string().min(1).max(512),
    clientSecret: z.string().min(1).max(4096),
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
    defaultRole: RoleKeySchema,
    domains: Domains,
    status: z.enum(SSO_CONNECTION_STATUSES),
  })
  .partial()
  .meta({ ref: 'UpdateSsoConnectionRequest' })

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
    clientSecretSet: z.literal(true),
    defaultRole: z.string(),
    domains: z.array(z.string()),
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

export type CreateSsoConnectionRequest = z.infer<typeof CreateSsoConnectionRequestSchema>
export type UpdateSsoConnectionRequest = z.infer<typeof UpdateSsoConnectionRequestSchema>
export type SsoConnection = z.infer<typeof SsoConnectionSchema>
