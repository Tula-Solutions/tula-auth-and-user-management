import { z } from 'zod'

export {
  PasskeyCreationOptionsSchema,
  PasskeyListSchema,
  PasskeyRegisterRequestSchema,
  PasskeyRenameRequestSchema,
  PasskeyRequestOptionsSchema,
  PasskeySchema,
} from '@tula/contract'

/** The `:passkeyId` path parameter. */
export const PasskeyIdParamSchema = z.object({ passkeyId: z.uuid() })
