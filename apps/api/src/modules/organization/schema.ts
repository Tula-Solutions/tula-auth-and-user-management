import { z } from 'zod'

/** Organization shapes are owned by the contract so the dashboard and every SDK agree on them. */
export {
  AddOrganizationMemberRequestSchema,
  CreateOrganizationRequestSchema,
  OrganizationListSchema,
  OrganizationMembershipListSchema,
  OrganizationMembershipSchema,
  OrganizationPageQuerySchema,
  OrganizationSchema,
  UpdateOrganizationMemberRequestSchema,
  UpdateOrganizationRequestSchema,
} from '@tula-tech/contract'

/** Path parameter naming one organization. */
export const OrganizationIdParamSchema = z.object({ id: z.uuid() })

/** Path parameters naming one member of one organization. */
export const MembershipParamSchema = z.object({ id: z.uuid(), userId: z.uuid() })
