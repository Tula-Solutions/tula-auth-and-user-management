import { RoleKeySchema } from '@tula-tech/contract'
import { z } from 'zod'

/** Role shapes are owned by the contract so the dashboard, `tula.config.ts` and every SDK agree. */
export {
  CreateOrganizationRoleRequestSchema,
  OrganizationRoleListSchema,
  OrganizationRoleSchema,
  UpdateOrganizationRoleRequestSchema,
} from '@tula-tech/contract'

/** Path parameter naming one role by its key (a role's key is its public identity). */
export const RoleKeyParamSchema = z.object({ key: RoleKeySchema })
