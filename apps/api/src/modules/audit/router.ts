import { Hono } from 'hono'
import { describeRoute, resolver, validator } from 'hono-openapi'
import type { AppEnv } from '~/dependencies'
import { RateLimitError } from '~/exceptions'
import { validationHook } from '~/handlers'
import { adminActor } from '~/lib/actor'
import { adminRateLimit } from '~/middleware/rate-limit'
import { secretKey } from '~/middleware/secret-key'
import * as Audit from '~/modules/audit/service'
import * as openapi from '~/openapi'
import { AuditExportRequestSchema, AuditLogListSchema, AuditLogQuerySchema } from './schema'

const router = new Hono<AppEnv>()

/** Exports one environment may have streaming at once, across every instance (H-168). */
export const MAX_CONCURRENT_EXPORTS = 2

/**
 * How long a slot lasts without a renewal: a process that dies mid-export frees its slot after
 * this. A live export renews it while it streams (`EXPORT_RENEW_MS`).
 */
const EXPORT_LEASE_MS = 10 * 60_000
const EXPORT_RENEW_MS = EXPORT_LEASE_MS / 3

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
      413: openapi.responses[413],
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
  async (c) => {
    const body = c.req.valid('json')
    const deps = c.get('deps')
    const environmentId = c.get('tenant').environmentId
    const leaseId = await deps.exportLeases.acquire(
      environmentId,
      MAX_CONCURRENT_EXPORTS,
      EXPORT_LEASE_MS
    )
    if (leaseId === null) {
      // Each export holds a database cursor and a stream open: a few at once is a client bug
      // or an attempt to starve the pool, so the rest wait for one to end.
      throw new RateLimitError(5_000)
    }
    let released = false
    const release = async () => {
      if (released) {
        return
      }
      released = true
      // A failed release must not mask what ended the stream: the lease expires on its own.
      await deps.exportLeases.release(environmentId, leaseId).catch(() => undefined)
    }
    let renewedAt = Date.now()
    const renew = async () => {
      if (Date.now() - renewedAt < EXPORT_RENEW_MS) {
        return
      }
      renewedAt = Date.now()
      // A renewal that fails is retried at the next chunk; the lease's term covers the gap.
      await deps.exportLeases.renew(environmentId, leaseId, EXPORT_LEASE_MS).catch(() => false)
    }
    let chunks: ReturnType<typeof Audit.exportEntries>
    try {
      chunks = Audit.exportEntries(deps, c.get('tenant'), adminActor(c), body)
    } catch (error) {
      await release()
      throw error
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await renew()
        let next: IteratorResult<string>
        try {
          next = await chunks.next()
        } catch (error) {
          await release()
          throw error
        }
        if (next.done) {
          await release()
          controller.close()
        } else {
          controller.enqueue(encoder.encode(next.value))
        }
      },
      async cancel() {
        // A reader that leaves early still gets its export recorded, with the rows it got.
        try {
          await chunks.return(undefined)
        } finally {
          await release()
        }
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
