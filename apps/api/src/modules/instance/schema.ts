import { z } from 'zod'

/**
 * How one diagnostic check went: `ok`, `warn` (works, but look at it), `fail` (something is
 * broken) or `skipped` (not applicable here, or it cannot be checked from the server).
 */
export const DiagnosticStatusSchema = z
  .enum(['ok', 'warn', 'fail', 'skipped'])
  .meta({ ref: 'DiagnosticStatus' })

/** One diagnostic check. Its text is fixed: never a connection string, a key or a driver's message. */
export const DiagnosticCheckSchema = z
  .object({
    /** Stable identifier, e.g. `database`, `migrations`, `master_key`, `smtp`. */
    id: z.string(),
    status: DiagnosticStatusSchema,
    /** One sentence saying what was found. */
    summary: z.string(),
    /** What to do about it. Present when the status is `warn` or `fail`. */
    fix: z.string().optional(),
    /** Values the operator needs, e.g. the redirect URI to register with each OAuth provider. */
    values: z.array(z.string()).optional(),
  })
  .meta({ ref: 'DiagnosticCheck' })

/** The answer of `GET /v1/instance/diagnostics`. */
export const InstanceDiagnosticsSchema = z
  .object({
    /** The API's version. */
    version: z.string(),
    /** The deployment tier (`ENVIRONMENT`). */
    environment: z.enum(['local', 'dev', 'staging', 'prod']),
    /** The API's clock, so a caller can compare its own. */
    time: z.iso.datetime(),
    /** The deployment's `PUBLIC_URL`. */
    publicUrl: z.string(),
    checks: z.array(DiagnosticCheckSchema),
  })
  .meta({ ref: 'InstanceDiagnostics' })

export type DiagnosticStatus = z.infer<typeof DiagnosticStatusSchema>
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>
export type InstanceDiagnostics = z.infer<typeof InstanceDiagnosticsSchema>
