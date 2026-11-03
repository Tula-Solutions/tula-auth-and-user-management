import { z } from 'zod'

// SCIM 2.0 (RFC 7643, 7644) as the identity providers send it. These routes are left out of
// the OpenAPI document and the SDKs on purpose (ADR 0067): they are documented in docs/scim.md.

/** The schema URN of a User resource. */
export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
/** The schema URN of a Group resource. */
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
/** The schema URN of a list answer. */
export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
/** The schema URN of an error answer. */
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error'

/** Entra sends booleans as the strings "True" and "False"; Okta sends real booleans. */
const Flag = z.union([
  z.boolean(),
  z.string().transform((value, ctx) => {
    const lower = value.toLowerCase()
    if (lower !== 'true' && lower !== 'false') {
      ctx.addIssue({ code: 'custom', message: 'not a boolean' })
      return z.NEVER
    }
    return lower === 'true'
  }),
])

/** A User as an identity provider creates or replaces it. Unknown attributes are ignored. */
export const ScimUserInputSchema = z.looseObject({
  userName: z.string().trim().min(1).max(320),
  externalId: z.string().min(1).max(255).nullish(),
  active: Flag.optional(),
  name: z
    .looseObject({
      givenName: z.string().max(100).nullish(),
      familyName: z.string().max(100).nullish(),
    })
    .optional(),
  emails: z
    .array(z.looseObject({ value: z.string().max(320), primary: z.boolean().optional() }))
    .max(20)
    .optional(),
})

/** The input of a User create or replace. */
export type ScimUserInput = z.infer<typeof ScimUserInputSchema>

/** A PATCH body. `Operations` is capitalized in the RFC. */
export const ScimPatchSchema = z.looseObject({
  Operations: z
    .array(
      z.looseObject({
        op: z.string().max(20),
        path: z.string().max(200).optional(),
        value: z.unknown().optional(),
      })
    )
    .min(1)
    .max(50),
})

/** The query of a Users list. */
export const ScimListQuerySchema = z.object({
  filter: z.string().max(500).optional(),
  startIndex: z.coerce.number().int().optional(),
  count: z.coerce.number().int().optional(),
  /** Entra asks for `members` to be left out of a group list. */
  excludedAttributes: z.string().max(200).optional(),
})

/** A User resource as this server answers. */
export interface ScimUserResource {
  schemas: [typeof USER_SCHEMA]
  id: string
  externalId?: string
  userName: string
  name: { givenName?: string; familyName?: string }
  emails: Array<{ value: string; primary: true }>
  active: boolean
  meta: { resourceType: 'User'; created: string; lastModified: string }
}

/** A Group as an identity provider creates or replaces it. Unknown attributes are ignored. */
export const ScimGroupInputSchema = z.looseObject({
  displayName: z.string().trim().min(1).max(256),
  externalId: z.string().min(1).max(255).nullish(),
  members: z
    .array(z.looseObject({ value: z.string().min(1).max(64) }))
    .max(10000)
    .optional(),
})

/** The input of a Group create or replace. */
export type ScimGroupInput = z.infer<typeof ScimGroupInputSchema>

/** A Group resource as this server answers. */
export interface ScimGroupResource {
  schemas: [typeof GROUP_SCHEMA]
  id: string
  externalId?: string
  displayName: string
  members?: Array<{ value: string }>
  meta: { resourceType: 'Group'; created: string; lastModified: string }
}
