import { ActivityTypeSchema, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@tula/contract'
import { z } from 'zod'

/** Audit shapes are owned by the contract so the dashboard and every SDK agree on them. */
export { AuditLogListSchema, AuditLogSchema } from '@tula/contract'

/** Query parameters of the audit log: filters and paging. */
export const AuditLogQuerySchema = z
  .object({
    /** Only this action, e.g. `session.revoked`. */
    action: ActivityTypeSchema.optional(),
    /** Only actions performed by this user or API key. */
    actorId: z.uuid().optional(),
    /** Only actions on this user, session or key. */
    targetId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .meta({ ref: 'AuditLogQuery' })
