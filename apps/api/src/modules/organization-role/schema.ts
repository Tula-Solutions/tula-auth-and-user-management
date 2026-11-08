import { RoleKeySchema } from '@tula-tech/contract'
import { z } from 'zod'

/** Role shapes are owned by the contract so the dashboard, `tula.config.ts` and every SDK agree. */
export {
  CreateOrganizationRoleRequestSchema,
  OrganizationRoleListSchema,
  OrganizationRoleSchema,
  OrganizationRoleVersionListSchema,
  OrganizationRoleVersionSchema,
  UpdateOrganizationRoleRequestSchema,
} from '@tula-tech/contract'

/** Path parameter naming one role by its key (a role's key is its public identity). */
export const RoleKeyParamSchema = z.object({ key: RoleKeySchema })

/** Path parameters naming one version of a role; versions count from 1. */
export const RoleVersionParamSchema = z.object({
  key: RoleKeySchema,
  version: z.coerce.number().int().min(1),
})
