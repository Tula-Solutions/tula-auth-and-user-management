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

/**
 * Shortest `password.minLength` the settings API accepts (NIST SP 800-63B's minimum for a
 * user-chosen password). Every built-in preset is at or above it.
 */
export const MIN_PASSWORD_MIN_LENGTH = 8

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

const AllowedOrigins = z
  .array(WebOriginSchema)
  .max(MAX_ALLOWED_ORIGINS)
  .refine(distinct, { message: 'must not list an origin twice' })

const Urls = z.object({
  /** Browser origins that may call the client API and read its responses (CORS). */
  allowedOrigins: AllowedOrigins.default([]),
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

const Notifications = z.object({
  /**
   * Email the account's address when its password is changed, reset, set by an administrator or
   * added. On by default; turning it off is recorded as a weakening.
   */
  passwordChanged: z.boolean().default(true),
  /**
   * Email the account's address when it is signed in to from a device family none of its other
   * sessions has (ADR 0023). On by default; turning it off is recorded as a weakening.
   */
  newSignIn: z.boolean().default(true),
})

const password = PasswordPolicySchema.default(PASSWORD_POLICY_PRESETS.recommended)
const version = z.literal(1).default(1)

const SignIn = z
  .strictObject({
    methods: z
      .strictObject({ password: PasswordMethod.strict().prefault({}) })
      .refine(anyEnabled, atLeastOneMethod)
      .prefault({}),
  })
  .prefault({})

const minLengthFloor = {
  message: `must be at least ${MIN_PASSWORD_MIN_LENGTH}`,
  path: ['password', 'minLength'],
}

/**
 * An environment's settings: everything about how one tenant's sign-in behaves that is not a
 * secret. This is the whole document, as it is stored and as `GET /v1/admin/settings` returns
 * it. What `PUT /v1/admin/settings` accepts is {@link EnvironmentSettingsInputSchema}.
 *
 * Every field has a default, so `{}` is a valid document and means "the defaults". Because of
 * that an unknown key is refused rather than ignored: a misspelt `pasword` section would
 * otherwise silently reset the password policy to its default.
 *
 * - `version`: the format of this document, `1`.
 * - `app`: the product's name and support address.
 * - `password`: the password policy (see `PasswordPolicy`). `minLength` cannot be set below
 *   {@link MIN_PASSWORD_MIN_LENGTH}.
 * - `signIn.methods`: which first factors are offered. `password` is the only one today; at
 *   least one must stay enabled.
 * - `urls`: browser origins allowed by CORS, and URLs flows may redirect to.
 * - `audit.retentionDays`: how long audit entries are kept.
 * - `notifications`: which security notices are emailed to an account's owner
 *   (`passwordChanged`, `newSignIn`). Both are on unless switched off.
 */
export const EnvironmentSettingsSchema = z
  .strictObject({
    version,
    app: App.strict().prefault({}),
    password,
    signIn: SignIn,
    urls: Urls.strict().prefault({}),
    audit: Audit.strict().prefault({}),
    notifications: Notifications.strict().prefault({}),
  })
  // On the document, not on `PasswordPolicy` itself: that shape is shared with every SDK and
  // with documents stored before the floor existed.
  .refine((settings) => settings.password.minLength >= MIN_PASSWORD_MIN_LENGTH, minLengthFloor)
  .meta({ ref: 'EnvironmentSettings' })

/** An environment's settings. */
export type EnvironmentSettings = z.infer<typeof EnvironmentSettingsSchema>

/**
 * The body of `PUT /v1/admin/settings`: the settings document, except that two fields have **no
 * default of their own** and so stay absent when they are left out.
 *
 * - `password` left out takes the deployment's `PASSWORD_POLICY`.
 * - `urls.allowedOrigins` left out takes the deployment's `CORS_ORIGINS`.
 *
 * Those are the values `GET` returns at revision 0. The server fills them in, on every replace
 * and whatever was saved before, so saving a partial document never loosens the password policy
 * or locks browser apps out by accident. A value that is sent, an empty list included, is taken
 * as sent. Everything else is as in {@link EnvironmentSettingsSchema}: other fields left out
 * take their defaults, and unknown keys are refused.
 *
 * The shape says which of the two were sent, so a server cannot store the document without
 * first deciding what the missing ones are.
 */
export const EnvironmentSettingsInputSchema = z
  .strictObject({
    version,
    app: App.strict().prefault({}),
    password: PasswordPolicySchema.optional(),
    signIn: SignIn,
    urls: z
      .strictObject({
        /** Leave out to take the deployment's `CORS_ORIGINS`; send `[]` to allow no origin. */
        allowedOrigins: AllowedOrigins.optional(),
        allowedRedirectUrls: Urls.shape.allowedRedirectUrls,
      })
      .prefault({}),
    audit: Audit.strict().prefault({}),
    notifications: Notifications.strict().prefault({}),
  })
  .refine(
    (settings) =>
      settings.password === undefined || settings.password.minLength >= MIN_PASSWORD_MIN_LENGTH,
    minLengthFloor
  )
  .meta({ ref: 'EnvironmentSettingsInput' })

/** A settings document as sent to `PUT /v1/admin/settings`. */
export type EnvironmentSettingsInput = z.infer<typeof EnvironmentSettingsInputSchema>

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
  notifications: Notifications.prefault({}),
})

/** The settings of an environment that has never saved any. */
export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = EnvironmentSettingsSchema.parse({})

/** A stored settings document as read back. */
export interface StoredEnvironmentSettingsRead {
  settings: EnvironmentSettings
  /** How many list entries were left out because this version would not accept them. */
  dropped: number
}

interface ListRule {
  entry: z.ZodType<string>
  max: number
}

const LIST_RULES: Record<keyof EnvironmentSettings['urls'], ListRule> = {
  allowedOrigins: { entry: WebOriginSchema, max: MAX_ALLOWED_ORIGINS },
  allowedRedirectUrls: { entry: RedirectUrlSchema, max: MAX_ALLOWED_REDIRECT_URLS },
}

/** The entries of a stored list this version accepts, and how many it does not. */
function usable(list: unknown, rule: ListRule): { kept: string[]; dropped: number } {
  if (!Array.isArray(list)) {
    // Something that is not a list at all counts as one unusable entry.
    return { kept: [], dropped: 1 }
  }
  const kept = new Set<string>()
  for (const entry of list) {
    if (kept.size < rule.max && rule.entry.safeParse(entry).success) {
      kept.add(entry)
    }
  }
  return { kept: [...kept], dropped: list.length - kept.size }
}

/**
 * Read a settings document that was stored earlier, possibly by another version of the server,
 * and say what had to be left out.
 *
 * Settings are read on the request path, so a stored document must not be able to take an
 * environment down:
 * - fields added since it was written take their defaults;
 * - keys this version does not know are dropped rather than refused (a rollback);
 * - an entry of `urls.allowedOrigins` or `urls.allowedRedirectUrls` that this version would not
 *   accept (not a valid origin or URL, a duplicate, or beyond the list's limit) is left out
 *   rather than failing the read. Leaving an entry out of an allow-list only ever allows less.
 *
 * @param stored - The stored document.
 * @returns The settings, and how many list entries were left out.
 * @throws ZodError when another known field holds a value that is not valid. Nothing the API
 *   stores can do that: every document is validated in full before it is written.
 *
 * @example
 * ```ts
 * readStoredEnvironmentSettings({ urls: { allowedOrigins: ['http://app.lan'] } })
 * // { settings: { …, urls: { allowedOrigins: [], … } }, dropped: 1 }
 * ```
 */
export function readStoredEnvironmentSettings(stored: unknown): StoredEnvironmentSettingsRead {
  if (typeof stored !== 'object' || stored === null) {
    return { settings: Stored.parse(stored), dropped: 0 }
  }
  const { urls } = stored as { urls?: unknown }
  if (typeof urls !== 'object' || urls === null) {
    // A `urls` that is not a section at all is read as a missing one.
    return { settings: Stored.parse({ ...stored, urls: undefined }), dropped: 0 }
  }
  const lists: Record<string, string[]> = {}
  let dropped = 0
  for (const [name, rule] of Object.entries(LIST_RULES)) {
    const list = (urls as Record<string, unknown>)[name]
    if (list !== undefined) {
      const result = usable(list, rule)
      lists[name] = result.kept
      dropped += result.dropped
    }
  }
  return {
    settings: Stored.parse({ ...stored, urls: { ...urls, ...lists } }),
    dropped,
  }
}

/**
 * Read a settings document that was stored earlier: {@link readStoredEnvironmentSettings}
 * without the count.
 *
 * @param stored - The stored document.
 * @returns The settings.
 * @throws ZodError when a known field other than a list entry holds a value that is not valid.
 *
 * @example
 * ```ts
 * parseStoredEnvironmentSettings({ app: { name: 'Acme' } }).password.minLength // 10
 * ```
 */
export function parseStoredEnvironmentSettings(stored: unknown): EnvironmentSettings {
  return readStoredEnvironmentSettings(stored).settings
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
 * - The allow-lists (`urls`), the audit settings and the notice switches (`notifications`) are
 *   deliberately absent.
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
