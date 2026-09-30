import { z } from 'zod'

/** Deployment tiers. Real side effects (email, breach API) are gated on these, never on NODE_ENV. */
export const TIERS = ['local', 'dev', 'staging', 'prod'] as const

/** A deployment tier. */
export type Tier = (typeof TIERS)[number]

/** Tiers that face real users: they must send real email and check real breach data. */
const LIVE_TIERS: ReadonlySet<Tier> = new Set(['staging', 'prod'])

/** Parse a comma-separated list, dropping blanks. Unset or blank yields `[]`. */
const list = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )

/** `true` / `1` / `yes` (any case) is true; anything else, including unset, is false. */
const flag = z
  .string()
  .optional()
  .transform((value) => /^(true|1|yes)$/i.test(value ?? ''))

const fields = z.object({
  /** Log formatting and third-party packages only. Behaviour is gated on `ENVIRONMENT`. */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Required with no default: silently falling back to `local` in production would relax the
  // live-tier checks below.
  ENVIRONMENT: z.enum(TIERS),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3003),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  /** Runtime connection as the non-owner `tula_api` role, so row-level security applies. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Mailpit by default; live tiers must point at a real relay. */
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).default('smtp://127.0.0.1:1025'),
  /**
   * 32-byte key (64 hex chars) that encrypts signing keys at rest and derives the HMAC key for
   * verification codes. Losing it invalidates every stored secret, so there is no default.
   */
  TULA_MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'must be 64 hex characters (32 bytes), e.g. `openssl rand -hex 32`'
    ),
  /** Public base URL of this API. It is the `iss` claim of every access token. */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3003'),
  /** `hibp` queries Have I Been Pwned (k-anonymity); `offline` uses the bundled common list. */
  BREACH_CHECK: z.enum(['hibp', 'offline']).default('offline'),
  /** Browser origins allowed to call the API with credentials, comma-separated. */
  CORS_ORIGINS: list,
  /**
   * Trust `X-Forwarded-For` for the client IP. Enable only behind a proxy that overwrites the
   * header: otherwise any client can pick its own rate-limit bucket.
   */
  TRUST_PROXY: flag,
})

const schema = fields.superRefine((env, ctx) => {
  if (!LIVE_TIERS.has(env.ENVIRONMENT)) {
    return
  }
  const smtpHost = new URL(env.SMTP_URL).hostname
  if (smtpHost === '127.0.0.1' || smtpHost === 'localhost') {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_URL'],
      message: `must be a real mail relay in ${env.ENVIRONMENT}, not the local Mailpit`,
    })
  }
  if (env.BREACH_CHECK !== 'hibp') {
    ctx.addIssue({
      code: 'custom',
      path: ['BREACH_CHECK'],
      message: `must be \`hibp\` in ${env.ENVIRONMENT}`,
    })
  }
  if (new URL(env.PUBLIC_URL).protocol !== 'https:') {
    // Session cookies are `Secure`; a plain-http issuer would also leak tokens in transit.
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_URL'],
      message: `must use https in ${env.ENVIRONMENT}`,
    })
  }
})

/** Validated, typed environment configuration. */
export type Env = z.infer<typeof schema>

/** Thrown by {@link parseEnv} with every invalid variable listed, one per line. */
export class EnvError extends Error {
  /**
   * @param issues - Human-readable `NAME: problem` lines.
   */
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`)
    this.name = 'EnvError'
  }
}

/**
 * Validate environment variables.
 *
 * Pure (no `process.exit`) so it can be table-tested; {@link loadEnv} is the boot-time wrapper.
 * Issue messages name the variable but never echo its value, which may be a secret.
 *
 * @param source - The variables to validate, usually `process.env`.
 * @returns The typed configuration.
 * @throws EnvError listing every invalid variable.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    )
  }
  return parsed.data
}

/**
 * Validate `process.env` at boot, exiting with a readable report if anything is wrong.
 *
 * Fails fast so a misconfigured deploy never starts serving traffic.
 *
 * @returns The typed configuration.
 */
export function loadEnv(): Env {
  try {
    return parseEnv(process.env)
  } catch (error) {
    if (error instanceof EnvError) {
      // The logger is configured from this env, so it is not available yet.
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}
