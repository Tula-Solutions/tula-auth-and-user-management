import { z } from 'zod'

/** One SCIM token as the admin routes show it: never the secret. */
export const ScimTokenSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    name: z.string(),
    prefix: z.string().describe('The start of the token, to tell tokens apart in a list.'),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ ref: 'ScimToken' })

/** A new SCIM token: the one answer that holds the secret. */
export const CreatedScimTokenSchema = ScimTokenSchema.extend({
  token: z.string().describe('The bearer token. Shown once; only its hash is stored.'),
  scimBaseUrl: z.string().describe('The base URL to give the identity provider.'),
}).meta({ ref: 'CreatedScimToken' })

/** The tokens of one organization. */
export const ScimTokenListSchema = z
  .object({ tokens: z.array(ScimTokenSchema) })
  .meta({ ref: 'ScimTokenList' })

/** The body that creates a token. */
export const CreateScimTokenRequestSchema = z
  .object({
    organizationId: z.uuid(),
    name: z.string().trim().min(1).max(100),
  })
  .strict()
  .meta({ ref: 'CreateScimTokenRequest' })

/** The query that names the organization a token route is about. */
export const ScimTokenQuerySchema = z.object({ organizationId: z.uuid() })

/** The `:id` of a token route. */
export const ScimTokenIdParamSchema = z.object({ id: z.uuid() })
