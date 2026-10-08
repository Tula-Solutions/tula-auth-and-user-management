import { z } from 'zod'

/** Deployment tiers. Real side effects (email, breach API) are gated on these, never on NODE_ENV. */
export const TIERS = ['local', 'dev', 'staging', 'prod'] as const

/** A deployment tier. */
export type Tier = (typeof TIERS)[number]

/** The values of `WEBHOOK_WORKER`: where a deployment makes its webhook deliveries. */
export const WEBHOOK_WORKER_MODES = ['api', 'separate'] as const

/** Where a deployment makes its webhook deliveries: in its API instances, or in a worker. */
export type WebhookWorkerMode = (typeof WEBHOOK_WORKER_MODES)[number]

/**
 * Tiers that face real users: they must send real email, check real breach data and share
 * rate-limit, lockout and revoked-session state through Redis.
 */
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

/** The shortest `TULA_ADMIN_TOKEN` accepted: 32 characters of hex are 128 bits. */
export const MIN_ADMIN_TOKEN_LENGTH = 32

/** Fewer distinct characters than this is not what a random generator produces. */
const MIN_ADMIN_TOKEN_DISTINCT = 10

/** Characters in a row each one above (or each one below) the last: `abcdefgh`, `87654321`. */
const MAX_ADMIN_TOKEN_RUN = 7

/** Words of a value copied from an example or typed along a keyboard instead of generated. */
const PLACEHOLDER_TOKEN =
  /change[-_ ]?me|example|placeholder|password|default|your[-_]|replace[-_]|x{8}|0123456789|qwerty|asdfgh/i

/** Whether a value is a shorter block written out at least twice (`abc123abc123ab`). */
function repeatsABlock(value: string): boolean {
  for (let period = 1; period <= value.length / 2; period += 1) {
    let periodic = true
    for (let index = period; index < value.length && periodic; index += 1) {
      periodic = value[index] === value[index - period]
    }
    if (periodic) {
      return true
    }
  }
  return false
}

/** The longest stretch of characters that count up, or count down, one at a time. */
function longestRun(value: string): number {
  let longest = 1
  let length = 1
  let direction = 0
  for (let index = 1; index < value.length; index += 1) {
    const step = value.charCodeAt(index) - value.charCodeAt(index - 1)
    length = Math.abs(step) === 1 && step === direction ? length + 1 : Math.abs(step) === 1 ? 2 : 1
    direction = Math.abs(step) === 1 ? step : 0
    longest = Math.max(longest, length)
  }
  return longest
}

/**
 * Whether a `TULA_ADMIN_TOKEN` is plainly not a generated value: too few distinct characters,
 * a block written out twice, or a long run such as `abcdefgh`.
 *
 * **A floor against accidents, not a measure of randomness.** No check of one value can tell
 * a random token from a chosen one: this refuses what a person types to get past a length
 * check, and a value that passes may still be guessable. The guarantee the deployment relies
 * on is how the token is made: `openssl rand -hex 32`, or the one `create-tula` generates.
 * A generated value of the minimum length fails it with a probability below one in a million.
 *
 * @param value - The token.
 * @returns Whether it is refused.
 *
 * @example
 * ```ts
 * looksTyped('abcabcabcabcabcabcabcabcabcabcabcabc') // true
 * ```
 */
export function looksTyped(value: string): boolean {
  return (
    new Set(value).size < MIN_ADMIN_TOKEN_DISTINCT ||
    repeatsABlock(value) ||
    longestRun(value) > MAX_ADMIN_TOKEN_RUN
  )
}

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
   * Sender of verification and security emails: `name@domain` or `Name <name@domain>`. Live
   * tiers must set a real domain, or mail providers will reject or junk the messages.
   */
  MAIL_FROM: z
    .string()
    .regex(
      /^(?:[^<>@]*<[^<>@\s]+@[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+)$/,
      'must be `name@domain` or `Name <name@domain>`'
    )
    .default('Tula Auth <no-reply@localhost>'),
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
  /**
   * The password policy of an environment that has saved no settings of its own. A default, not
   * an override: once an environment saves settings (`PUT /v1/admin/settings`), its own
   * `password` section applies (ADR 0018).
   */
  PASSWORD_POLICY: z.enum(['recommended', 'strict', 'legacy']).default('recommended'),
  /**
   * Browser origins, comma-separated. They are allowed for `/v1/admin/*`, and are the default
   * `urls.allowedOrigins` of an environment that has saved no settings of its own (ADR 0018).
   */
  CORS_ORIGINS: list,
  /**
   * Trust `X-Forwarded-For` for the client IP. Enable only behind a proxy that overwrites the
   * header: otherwise any client can pick its own rate-limit bucket.
   */
  TRUST_PROXY: flag,
  /**
   * Directory of the dashboard's build output, served as static files at `/dashboard`
   * (ADR 0032). Optional: unset, `apps/dashboard/dist` next to the API is used. A directory
   * that does not exist or holds no `index.html` means no dashboard: `/dashboard` is then an
   * unknown path and the API works as before.
   */
  DASHBOARD_DIR: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().max(4096).optional()
  ),
  /**
   * `true` serves every OAuth provider from the built-in mock provider, whose consent page lets
   * a developer type the address the "provider" asserts (ADR 0026). For local development and
   * tests, where nobody has real OAuth credentials. Refused outside `ENVIRONMENT=local`.
   */
  OAUTH_MOCK_PROVIDER: flag,
  /**
   * What sends text messages (ADR 0037).
   *
   * - `none` (the default): nothing does. An environment that switches SMS on in its settings
   *   gets `sms.unavailable` for every send, and no message is written anywhere.
   * - `dev`: the development inbox. Nothing is sent; the last messages are kept in the
   *   process's memory and readable at `GET /v1/dev/sms/messages`. Refused outside
   *   `ENVIRONMENT=local` and with a `PUBLIC_URL` that is not loopback: whoever can read the
   *   inbox reads every code.
   */
  SMS_PROVIDER: z.enum(['none', 'dev']).default('none'),
  /**
   * Days an instance audit entry (dashboard sign-ins, workspaces, projects) is kept before the
   * retention job deletes it. At least 30: the log is what an operator reads after an
   * incident. Environments' audit logs are not affected: each has its own period, the
   * `audit.retentionDays` setting (ADR 0017).
   */
  INSTANCE_AUDIT_RETENTION_DAYS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.coerce.number().int().min(30).max(36_500).default(365)
  ),
  /**
   * `on` or `off`: whether the API reference page is served at `/v1/docs`. Unset (or blank),
   * it is on in the `local` and `dev` tiers and off in `staging` and `prod`
   * ({@link apiDocsDefault}). The page is HTML on the origin the dashboard's session lives
   * on; a deployment that does not need it should not serve it (ADR 0032). The OpenAPI
   * document at `/v1/openapi.json` is served either way.
   */
  API_DOCS: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['on', 'off']).optional()
  ),
  /**
   * The instance admin token: the credential of `/v1/instance/*` (`tula doctor`, and the
   * dashboard's sign-in). Optional: without it those routes do not exist (404). It is the most
   * powerful credential of a deployment, so a short, repeated, sequential or placeholder
   * value fails the boot instead of being accepted. That check is a floor against accidents,
   * not a measure of randomness ({@link looksTyped}): generate the token with
   * `openssl rand -hex 32`. See ADR 0031.
   *
   * While it is set, `PUBLIC_URL` must be https or a loopback address, in every tier: the
   * token is sent as a bearer credential and the dashboard's cookie is `Secure` only over
   * https.
   */
  TULA_ADMIN_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .min(
        MIN_ADMIN_TOKEN_LENGTH,
        `must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters, e.g. \`openssl rand -hex 32\``
      )
      .max(256, 'must be at most 256 characters')
      .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII without spaces')
      .superRefine((value, context) => {
        // One problem per value: the first that applies. (A value over the length limit is
        // not looked at further.)
        if (value.length > 256) {
          return
        }
        if (PLACEHOLDER_TOKEN.test(value)) {
          context.addIssue({
            code: 'custom',
            message: 'looks like a placeholder; generate one with `openssl rand -hex 32`',
          })
        } else if (looksTyped(value)) {
          context.addIssue({
            code: 'custom',
            message:
              'is too repetitive or sequential to be a random value; generate one with `openssl rand -hex 32`',
          })
        }
      })
      .optional()
  ),
  /**
   * Redis (or Valkey) for the state API instances must share: rate limits, the password lockout
   * and the list of revoked sessions. `rediss://` for TLS. Unset (or blank) in `local` and `dev`
   * keeps that state in process memory, which is correct for one instance only; live tiers must
   * set it (ADR 0016).
   */
  REDIS_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.url({ protocol: /^(rediss?|valkeys?)$/ }).optional()
  ),
  /**
   * Where webhook deliveries are made (ADR 0034, "The worker as its own service"). `api`, the
   * default: inside every API instance. `separate`: only in a worker process (the same image
   * started with `bun run src/worker.ts`), and an API instance then makes no request to a
   * webhook endpoint at all. One value for the whole deployment, the same in every container:
   * what a process is follows from the command it was started with, never from this.
   *
   * A closed set, matched exactly: a misspelling stops the boot, because falling back to
   * either value would decide, silently, who delivers.
   */
  WEBHOOK_WORKER: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(WEBHOOK_WORKER_MODES, 'must be `api` or `separate`').default('api')
  ),
})

/** Host names that only ever mean this machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether a URL's host is this machine: `localhost`, `127.0.0.1`, `[::1]` or a name under
 * `.localhost` (RFC 6761). Compared on the parsed host, so `localhost.example.com` and
 * `127.0.0.1.example.com` are not loopback. `0.0.0.0` and LAN addresses are not either.
 *
 * @param url - An absolute URL. Anything that does not parse as one is not loopback.
 * @returns `true` when its host is loopback.
 */
export function isLoopbackUrl(url: string): boolean {
  const host = parsedUrl(url)?.hostname.toLowerCase()
  return host !== undefined && isLoopbackName(host)
}

/** The one rule both functions here judge a host name by. Lower case, no port. */
function isLoopbackName(name: string): boolean {
  return LOOPBACK_HOSTS.has(name) || name.endsWith('.localhost')
}

// A `Host` header: a name or an IPv4 address, or an IPv6 address in brackets, then an
// optional port. Nothing else: no user information, path, space or empty name.
const HOST_HEADER = /^([a-z0-9.-]+|\[[0-9a-f:]+\])(:[0-9]{1,5})?$/

/**
 * Whether a request's `Host` header names this machine, by the rule of {@link isLoopbackUrl},
 * on any port.
 *
 * What a development-only route asks before it answers: a page that reaches this port by DNS
 * rebinding is same-origin with itself (no `Origin`, `Sec-Fetch-Site: same-origin`), but its
 * `Host` header still names the attacker's domain.
 *
 * @param host - The header's value (`localhost:3003`), or `undefined` when there was none.
 * @returns `true` only for a well-formed loopback host. Missing or malformed is `false`.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  const match = host === undefined ? null : HOST_HEADER.exec(host.toLowerCase())
  return match?.[1] !== undefined && isLoopbackName(match[1])
}

/**
 * Parse a variable for a cross-field rule. Those rules run even when the field's own rule has
 * already refused the value, so a value that is not a URL must not throw here: the field's
 * issue is what the operator should read.
 */
function parsedUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

const schema = fields.superRefine((env, ctx) => {
  if (env.SMS_PROVIDER === 'dev' && env.ENVIRONMENT !== 'local') {
    // As for the mock provider: the development inbox hands every code to whoever asks, so
    // it must be impossible wherever other people can reach the API, `dev` included.
    ctx.addIssue({
      code: 'custom',
      path: ['SMS_PROVIDER'],
      message: `dev is only allowed with ENVIRONMENT=local, not ${env.ENVIRONMENT}: the development inbox shows every code to anyone who can reach this API`,
    })
  }
  if (env.SMS_PROVIDER === 'dev' && !isLoopbackUrl(env.PUBLIC_URL)) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMS_PROVIDER'],
      message:
        'dev is only allowed when PUBLIC_URL is a loopback address (localhost, 127.0.0.1, [::1] or a *.localhost name): the development inbox shows every code to anyone who can reach this API',
    })
  }
  if (env.OAUTH_MOCK_PROVIDER && env.ENVIRONMENT !== 'local') {
    // Not a "live tiers" rule: the mock provider signs anyone in as any address they type, so
    // it must be impossible in every deployment other people can reach, `dev` included.
    ctx.addIssue({
      code: 'custom',
      path: ['OAUTH_MOCK_PROVIDER'],
      message: `is only allowed with ENVIRONMENT=local, not ${env.ENVIRONMENT}: the mock provider signs in anyone as any address`,
    })
  }
  if (env.OAUTH_MOCK_PROVIDER && !isLoopbackUrl(env.PUBLIC_URL)) {
    // The tier is a label an operator types. An API that tells other machines where to reach it
    // is not a developer's own machine, whatever the label says.
    ctx.addIssue({
      code: 'custom',
      path: ['OAUTH_MOCK_PROVIDER'],
      message:
        'is only allowed when PUBLIC_URL is a loopback address (localhost, 127.0.0.1, [::1] or a *.localhost name): the mock provider signs in anyone as any address',
    })
  }
  if (!LIVE_TIERS.has(env.ENVIRONMENT)) {
    if (
      env.TULA_ADMIN_TOKEN !== undefined &&
      parsedUrl(env.PUBLIC_URL)?.protocol !== 'https:' &&
      !isLoopbackUrl(env.PUBLIC_URL)
    ) {
      // Not a "live tiers" rule either. The admin token is the deployment's most powerful
      // credential and the dashboard's cookie is `Secure` only over https: on a plain-http
      // address other machines reach, both would cross the network in clear text, whatever
      // the tier is called. (The live tiers require https outright, below.)
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_URL'],
        message:
          'must use https, or be a loopback address (localhost, 127.0.0.1, [::1] or a *.localhost name), while TULA_ADMIN_TOKEN is set: the admin token and the dashboard session would otherwise cross the network unencrypted',
      })
    }
    return
  }
  const smtpHost = parsedUrl(env.SMTP_URL)?.hostname.toLowerCase()
  // `mailpit` is the catch-all inbox of the Compose stack: mail sent there reaches nobody.
  if (smtpHost === '127.0.0.1' || smtpHost === 'localhost' || smtpHost === 'mailpit') {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_URL'],
      message: `must be a real mail relay in ${env.ENVIRONMENT}, not the local Mailpit`,
    })
  }
  if (/@localhost>?$/i.test(env.MAIL_FROM)) {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_FROM'],
      message: `must be a real sender address in ${env.ENVIRONMENT}`,
    })
  }
  if (env.BREACH_CHECK !== 'hibp') {
    ctx.addIssue({
      code: 'custom',
      path: ['BREACH_CHECK'],
      message: `must be \`hibp\` in ${env.ENVIRONMENT}`,
    })
  }
  if (!env.REDIS_URL) {
    // Memory adapters count per process: a second instance would double every limit and keep
    // honouring sessions the first one revoked. A live deployment must not depend on never
    // being scaled, so the shared store is required rather than assumed.
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message: `is required in ${env.ENVIRONMENT}: rate limits, lockout and revoked sessions must be shared between instances`,
    })
  }
  const publicUrl = parsedUrl(env.PUBLIC_URL)
  if (publicUrl && publicUrl.protocol !== 'https:') {
    // Session cookies are `Secure`; a plain-http issuer would also leak tokens in transit.
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_URL'],
      message: `must use https in ${env.ENVIRONMENT}`,
    })
  }
})

/**
 * Whether the API reference page is served when `API_DOCS` is not set: on where a developer
 * runs the API (`local`, `dev`), off where it serves real users.
 *
 * @param tier - The deployment's tier.
 * @returns `true` in `local` and `dev`.
 */
export function apiDocsDefault(tier: Tier): boolean {
  return !LIVE_TIERS.has(tier)
}

/** Validated, typed environment configuration. `API_DOCS` is resolved to its tier's default. */
export type Env = Omit<z.infer<typeof schema>, 'API_DOCS'> & { API_DOCS: boolean }

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
  const { API_DOCS, ...rest } = parsed.data
  return {
    ...rest,
    API_DOCS: API_DOCS === undefined ? apiDocsDefault(rest.ENVIRONMENT) : API_DOCS === 'on',
  }
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
