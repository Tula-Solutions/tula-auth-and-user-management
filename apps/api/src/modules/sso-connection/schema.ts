import { z } from 'zod'

export {
  CreateSsoConnectionRequestSchema,
  SsoConnectionListQuerySchema,
  SsoConnectionListSchema,
  SsoConnectionSchema,
  SsoTestIdParamSchema,
  SsoTestResultSchema,
  SsoTestStartRequestSchema,
  SsoTestStartSchema,
  UpdateSsoConnectionRequestSchema,
} from '@tula-tech/contract'

/** The `:id` of a connection route. */
export const SsoConnectionIdParamSchema = z.object({ id: z.uuid() })
