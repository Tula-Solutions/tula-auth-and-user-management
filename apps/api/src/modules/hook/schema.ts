import { z } from 'zod'

export {
  CreatedHookSchema,
  CreateHookRequestSchema,
  HookListSchema,
  HookSchema,
  UpdateHookRequestSchema,
} from '@tula-tech/contract'

/** The hook named in a path. */
export const HookIdParamSchema = z.object({ id: z.uuid() })
