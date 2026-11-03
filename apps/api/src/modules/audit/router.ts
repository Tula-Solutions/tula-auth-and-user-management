import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Audit from '~/modules/audit/service'
import * as openapi from '~/openapi'
import { AuditExportRequestSchema, AuditLogListSchema, AuditLogQuerySchema } from './schema'

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
      'Filter by `action`, `actorId` (a user, an API key or a dashboard session), ' +
      '`actorType` (`instance_admin` is what was done through the dashboard), `targetId` ' +
      'and time (`from` inclusive, `to` exclusive).',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'One page of audit log entries.',
        content: { 'application/json': { schema: resolver(AuditLogListSchema) } },
      },
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
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

router.post(
  '/export',
  describeRoute({
    operationId: 'exportAuditLogs',
    tags: ['Audit'],
    summary: 'Export the audit log',
    description:
      'Streams the secret key’s environment’s audit log, **oldest first**, as NDJSON (one ' +
      'entry per line, the fields of the list) or CSV (a header, then one row per entry; a ' +
      "cell that a spreadsheet would run as a formula is prefixed with `'`). Takes the " +
      'list’s filters and `organizationId`. One request writes at most 100,000 entries: to ' +
      'continue, send `after` with the last entry’s `occurredAt` and `id` joined by `~`. ' +
      'Every export is itself recorded (`audit.exported`) with its filters and row count. ' +
      'A POST because it writes that entry, which also means an agent key is refused.',
    security: openapi.security.admin,
    responses: {
      200: {
        description: 'The entries, streamed.',
        content: {
          'application/x-ndjson': { schema: { type: 'string' } },
          'text/csv': { schema: { type: 'string' } },
        },
      },
      422: openapi.responses[422],
      429: openapi.responses[429],
      500: openapi.responses[500],
      503: openapi.responses[503],
      ...openapi.adminResponses,
    },
  }),
  adminRateLimit(),
  secretKey(),
  validator('json', AuditExportRequestSchema, validationHook),
  (c) => {
    const body = c.req.valid('json')
    const chunks = Audit.exportEntries(c.get('deps'), c.get('tenant'), adminActor(c), body)
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next()
        if (next.done) {
          controller.close()
        } else {
          controller.enqueue(encoder.encode(next.value))
        }
      },
      async cancel() {
        // A reader that leaves early still gets its export recorded, with the rows it got.
        await chunks.return(undefined)
      },
    })
    const csv = body.format === 'csv'
    return new Response(stream, {
      headers: {
        'content-type': csv ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="audit-log.${csv ? 'csv' : 'ndjson'}"`,
        'cache-control': 'no-store',
      },
    })
  }
)

export default router
