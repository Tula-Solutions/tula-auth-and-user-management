import { z } from 'zod'

export {
  CreateSsoConnectionRequestSchema,
  SsoConnectionListQuerySchema,
  SsoConnectionListSchema,
  SsoConnectionSchema,
  SsoGroupRolesSchema,
  UpdateSsoConnectionRequestSchema,
} from '@tula-tech/contract'

/** The `:id` of a connection route. */
export const SsoConnectionIdParamSchema = z.object({ id: z.uuid() })
