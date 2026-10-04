import { OAuthProviderSchema } from '@tula/contract'
import { z } from 'zod'

export {
  IdentityLinkStartSchema,
  IdentityListSchema,
  IdentitySchema,
  OAuthExchangeRequestSchema,
  OAuthProviderSettingsListSchema,
  OAuthProviderSettingsSchema,
  OAuthProviderUpdateSchema,
  OAuthStartRequestSchema,
} from '@tula/contract'

/** The provider named in a path. */
export const ProviderParamSchema = z.object({ provider: OAuthProviderSchema })

/** The identity named in a path. */
export const IdentityIdParamSchema = z.object({ identityId: z.uuid() })
