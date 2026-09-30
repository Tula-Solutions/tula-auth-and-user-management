import { z } from 'zod'

/** Liveness response: the process is up. */
export const StatusResponseSchema = z
  .object({
    status: z.literal('ok'),
    version: z.string(),
  })
  .meta({ ref: 'StatusResponse' })

/** Result of one readiness check. */
export const CheckResultSchema = z.enum(['ok', 'fail']).meta({ ref: 'CheckResult' })

/** Readiness response: whether every dependency is reachable. */
export const ReadinessResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    /** One entry per dependency, e.g. `{ "database": "ok" }`. */
    checks: z.record(z.string(), CheckResultSchema),
  })
  .meta({ ref: 'ReadinessResponse' })

/** Liveness response. */
export type StatusResponse = z.infer<typeof StatusResponseSchema>
/** Readiness response. */
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>
