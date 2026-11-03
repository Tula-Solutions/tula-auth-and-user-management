import { z } from 'zod'

/** Domain shapes are owned by the contract so the dashboard and every SDK agree on them. */
export {
  OrganizationDomainListSchema,
  OrganizationDomainSchema,
  OrganizationSuggestionListSchema,
  StartOrganizationDomainRequestSchema,
  UpdateOrganizationDomainRequestSchema,
  UserOrganizationSchema,
  VerifyOrganizationDomainRequestSchema,
} from '@tula-tech/contract'

/** Path parameter naming one organization. */
export const OrganizationIdParamSchema = z.object({ id: z.uuid() })

/** Path parameters naming one domain of one organization. */
export const DomainParamSchema = z.object({ id: z.uuid(), domainId: z.uuid() })

/** Path parameter naming a suggested organization. */
export const SuggestionParamSchema = z.object({ organizationId: z.uuid() })
