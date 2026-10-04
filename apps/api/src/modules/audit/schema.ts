import {
  ActivityTypeSchema,
  AUDIT_ACTOR_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '@tula/contract'
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
    /** Only entries by this kind of actor: `instance_admin` is what the dashboard did. */
    actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
    /** Entries at or after this instant (ISO 8601 with a zone). */
    from: z.iso.datetime({ offset: true }).optional(),
    /** Entries before this instant (ISO 8601 with a zone). */
    to: z.iso.datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .meta({ ref: 'AuditLogQuery' })
