import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Audit from '~/modules/audit/service'
import * as openapi from '~/openapi'
import { AuditLogListSchema, AuditLogQuerySchema } from './schema'

const router = new Hono<AppEnv>()

router.get(
  '/',
  describeRoute({
    operationId: 'listAuditLogs',
    tags: ['Audit'],
    summary: 'List the audit log',
    description:
      'What happened in the secret key’s environment, newest first: sign-ins, revoked ' +
      'sessions, password changes and every admin action, with who did it and from where. ' +
      'Filter by `action`, `actorId` (a user or API key) or `targetId`.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'One page of audit log entries.',
        content: { 'application/json': { schema: resolver(AuditLogListSchema) } },
      },
      401: openapi.responses[401],
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('query', AuditLogQuerySchema, validationHook),
  async (c) =>
    c.json(
      AuditLogListSchema.parse(
        await Audit.list(c.get('deps'), c.get('tenant'), c.req.valid('query'))
      )
    )
)

export default router
