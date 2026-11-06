import { z } from 'zod'

export {
  ApproveProposalRequestSchema,
  CreateProposalRequestSchema,
  ProposalListSchema,
  ProposalSchema,
} from '@tula-tech/contract'

/** Path parameter of the routes that name one proposal. */
export const ProposalIdParamSchema = z.object({ id: z.uuid() })
