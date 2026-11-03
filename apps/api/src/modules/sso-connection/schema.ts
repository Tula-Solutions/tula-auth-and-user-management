import { z } from 'zod'

export {
  AdminSsoTestStartRequestSchema,
  CreateSsoConnectionRequestSchema,
  SsoConnectionListQuerySchema,
  SsoConnectionListSchema,
  SsoConnectionSchema,
  SsoGroupRolesSchema,
  SsoTestIdParamSchema,
  SsoTestResultSchema,
  SsoTestStartRequestSchema,
  SsoTestStartSchema,
  UpdateSsoConnectionRequestSchema,
} from '@tula-tech/contract'

/** The `:id` of a connection route. */
export const SsoConnectionIdParamSchema = z.object({ id: z.uuid() })
