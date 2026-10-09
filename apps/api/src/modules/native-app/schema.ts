import { z } from 'zod'

export {
  AppleAppSiteAssociationSchema,
  AssetLinksSchema,
  CreateNativeAppRequestSchema,
  NativeAppListSchema,
  NativeAppSchema,
  UpdateNativeAppRequestSchema,
} from '@tula/contract'

/** The app named in a path. */
export const NativeAppIdParamSchema = z.object({ id: z.uuid() })

/** The environment named in the path of an association file. */
export const AssociationParamSchema = z.object({ environmentId: z.uuid() })
