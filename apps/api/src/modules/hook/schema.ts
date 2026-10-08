import { z } from 'zod'

export {
  CreatedHookSchema,
  CreateHookRequestSchema,
  HookListSchema,
  HookSchema,
  UpdateHookRequestSchema,
} from '@tula/contract'

/** The hook named in a path. */
export const HookIdParamSchema = z.object({ id: z.uuid() })
