import { env, isConfigError, parseConfig, providerSecret } from '@tula/config'
import {
  EnvironmentSettingsInputSchema,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  oauthProviderWeakenings,
  parseStoredEnvironmentSettings,
  settingsWeakenings,
} from '@tula/contract'
import * as z from 'zod'
import { ToolError } from './errors'
import type { ReadOnlyAdmin } from './read-only'
import { cleanText, MAX_ARRAY_ITEMS, MAX_STRING_CHARS, project, S, type Shape } from './sanitize'
import { MANAGED_BY_SHAPE, SETTINGS_DOCUMENT_SHAPE } from './settings-shape'

/**
 * The most settings one call drafts an edit for.
 *
 * @example
 * ```ts
 * input.settings.length <= MAX_DRAFTED_SETTINGS
 * ```
 */
export const MAX_DRAFTED_SETTINGS = 20

/** The longest path of a setting: eight segments of a record key's length would be longer. */
const MAX_PATH_CHARS = 200

/** The longest name of an environment variable a draft refers to. */
const MAX_VARIABLE_NAME_CHARS = 128

/** The most problems one refused draft lists. */
const MAX_PROBLEMS = 50

/** One segment of a setting's path: what a key of the settings document is made of. */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

/** A path: at most eight segments joined by full stops. Nothing here can scan twice. */
const PATH = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,7}$/

/**
 * Keys that are never a named entry of a map: the three that reach an object's prototype,
 * and `truncated`, the mark a projected record carries when it left an entry out.
 */
const NEVER_AN_ENTRY: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'truncated',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether two JSON values (a scalar, a list of strings) are the same. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The shape of the one setting a path names, or `undefined` when the path names none.
 *
 * The judge is {@link SETTINGS_DOCUMENT_SHAPE}, the allow-list `get_settings` returns the
 * document through: a setting no tool returns is a setting no tool drafts an edit for. A
 * path names a setting when it ends at a scalar or a list of strings; a section is not one.
 * Under a map of named entries (the session profiles) any name is a path, as long as it is
 * returned as it was given: a name the cleaning would change, or that reads as a secret,
 * names nothing.
 *
 * @param path - A path in the settings document, e.g. `password.minLength`.
 * @returns The setting's shape.
 *
 * @example
 * ```ts
 * settingShape('password.minLength') // { kind: 'number' }
 * settingShape('emails.templates.sign_in.body') // undefined: no tool returns the wording
 * ```
 */
export function settingShape(path: string): Shape | undefined {
  if (typeof path !== 'string' || path.length > MAX_PATH_CHARS || !PATH.test(path)) {
    return undefined
  }
  let shape: Shape = SETTINGS_DOCUMENT_SHAPE
  for (const segment of path.split('.')) {
    if (!SEGMENT.test(segment) || NEVER_AN_ENTRY.has(segment)) {
      return undefined
    }
    if (shape.kind === 'object') {
      const next: Shape | undefined = Object.hasOwn(shape.fields, segment)
        ? shape.fields[segment]
        : undefined
      if (!next) {
        return undefined
      }
      shape = next
    } else if (shape.kind === 'record') {
      if (cleanText(segment, 64) !== segment) {
        return undefined
      }
      shape = shape.of
    } else {
      return undefined
    }
  }
  if (shape.kind === 'array') {
    return shape.of.kind === 'string' ? shape : undefined
  }
  return shape.kind === 'object' || shape.kind === 'record' ? undefined : shape
}

/** Whether `name` is an environment variable's name by `@tula/config`'s own grammar. */
function isVariableName(name: string): boolean {
  try {
    // The grammar is `env()`'s: asked, never copied.
    return env(name).$env === name
  } catch {
    return false
  }
}

/**
 * Variables that hold a credential of the deployment or of the CLI. `tula apply` sends the
 * value of the variable an entry names to the server as the provider's client secret: an
 * entry that named one of these, applied unread, would hand that credential over. A closed
 * list of names, never a guess from a value's length or alphabet: the person who applies
 * reads every name (the result's notes say so).
 */
const DEPLOYMENT_CREDENTIALS: ReadonlySet<string> = new Set([
  'TULA_SECRET_KEY',
  'TULA_AGENT_KEY',
  'TULA_ADMIN_TOKEN',
  'TULA_MASTER_KEY',
  'TULA_API_DB_PASSWORD',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'REDIS_URL',
  'SMTP_URL',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY_SECRET',
])

/** The per-environment forms of the CLI's keys: `TULA_SECRET_KEY_<NAME>`, `TULA_AGENT_KEY_<NAME>`. */
const DEPLOYMENT_CREDENTIAL_PREFIXES = ['TULA_SECRET_KEY_', 'TULA_AGENT_KEY_'] as const

function isDeploymentCredential(name: string): boolean {
  return (
    DEPLOYMENT_CREDENTIALS.has(name) ||
    DEPLOYMENT_CREDENTIAL_PREFIXES.some((prefix) => name.startsWith(prefix))
  )
}

const settingValue = z
  .union([
    z.string().max(MAX_STRING_CHARS),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.string().max(MAX_STRING_CHARS)).max(MAX_ARRAY_ITEMS),
  ])
  .describe(
    'The value the setting should have: a string, a number, a boolean, null (none), or a list of strings given whole (a list is replaced, never added to).'
  )

const settingChange = z.strictObject({
  path: z
    .string()
    .max(MAX_PATH_CHARS)
    .regex(PATH)
    .refine((path) => settingShape(path) !== undefined, {
      message: 'not a setting a tool returns: get_settings shows every setting that can be named',
    })
    .describe(
      'The setting, as a path in the settings document get_settings returns, e.g. "password.minLength", "signIn.methods.emailCode.enabled", "urls.allowedOrigins" or "sessions.profiles.web.idleTimeout".'
    ),
  value: settingValue,
})

const providerChange = z.strictObject({
  provider: z.enum(OAUTH_PROVIDERS).describe('The provider.'),
  // The one thing of a secret a tool takes: where it is, never what it is.
  secretEnv: z
    .string()
    .max(MAX_VARIABLE_NAME_CHARS)
    .refine(isVariableName, {
      message: 'the NAME of an environment variable (capitals, digits, underscores), not a value',
    })
    .refine((name) => !isDeploymentCredential(name), {
      // Fixed words: the name that was refused is not repeated.
      message:
        'a credential of the deployment or of the CLI is never where a provider’s secret is read from',
    })
    .describe(
      'The NAME of the environment variable that holds the provider’s client secret (Apple: its private key), e.g. "GOOGLE_CLIENT_SECRET". Never the secret itself: this tool takes no secret.'
    ),
  enabled: z.boolean().optional().describe('Whether the provider is switched on.'),
  clientId: z.string().min(1).max(MAX_STRING_CHARS).optional().describe('The public client id.'),
  teamId: z.string().min(1).max(64).optional().describe('Apple only: the team id.'),
  keyId: z.string().min(1).max(64).optional().describe('Apple only: the key id.'),
  tenant: z.string().min(1).max(64).optional().describe('Microsoft only: the tenant alias or id.'),
  additionalClientIds: z
    .array(z.string().min(1).max(128))
    .max(8)
    .optional()
    .describe('Google only: the client ids of native apps, given whole.'),
})

/**
 * The input of `draft_settings_change`: the settings that should change, each by its path
 * and its new value, and the providers that should, each with the **name** of the variable
 * its secret is read from. Strict at every level: there is no field for a secret, a
 * credential, a file path, a webhook endpoint, a hook or a native app.
 *
 * @example
 * ```ts
 * draftSettingsChangeInput.parse({ settings: [{ path: 'mfa.policy', value: 'required' }] })
 * ```
 */
export const draftSettingsChangeInput = z
  .strictObject({
    settings: z
      .array(settingChange)
      .max(MAX_DRAFTED_SETTINGS)
      .default([])
      .describe('The settings to change, each once.'),
    providers: z
      .array(providerChange)
      .max(OAUTH_PROVIDERS.length)
      .default([])
      .describe('The OAuth providers to configure or change, each once.'),
  })
  .refine(({ settings, providers }) => settings.length + providers.length > 0, {
    message: 'name at least one setting or one provider',
  })
  .refine(
    ({ settings }) => new Set(settings.map((change) => change.path)).size === settings.length,
    {
      message: 'a setting is named once',
      path: ['settings'],
    }
  )
  .refine(
    ({ providers }) =>
      new Set(providers.map((change) => change.provider)).size === providers.length,
    { message: 'a provider is named once', path: ['providers'] }
  )

/**
 * What `draft_settings_change` is asked for, once its schema accepted it.
 *
 * @example
 * ```ts
 * const wanted: DraftSettingsChangeInput = { settings: [{ path: 'mfa.policy', value: 'required' }], providers: [] }
 * ```
 */
export type DraftSettingsChangeInput = z.infer<typeof draftSettingsChangeInput>

/**
 * What the reader does next, in the tool's own fixed words. No value is ever written into
 * it: the edits are fields of their own.
 */
const NEXT_STEP =
  'Nothing has been changed, on the server or on disk: this tool wrote no file and called ' +
  'no route that writes. The result is an edit to the environment’s entry in the config ' +
  'file (tula.config.ts). A person reviews the edited file, runs `tula diff` to see what ' +
  'it would do and `tula apply` to do it, with their own secret key. This server cannot ' +
  'apply it.'

/** How the edits are read, in fixed words. */
const NOTES: readonly string[] = [
  'Each entry of `settings` is one key of the `settings` object of this environment’s entry in the config file: `path` is where, `to` is the value to write, `from` is what the server has now.',
  "Each entry of `providers` is the provider’s whole entry under `providers` of the same environment. Its secret is written `env('NAME')`, with `env` imported from @tula/config and NAME the `$env` given here: the variable’s name, never its value.",
  'Read every `$env` name before applying: `tula apply` sends the value of the variable an entry names to the server as that provider’s secret. This tool refuses the names of Tula’s own credentials and cannot know what any other variable holds.',
  'The config file is the whole truth for settings: a setting it leaves out goes back to its default when it is applied. Edit the file that manages this environment; where `managedBy` is null no file is on record, and a file holding only these edits would reset every other setting.',
  '`weakened` lists what the change weakens, by the names `tula diff` prints. `tula apply --yes` refuses such a plan without --allow-weaker, and a person at a terminal is asked about it by name.',
]

/**
 * Said beside a draft that switches off a provider the server has on (ADR 0059). Whether
 * that weakens depends on a count only the server has, which this tool never reads (no
 * operation of `READ_OPERATIONS` answers it, on purpose): without the note, `weakens:
 * false` would read as "nobody is locked out". A constant: no provider's name, no number.
 */
const DEPENDENTS_NOT_JUDGED =
  'Whether accounts can sign in only with a provider this draft switches off is not judged here: this tool does not read that count, so `weakened` and `weakens` say nothing about it. `tula diff` counts them for the person who applies the draft, and `tula apply --yes` refuses a plan that locks accounts out without --allow-weaker.'

/**
 * One reason a draft was refused: where, and a closed word for why. Never a value, and never
 * a validator's own sentence.
 */
interface Problem {
  path: string
  code: string
}

const PROBLEM_SHAPE = S.object({ path: S.string(MAX_PATH_CHARS), code: S.string(40) })

const SECRET_REFERENCE_SHAPE = S.object({ $env: S.string(MAX_VARIABLE_NAME_CHARS) })

/**
 * A provider's entry in a config file, as a tool returns it. The two secret fields hold a
 * reference and can hold nothing else: the shape has no place for a string there.
 */
const PROVIDER_ENTRY_SHAPE = S.object({
  clientId: S.string(MAX_STRING_CHARS),
  teamId: S.string(64),
  keyId: S.string(64),
  tenant: S.string(64),
  additionalClientIds: S.array(S.string(128), 8),
  enabled: S.boolean,
  clientSecret: SECRET_REFERENCE_SHAPE,
  privateKey: SECRET_REFERENCE_SHAPE,
})

/** The fields of a provider that are not its secret, in the order an entry is written. */
const PUBLIC_FIELDS = [
  'clientId',
  'teamId',
  'keyId',
  'tenant',
  'additionalClientIds',
  'enabled',
] as const

/** Give `target` its own property `key`: never an assignment, which `__proto__` would bend. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function valueAt(document: unknown, segments: readonly string[]): unknown {
  let at: unknown = document
  for (const segment of segments) {
    if (!isRecord(at) || !Object.hasOwn(at, segment)) {
      return undefined
    }
    at = at[segment]
  }
  return at
}

function setAt(document: Record<string, unknown>, segments: readonly string[], value: unknown) {
  let at = document
  for (const segment of segments.slice(0, -1)) {
    let next: unknown = Object.hasOwn(at, segment) ? at[segment] : undefined
    if (!isRecord(next)) {
      // A named entry that is not there yet (a new session profile): the contract's schema
      // says what else it needs.
      next = {}
      setOwn(at, segment, next)
    }
    at = next as Record<string, unknown>
  }
  setOwn(at, segments[segments.length - 1] as string, Array.isArray(value) ? [...value] : value)
}

/** What the contract's schema of a settings document refuses in `document`. */
function settingsProblems(document: unknown): Problem[] {
  const result = EnvironmentSettingsInputSchema.safeParse(document)
  if (result.success) {
    return []
  }
  return result.error.issues.flatMap((issue): Problem[] => {
    const path = issue.path.map(String)
    return issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ path: [...path, key].join('.'), code: issue.code }))
      : [{ path: path.join('.'), code: String(issue.code) }]
  })
}

function key(problem: Problem): string {
  return `${problem.code} ${problem.path}`
}

/** The answer of a draft that cannot be made: an error and where each problem is. */
function refused(problems: readonly Problem[]): Record<string, unknown> {
  const seen = new Set<string>()
  const listed: unknown[] = []
  for (const problem of problems) {
    if (seen.has(key(problem))) {
      continue
    }
    seen.add(key(problem))
    if (listed.length < MAX_PROBLEMS) {
      listed.push(project(problem, PROBLEM_SHAPE))
    }
  }
  const answer: Record<string, unknown> = {
    error: {
      code: 'change.invalid',
      message:
        'The change is not one a config file could hold; nothing was drafted. `problems` says where: a path and a closed word for why.',
    },
    problems: listed,
    changed: false,
  }
  const omitted = seen.size - listed.length
  if (omitted > 0) {
    // A cut list is never presented as whole: the mark a cut list has everywhere in this
    // package, and how many distinct problems are not listed.
    answer.truncated = project(true, S.boolean)
    answer.problemsOmitted = project(omitted, S.number)
  }
  return answer
}

interface DraftedSettings {
  edits: Record<string, unknown>[]
  weakened: string[]
  problems: Problem[]
}

/** The settings' half: each wanted value against the document the server has. */
function draftSettings(
  stored: unknown,
  wanted: DraftSettingsChangeInput['settings']
): DraftedSettings {
  if (wanted.length === 0) {
    return { edits: [], weakened: [], problems: [] }
  }
  let before: ReturnType<typeof parseStoredEnvironmentSettings>
  try {
    before = parseStoredEnvironmentSettings(stored)
  } catch {
    // A document this version cannot read as settings: there is nothing to judge a change
    // against, and a draft made on a guess could hide a weakening.
    throw new ToolError(
      'settings.unreadable',
      'This version of the server cannot read the environment’s settings document, so it drafted nothing. Use a `tula` of the API’s own version.'
    )
  }
  const after = structuredClone(before) as unknown as Record<string, unknown>
  const problems: Problem[] = []
  const edits: Record<string, unknown>[] = []
  for (const change of wanted) {
    const shape = settingShape(change.path)
    if (!shape) {
      // The schema refused such a path already; a caller that skipped it gets the same.
      problems.push({ path: change.path, code: 'unknown_setting' })
      continue
    }
    const segments = change.path.split('.')
    const from = valueAt(before, segments)
    const to = project(change.value, shape)
    if (!same(to, change.value)) {
      // The value would not come back as it was given (cut, cleaned, of another type, or
      // read as a secret): what is returned would not be what was asked for.
      problems.push({ path: change.path, code: 'not_returnable' })
      continue
    }
    setAt(after, segments, change.value)
    const edit: Record<string, unknown> = {}
    setOwn(edit, 'path', project(change.path, S.string(MAX_PATH_CHARS)))
    const shown = from === undefined ? undefined : project(from, shape)
    if (shown !== undefined) {
      setOwn(edit, 'from', shown)
    }
    setOwn(edit, 'to', to)
    setOwn(edit, 'changes', !same(from, change.value))
    edits.push(edit)
  }
  // What the document already had against it is not this change's doing.
  const already = new Set(settingsProblems(before).map(key))
  problems.push(...settingsProblems(after).filter((problem) => !already.has(key(problem))))
  if (problems.length > 0) {
    return { edits: [], weakened: [], problems }
  }
  let weakened: string[]
  try {
    weakened = settingsWeakenings(before, parseStoredEnvironmentSettings(after))
  } catch {
    return { edits: [], weakened: [], problems: [{ path: 'settings', code: 'invalid' }] }
  }
  return { edits, weakened, problems }
}

interface DraftedProviders {
  entries: Record<string, unknown>[]
  weakened: string[]
  problems: Problem[]
  /** Whether an entry switches off a provider the server has on. */
  switchesOff: boolean
}

/** The client ids a server lists beside a provider's own: none where it lists none. */
function clientIdsOf(current: Record<string, unknown> | undefined): string[] {
  const listed = current?.additionalClientIds
  return Array.isArray(listed)
    ? listed.filter((id): id is string => typeof id === 'string').sort()
    : []
}

/** One provider's entry: what the server has, what was asked for over it, and the reference. */
function draftProvider(
  current: Record<string, unknown> | undefined,
  wanted: DraftSettingsChangeInput['providers'][number]
): {
  entry?: Record<string, unknown>
  weakened: string[]
  problems: Problem[]
  switchesOff?: boolean
} {
  const provider: OAuthProvider = wanted.provider
  const at = `providers.${provider}`
  const configured = current?.configured === true
  const written: Record<string, unknown> = {}
  for (const field of PUBLIC_FIELDS) {
    const asked = wanted[field]
    const held = configured && Object.hasOwn(current, field) ? current[field] : undefined
    if (asked !== undefined) {
      written[field] = asked
    } else if (held !== undefined && held !== null && !(Array.isArray(held) && held.length === 0)) {
      written[field] = held
    }
  }
  // The secret is a reference made by `env()` from a name, and there is no other way in:
  // nothing of the server's answer and no other input is ever put in its place.
  written[provider === 'apple' ? 'privateKey' : 'clientSecret'] = env(wanted.secretEnv)
  let parsed: Record<string, unknown>
  try {
    const config = parseConfig({ environments: { draft: { providers: { [provider]: written } } } })
    const providers = config.environments.draft?.providers ?? {}
    if (providerSecret(providers, provider)?.$env !== wanted.secretEnv) {
      return { weakened: [], problems: [{ path: at, code: 'invalid' }] }
    }
    parsed = providers[provider] as unknown as Record<string, unknown>
  } catch (error) {
    if (!isConfigError(error)) {
      throw error
    }
    // The config's own judgement, by path. Its sentences are not passed on.
    const prefix = 'environments.draft.'
    return {
      weakened: [],
      problems: error.issues.map((issue) => ({
        path: issue.path.startsWith(prefix) ? issue.path.slice(prefix.length) : at,
        code: 'invalid',
      })),
    }
  }
  const projected = project(parsed, PROVIDER_ENTRY_SHAPE) as Record<string, unknown>
  const problems: Problem[] = Object.keys(parsed)
    .filter((field) => !Object.hasOwn(projected, field) || !same(projected[field], parsed[field]))
    .map((field) => ({ path: `${at}.${field}`, code: 'not_returnable' }))
  if (problems.length > 0) {
    return { weakened: [], problems }
  }
  const changed = PUBLIC_FIELDS.filter((field) => {
    const after = field === 'additionalClientIds' ? clientIdsOf(parsed) : parsed[field]
    const before = field === 'additionalClientIds' ? clientIdsOf(current) : current?.[field]
    if (configured) {
      return !same(before ?? null, after ?? null)
    }
    // A provider that is new: every field its entry has is a change, and an empty list of
    // client ids is no field.
    return Array.isArray(after) ? after.length > 0 : after !== undefined
  })
  const entry: Record<string, unknown> = {}
  setOwn(entry, 'provider', provider)
  setOwn(entry, 'configured', configured)
  setOwn(entry, 'entry', projected)
  setOwn(entry, 'changed', [...changed])
  const weakened = oauthProviderWeakenings(
    configured ? { additionalClientIds: clientIdsOf(current) } : null,
    { additionalClientIds: clientIdsOf(parsed) }
  ).map((field) => `${at}.${field}`)
  // On to off is the one change whose weakening rests on the dependents' count. The tool
  // cannot draft a removal, so there is no second case.
  const switchesOff = configured && current.enabled === true && parsed.enabled === false
  return { entry, weakened, problems, switchesOff }
}

/**
 * Draft a change to an environment's settings and OAuth providers as an edit to its entry
 * in the config file (ADR 0056). It reads what the server has, through the read-only
 * facade, and answers the edit; it writes no file, calls no route that writes, and is given
 * nothing that could.
 *
 * - A setting is named by its path and judged three times: the path by the allow-list
 *   `get_settings` projects through ({@link settingShape}), the value by the contract's
 *   `EnvironmentSettingsInputSchema` on the whole document it would make, and by the
 *   projection again: a value that would not be returned exactly as given is refused, so
 *   what a reader copies is what was asked for.
 * - A provider's entry is validated by `@tula/config`'s own `parseConfig`, and its secret
 *   is `env()` of a variable's name: the only form the function can write.
 * - `weakened` is the contract's `settingsWeakenings` and `oauthProviderWeakenings`, under
 *   the names `tula diff` prints.
 *
 * @param reads - The read-only admin API.
 * @param input - What should change, as the tool's schema accepted it.
 * @returns The edits with `changed: false`, or `{ error, problems }` for a change no config
 *   file could hold.
 * @throws ToolError `settings.unreadable` when this version cannot read the settings
 *   document, `response.invalid` when the answer is not the API's.
 * @throws TulaAdminError as the admin client does.
 *
 * @example
 * ```ts
 * const draft = await draftSettingsChange(reads, {
 *   settings: [{ path: 'password.minLength', value: 14 }],
 *   providers: [{ provider: 'github', clientId: 'Iv1.abc', secretEnv: 'GITHUB_CLIENT_SECRET' }],
 * })
 * // draft.changed === false; draft.providers[0].entry.clientSecret is { $env: 'GITHUB_CLIENT_SECRET' }
 * ```
 */
export async function draftSettingsChange(
  reads: ReadOnlyAdmin,
  input: DraftSettingsChangeInput
): Promise<Record<string, unknown>> {
  const answer: unknown = await reads.read('getEnvironmentSettings')
  if (!isRecord(answer) || !isRecord(answer.settings)) {
    throw new ToolError('response.invalid', 'The answer was not the Tula API’s.')
  }
  const settings = draftSettings(answer.settings, input.settings)
  const providers: DraftedProviders = {
    entries: [],
    weakened: [],
    problems: [],
    switchesOff: false,
  }
  if (input.providers.length > 0) {
    const listed: unknown = await reads.read('listOAuthProviders')
    if (!isRecord(listed) || !Array.isArray(listed.data)) {
      throw new ToolError('response.invalid', 'The answer was not the Tula API’s.')
    }
    for (const wanted of input.providers) {
      const current = listed.data.find(
        (entry): entry is Record<string, unknown> =>
          isRecord(entry) && entry.provider === wanted.provider
      )
      const drafted = draftProvider(current, wanted)
      if (drafted.entry) {
        providers.entries.push(drafted.entry)
      }
      providers.weakened.push(...drafted.weakened)
      providers.problems.push(...drafted.problems)
      providers.switchesOff ||= drafted.switchesOff === true
    }
  }
  const problems = [...settings.problems, ...providers.problems]
  if (problems.length > 0) {
    return refused(problems)
  }
  const weakened = project([...settings.weakened, ...providers.weakened], S.array(S.string(200)))
  return {
    changed: false,
    nextStep: NEXT_STEP,
    notes: [...NOTES, ...(providers.switchesOff ? [DEPENDENTS_NOT_JUDGED] : [])],
    revision: project(answer.revision, S.number),
    managedBy: project(answer.managedBy, MANAGED_BY_SHAPE),
    settings: settings.edits,
    providers: providers.entries,
    weakened,
    weakens: (weakened as unknown[]).length > 0,
  }
}
