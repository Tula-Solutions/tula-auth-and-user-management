import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor, agentActor } from '~/lib/actor'
import { agentKey } from '~/middleware/agent-key'
import { adminRateLimit, byEnvironment, rateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Proposals from '~/modules/proposal/service'
import * as openapi from '~/openapi'
import {
  ApproveProposalRequestSchema,
  CreateProposalRequestSchema,
  ProposalIdParamSchema,
  ProposalListSchema,
  ProposalSchema,
} from './schema'

const router = new Hono<AppEnv>()

const json = (schema: Parameters<typeof resolver>[0]) => ({
  'application/json': { schema: resolver(schema) },
})

const errors = {
  429: openapi.responses[429],
  500: openapi.responses[500],
  503: openapi.responses[503],
}

/**
 * How many proposals an environment's agents may ask for in a minute, whichever key and
 * address they come from (mounted after `agentKey()`, which resolves the environment). The
 * general admin limit is per address and far higher; this one is what keeps an agent that was
 * talked into repeating itself from filling a human's queue. Refuses when the limiter cannot
 * count.
 */
const createRateLimit = rateLimit({
  name: 'proposal_create',
  limit: Proposals.PROPOSALS_PER_MINUTE,
  window: '1m',
  key: byEnvironment,
})

/**
 * How many proposals of **one operation** an environment's agents may ask for in a minute:
 * a count per operation, beside the one all operations share ({@link createRateLimit}).
 * Mounted after the body is validated, because the operation is in the body: the key holds
 * the environment's id and a word of the contract's closed list, nothing of the target.
 * Refuses when the limiter cannot count. A request the shared limit refused is not counted
 * here, and one this limit refuses has been counted there: the shared count is of everything
 * an environment's agents asked.
 */
const operationRateLimit = rateLimit({
  name: 'proposal_create_operation',
  limit: Proposals.PROPOSALS_PER_OPERATION_PER_MINUTE,
  window: '1m',
  key: (c) => {
    const environment = byEnvironment(c)
    const { operation } = (
      c.req as unknown as { valid(target: 'json'): { operation: string } }
    ).valid('json')
    return environment === null ? null : `${environment}:${operation}`
  },
})

const whatAProposalIs =
  'A proposal is a change an AI agent has asked for and that has **not happened**. It names ' +
  'one operation from a closed list and one target by id, holds no text anyone wrote, can be ' +
  `approved for ${Proposals.PROPOSAL_TTL_MS / 60_000} minutes and at most once. `

router.post(
  '/agent/proposals',
  describeRoute({
    operationId: 'createProposal',
    tags: ['Proposals'],
    summary: 'Propose a change',
    description:
      whatAProposalIs +
      'This is the one thing an agent key can ask for, and it changes nothing: a human has ' +
      'to approve the proposal with a secret key or in the dashboard ' +
      '(`POST /v1/admin/proposals/{id}/approve`), which an agent key cannot do. Asking again ' +
      'for the same operation on the same target while the first proposal still waits ' +
      'answers that proposal. The operations are `ban_user` and `unban_user` (a user, by ' +
      'id), `end_session` (one session, by id) and `disable_oauth_provider` (one provider, ' +
      'by its name: `enabled: false` and nothing else). A production environment accepts ' +
      'none unless its settings say so (`agents.proposalsInProduction`, off by default): ' +
      '`auth.forbidden`, `params.reason`: `production_environment`. Switching a provider ' +
      'off is refused (422, as the provider route refuses it) when it would leave the ' +
      'environment with no way to sign in, and judged again when the proposal is approved. ' +
      `Limited to ${Proposals.PROPOSALS_PER_MINUTE} a minute per environment, and to ` +
      `${Proposals.PROPOSALS_PER_OPERATION_PER_MINUTE} a minute for each operation.`,
    security: openapi.security.agent,
    responses: {
      201: { description: 'The proposal, waiting for a human.', content: json(ProposalSchema) },
      400: openapi.responses[400],
      401: openapi.responses[401],
      403: openapi.responses[403],
      404: openapi.responses[404],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
    },
  }),
  adminRateLimit(),
  agentKey(),
  createRateLimit,
  validator('json', CreateProposalRequestSchema, validationHook),
  operationRateLimit,
  async (c) => {
    const proposal = await Proposals.create(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('json'),
      agentActor(c)
    )
    return c.json(ProposalSchema.parse(proposal), 201)
  }
)

router.get(
  '/admin/proposals',
  describeRoute({
    operationId: 'listProposals',
    tags: ['Proposals'],
    summary: 'List proposals',
    description:
      whatAProposalIs +
      `The newest ${Proposals.PROPOSAL_LIST_LIMIT}, newest first, whatever became of them. ` +
      'An agent key may read this, like every other read of the admin API.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The proposals.', content: json(ProposalListSchema) },
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  async (c) => {
    const data = await Proposals.list(c.get('deps'), c.get('tenant'))
    return c.json(ProposalListSchema.parse({ data }))
  }
)

router.get(
  '/admin/proposals/:id',
  describeRoute({
    operationId: 'getProposal',
    tags: ['Proposals'],
    summary: 'Read a proposal',
    description:
      'One proposal: what it would do (`operation`, `target`, and `summary`, the server’s ' +
      'own sentence for it), who asked, until when it can be approved and what became of it.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The proposal.', content: json(ProposalSchema) },
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', ProposalIdParamSchema, validationHook),
  async (c) => {
    const proposal = await Proposals.get(c.get('deps'), c.get('tenant'), c.req.valid('param').id)
    return c.json(ProposalSchema.parse(proposal))
  }
)

router.post(
  '/admin/proposals/:id/approve',
  describeRoute({
    operationId: 'approveProposal',
    tags: ['Proposals'],
    summary: 'Approve a proposal',
    description:
      'Approve a proposal and carry out its operation, now. It takes a secret key or a ' +
      'dashboard session, **never an agent key** (`auth.invalid_key`): the approval is a ' +
      'human’s. The body names the operation and the target the human was shown; what is ' +
      'carried out is what the proposal holds, and only when the two are the same. ' +
      'Refused with `resource.conflict` and a fixed `params.reason`: `mismatch` (the body ' +
      'names something else), `already_decided` (a proposal is approved at most once), ' +
      '`expired`, `agent_key_revoked` or `production_environment` (a production ' +
      'environment whose settings do not, or no longer, accept proposals). Nothing is ' +
      'changed by a refused approval. The answer is the proposal ' +
      'afterwards: `executed`, or `failed` with `failureReason` when the operation could ' +
      'not be carried out (the proposal is spent either way; `last_sign_in_method` when ' +
      'switching a provider off would have left no way to sign in). The operation is recorded ' +
      'with the agent as its actor and the approver beside it; the approval itself with ' +
      'the approver as its actor.',
    security: openapi.security.admin,
    responses: {
      200: { description: 'The proposal, after its operation.', content: json(ProposalSchema) },
      409: openapi.responses[409],
      413: openapi.responses[413],
      422: openapi.responses[422],
      ...errors,
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('param', ProposalIdParamSchema, validationHook),
  validator('json', ApproveProposalRequestSchema, validationHook),
  async (c) => {
    const proposal = await Proposals.approve(
      c.get('deps'),
      c.get('tenant'),
      c.req.valid('param').id,
      c.req.valid('json'),
      adminActor(c)
    )
    return c.json(ProposalSchema.parse(proposal))
  }
)

export default router
