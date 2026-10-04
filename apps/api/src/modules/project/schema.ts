import { z } from 'zod'

/** Publishable keys identify an environment from apps; secret keys authorize server calls. */
export const ApiKeyKindSchema = z.enum(['publishable', 'secret']).meta({ ref: 'ApiKeyKind' })

/** Environment kinds shown in the dashboard's Development / Production switch. */
export const EnvironmentKindSchema = z
  .enum(['development', 'production'])
  .meta({ ref: 'EnvironmentKind' })

/** An environment of the project the secret key belongs to. */
export const EnvironmentSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    kind: EnvironmentKindSchema,
    createdAt: z.date(),
  })
  .meta({ ref: 'Environment' })

/** The project's environments. */
export const EnvironmentListSchema = z
  .object({ data: z.array(EnvironmentSchema) })
  .meta({ ref: 'EnvironmentList' })

/** An API key as listed. The key itself is never returned after creation. */
export const ApiKeySchema = z
  .object({
    id: z.uuid(),
    kind: ApiKeyKindSchema,
    name: z.string(),
    environmentId: z.uuid(),
    /** Last 4 characters, for display as `tula_sk_dev_••••abcd`. */
    lastFour: z.string(),
    createdAt: z.date(),
    lastUsedAt: z.date().nullable(),
    revokedAt: z.date().nullable(),
  })
  .meta({ ref: 'ApiKey' })

/** A newly created key. `key` is shown only in this response and cannot be retrieved again. */
export const CreatedApiKeySchema = ApiKeySchema.extend({
  key: z.string().describe('The full key. Store it now: it is shown only once.'),
}).meta({ ref: 'CreatedApiKey' })

/** An environment's API keys, newest first, including revoked ones. */
export const ApiKeyListSchema = z
  .object({ data: z.array(ApiKeySchema) })
  .meta({ ref: 'ApiKeyList' })

/** Longest name of a workspace, a project or an API key. */
export const MAX_NAME_LENGTH = 100

/**
 * A name an operator typed for a workspace, a project or an API key: one line of text.
 * Trimmed; no control characters, so it cannot break a log line or a terminal it is listed in
 * (`tula`, the dashboard, an audit export).
 */
export const NameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'Must not contain control characters.')

/** Body of `POST /v1/admin/api-keys`. */
export const CreateApiKeyRequestSchema = z
  .object({
    kind: ApiKeyKindSchema,
    name: NameSchema,
  })
  .meta({ ref: 'CreateApiKeyRequest' })

/** Path parameters naming one API key. */
export const ApiKeyIdParamSchema = z.object({ id: z.uuid() })

/** An environment. */
export type Environment = z.infer<typeof EnvironmentSchema>
/** A listed API key. */
export type ApiKey = z.infer<typeof ApiKeySchema>
/** A newly created API key, including the key itself. */
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>
/** Create-key request body. */
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>
