import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, UserSortSchema } from '@tula/contract'
import { z } from 'zod'

/** User shapes are owned by the contract so the dashboard and every SDK agree on them. */
export {
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  CurrentUserSchema,
  SetPasswordRequestSchema,
  UserAuthenticationSchema,
  UserListSchema,
  UserSchema,
} from '@tula/contract'

/** Path parameter naming one user. */
export const UserIdParamSchema = z.object({ userId: z.uuid() })

/** Query parameters of the user list: search, paging and sort. */
export const UserListQuerySchema = z
  .object({
    /** Case-insensitive substring of the email or a name. */
    q: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    sort: UserSortSchema.default('-createdAt'),
  })
  .meta({ ref: 'UserListQuery' })
