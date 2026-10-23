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
  UserMembershipListSchema,
} from '@tula-tech/contract'

/** Path parameter naming the user whose memberships an administrator reads. */
export const UserIdParamSchema = z.object({ userId: z.uuid() })

/** Path parameter naming one organization. */
export const OrganizationIdParamSchema = z.object({ id: z.uuid() })

/** Path parameters naming one member of one organization. */
export const MembershipParamSchema = z.object({ id: z.uuid(), userId: z.uuid() })

/** Path parameters naming one invitation of one organization (the admin API). */
export const InvitationParamSchema = z.object({ id: z.uuid(), invitationId: z.uuid() })

/** Path parameter naming the organization of a signed-in member's invitation routes. */
export const MemberOrganizationParamSchema = z.object({ organizationId: z.uuid() })

/** Path parameters naming one invitation of one organization (a signed-in member's routes). */
export const MemberInvitationParamSchema = z.object({
  organizationId: z.uuid(),
  invitationId: z.uuid(),
})

/** Path parameters naming one member of one organization (a signed-in member's routes). */
export const MemberParamSchema = z.object({ organizationId: z.uuid(), userId: z.uuid() })
