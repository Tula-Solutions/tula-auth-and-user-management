import { z } from 'zod'
import { PASSWORD_POLICY_PRESETS, PasswordPolicySchema } from './password-policy'

/** App name used until an environment sets its own. Emails and prebuilt screens show it. */
export const DEFAULT_APP_NAME = 'Tula'

/** Longest app name, in characters. It is put in email subjects, so it stays short. */
export const MAX_APP_NAME_LENGTH = 64

/** Most web origins one environment may allow. */
export const MAX_ALLOWED_ORIGINS = 50

/** Most redirect URLs one environment may allow. */
export const MAX_ALLOWED_REDIRECT_URLS = 100

/** Longest audit retention that can be set, in days (ten years). */
export const MAX_AUDIT_RETENTION_DAYS = 3650

// Control characters and line or paragraph separators. The name is written into email headers
// and HTML, so anything that could start a new header line is refused at the door.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]/u

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]{2,45}\\])`
const PORT = '(?::([1-9][0-9]{0,4}))?'
const HTTPS_ORIGIN = new RegExp(`^https://${HOST}${PORT}$`)
const LOOPBACK_ORIGIN = new RegExp(`^http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])${PORT}$`)
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

function isWebOrigin(value: string): boolean {
  const matched = HTTPS_ORIGIN.exec(value) ?? LOOPBACK_ORIGIN.exec(value)
  if (!matched) {
    return false
  }
  const port = matched[1] === undefined ? null : Number(matched[1])
  // Browsers leave the default port out of `Origin`, so an entry that spells it out could
  // never match a request.
  const defaultPort = value.startsWith('https://') ? 443 : 80
  return port === null || (port <= 65_535 && port !== defaultPort)
}

function isRedirectUrl(value: string): boolean {
  if (value.includes('*') || /\s/.test(value)) {
    return false
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    return false
  }
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
}

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/**
 * A web origin exactly as a browser sends it in `Origin`: scheme, lowercase host and an optional
 * non-default port. No path, no trailing slash and no wildcard, because origins are compared by
 * exact match. `http://` is accepted for `localhost`, `127.0.0.1` and `[::1]` only.
 */
export const WebOriginSchema = z
  .string()
  .max(255)
  .refine(isWebOrigin, {
    message:
      'must be an origin such as https://app.example.com (lowercase, no path, no wildcard; http only for localhost)',
  })
  .meta({ ref: 'WebOrigin' })

/**
 * An absolute URL a flow may send the user back to. `https://` only, or `http://` for
 * `localhost`, `127.0.0.1` and `[::1]`; no credentials, no fragment and no wildcard.
 */
export const RedirectUrlSchema = z
  .string()
  .max(2048)
  .refine(isRedirectUrl, {
    message:
      'must be an absolute https URL (http only for localhost) with no credentials, fragment or wildcard',
  })
  .meta({ ref: 'RedirectUrl' })

const App = z.object({
  /**
   * What the product is called. Every email names it in the subject and the body, and
   * `/v1/client/config` returns it. Defaults to {@link DEFAULT_APP_NAME}.
   */
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_APP_NAME_LENGTH)
    .refine((name) => !UNPRINTABLE.test(name), {
      message: 'must not contain control characters or line breaks',
    })
    .default(DEFAULT_APP_NAME),
  /** Where users can ask for help. Shown in emails and returned by `/v1/client/config`. */
  supportEmail: z.email().max(254).nullable().default(null),
})

const PasswordMethod = z.object({ enabled: z.boolean().default(true) })

const atLeastOneMethod = {
  message: 'at least one sign-in method must stay enabled',
} as const

function anyEnabled(methods: Record<string, { enabled: boolean }>): boolean {
  return Object.values(methods).some((method) => method.enabled)
}

const Urls = z.object({
  /** Browser origins that may call the client API and read its responses (CORS). */
  allowedOrigins: z
    .array(WebOriginSchema)
    .max(MAX_ALLOWED_ORIGINS)
    .refine(distinct, { message: 'must not list an origin twice' })
    .default([]),
  /**
   * URLs a flow may redirect to. Validated and stored only: nothing redirects yet (magic links
   * and OAuth callbacks, Phase 1.7 and 1.9, are the first to read it).
   */
  allowedRedirectUrls: z
    .array(RedirectUrlSchema)
    .max(MAX_ALLOWED_REDIRECT_URLS)
    .refine(distinct, { message: 'must not list a URL twice' })
    .default([]),
})

const Audit = z.object({
  /**
   * Days an audit entry is kept; `null` (the default) keeps entries for ever. Validated and
   * stored only: the retention job does not delete audit entries yet (ADR 0018).
   */
  retentionDays: z.number().int().min(1).max(MAX_AUDIT_RETENTION_DAYS).nullable().default(null),
})

const password = PasswordPolicySchema.default(PASSWORD_POLICY_PRESETS.recommended)
const version = z.literal(1).default(1)

/**
 * An environment's settings: everything about how one tenant's sign-in behaves that is not a
 * secret. `PUT /v1/admin/settings` replaces the whole document.
 *
 * Every field has a default, so `{}` is a valid document and means "the defaults". Because of
 * that an unknown key is refused rather than ignored: a misspelt `pasword` section would
 * otherwise silently reset the password policy to its default.
 *
 * - `version`: the format of this document, `1`.
 * - `app`: the product's name and support address.
 * - `password`: the password policy (see `PasswordPolicy`).
 * - `signIn.methods`: which first factors are offered. `password` is the only one today; at
 *   least one must stay enabled.
 * - `urls`: browser origins allowed by CORS, and URLs flows may redirect to.
 * - `audit.retentionDays`: how long audit entries are kept.
 */
export const EnvironmentSettingsSchema = z
  .strictObject({
    version,
    app: App.strict().prefault({}),
    password,
    signIn: z
      .strictObject({
        methods: z
          .strictObject({ password: PasswordMethod.strict().prefault({}) })
          .refine(anyEnabled, atLeastOneMethod)
          .prefault({}),
      })
      .prefault({}),
    urls: Urls.strict().prefault({}),
    audit: Audit.strict().prefault({}),
  })
  .meta({ ref: 'EnvironmentSettings' })

/** An environment's settings. */
export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>

/** A sign-in method that can be switched on or off in {@link EnvironmentSettingsSchema}. */
export type SignInMethod = keyof EnvironmentSettings['signIn']['methods']

// The same document, but unknown keys are dropped instead of refused. Used for documents read
// back from storage, which a newer server may have written before a rollback.
const Stored = z.object({
  version,
  app: App.prefault({}),
  password,
  signIn: z
    .object({
      methods: z
        .object({ password: PasswordMethod.prefault({}) })
        .refine(anyEnabled, atLeastOneMethod)
        .prefault({}),
    })
    .prefault({}),
  urls: Urls.prefault({}),
  audit: Audit.prefault({}),
})

/** The settings of an environment that has never saved any. */
export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = EnvironmentSettingsSchema.parse({})

/**
 * Read a settings document that was stored earlier, possibly by another version of the server.
 *
 * Fields added since it was written take their defaults, and keys this version does not know are
 * dropped rather than refused, so a rollback never leaves an environment unreadable.
 *
 * @param stored - The stored document.
 * @returns The settings.
 * @throws ZodError when a known field holds a value that is not valid.
 *
 * @example
 * ```ts
 * parseStoredEnvironmentSettings({ app: { name: 'Acme' } }).password.minLength // 10
 * ```
 */
export function parseStoredEnvironmentSettings(stored: unknown): EnvironmentSettings {
  return Stored.parse(stored)
}

/**
 * What `GET /v1/client/config` returns: everything a client needs to draw a sign-in screen, and
 * nothing an operator would not put on that screen.
 *
 * - `app.supportEmail` is included because a sign-in screen links to it ("Need help?") and every
 *   email already shows it. It is `null` when none is set.
 * - `signIn.methods` lists the enabled methods by name. It is an array of plain strings, not an
 *   enum, so a client built against this version keeps working when a server offers a method it
 *   does not know; it should ignore those.
 * - The allow-lists (`urls`) and the audit settings are deliberately absent.
 */
export const ClientConfigSchema = z
  .object({
    app: z.object({ name: z.string(), supportEmail: z.string().nullable() }),
    signIn: z.object({ methods: z.array(z.string()) }),
    password: PasswordPolicySchema,
  })
  .meta({ ref: 'ClientConfig' })

/** The public configuration of an environment. */
export type ClientConfig = z.infer<typeof ClientConfigSchema>
