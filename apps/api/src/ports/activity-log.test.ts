import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryUserRepository } from '~/adapters/memory/users'
import type { Deps } from '~/dependencies'
import * as Audit from '~/modules/audit/service'
import {
  type Activity,
  activityOf,
  isUnrecorded,
  type Recorded,
  recordedOf,
} from '~/ports/activity-log'
import type { ApiKeyRepository, NewApiKey } from '~/ports/api-key-repository'
import type { EnvironmentSettingsStore } from '~/ports/environment-settings-store'
import type { FactorStore } from '~/ports/factor-store'
import type { HookRecord, HookStore } from '~/ports/hook-store'
import type { OAuthProviderRecord, OAuthProviderStore } from '~/ports/oauth-provider-store'
import type { PasskeyRecord, PasskeyStore } from '~/ports/passkey-store'
import type { NewRefreshToken, NewSession, SessionStore } from '~/ports/session-store'
import type { RotationPlan, SigningKeyStore } from '~/ports/signing-key-store'
import type { NewIdentity, NewUser, UserRepository } from '~/ports/user-repository'
import type {
  WebhookEndpointRecord,
  WebhookEndpointStore,
  WebhookSecretRotation,
} from '~/ports/webhook-endpoint-store'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

// AGENTS.md: "every change to who can do what is recorded, in the same transaction". The
// audit entry used to be an optional parameter, so the rule was held by tests and review.
// It is now required: the functions below are never called. Their assertions are the
// `@ts-expect-error` lines, which `bun run typecheck` checks: a line that compiles after all
// fails the build ("unused '@ts-expect-error' directive").

const ENV = TEST_TENANT.environmentId
const AT = new Date('2026-01-01T00:00:00.000Z')
const allowed = () => true
declare const activity: Activity
declare const user: NewUser
declare const identity: NewIdentity
declare const session: NewSession
declare const token: NewRefreshToken
declare const passkey: PasskeyRecord
declare const apiKey: NewApiKey
declare const provider: OAuthProviderRecord
declare const plan: RotationPlan
declare const endpoint: WebhookEndpointRecord
declare const rotation: WebhookSecretRotation
declare const hook: HookRecord
declare const settings: Parameters<EnvironmentSettingsStore['replace']>[2]

async function _users(users: UserRepository): Promise<void> {
  // @ts-expect-error a user cannot be created without saying what is recorded
  await users.create(user)
  // @ts-expect-error `undefined` is not a way to say "not recorded"
  await users.create(user, undefined)
  // @ts-expect-error
  await users.linkIdentity(identity)
  // @ts-expect-error
  await users.unlinkIdentity(ENV, 'user', 'identity', allowed)
  // @ts-expect-error
  await users.setPasswordHash(ENV, 'user', 'hash', AT)
  // @ts-expect-error
  await users.markEmailVerified(ENV, 'user', AT)
  // @ts-expect-error removing the password is a change of its own, with its own entry
  await users.markEmailVerified(ENV, 'user', AT, activity, {})
  // @ts-expect-error
  await users.setBanned(ENV, 'user', AT, AT)
  // @ts-expect-error
  await users.setPhoneNumber(ENV, 'user', '+14155550100', AT)
  // @ts-expect-error
  await users.removePhoneNumber(ENV, 'user', AT)
  // @ts-expect-error
  await users.delete(ENV, 'user')
  // The two that are never recorded (ADR 0012) are methods of their own and take none.
  await users.upgradePasswordHash(ENV, 'user', 'old', 'new', AT)
}

async function _sessions(sessions: SessionStore): Promise<void> {
  // @ts-expect-error
  await sessions.create(session, token)
  // @ts-expect-error the sessions ended to make room are recorded too
  await sessions.create(session, token, activity, { max: 1, end: [], at: AT })
  // @ts-expect-error
  await sessions.revoke(ENV, 'session', 'sign_out', AT)
  // @ts-expect-error
  await sessions.recordAuthentication(ENV, 'session', { at: AT, methods: ['pwd'] })
  // @ts-expect-error
  await sessions.revokeByUser(ENV, 'user', 'sign_out', AT)
  // @ts-expect-error
  await sessions.revokeByUser(ENV, 'user', 'sign_out', AT, { exceptSessionId: 'session' })
}

async function _passkeys(passkeys: PasskeyStore): Promise<void> {
  // @ts-expect-error
  await passkeys.create(passkey, 10)
  // @ts-expect-error
  await passkeys.rename(ENV, 'user', 'passkey', 'Laptop', AT)
  // @ts-expect-error
  await passkeys.remove(ENV, 'user', 'passkey', allowed)
  // @ts-expect-error
  await passkeys.removeForUser(ENV, 'user')
  // @ts-expect-error an entry with no write beside it: there is nothing to leave unrecorded
  await passkeys.reportRegression(ENV, 'passkey', Audit.none('fixture'))
}

async function _factors(factors: FactorStore): Promise<void> {
  // @ts-expect-error
  await factors.confirmTotp(ENV, 'factor', { step: 1, at: AT, backupCodes: [] })
  // @ts-expect-error
  await factors.removeForUser(ENV, 'user')
  // @ts-expect-error
  await factors.replaceBackupCodes(ENV, 'user', { projectId: 'project' }, [], AT)
  // @ts-expect-error
  await factors.consumeBackupCode(ENV, 'user', 'hash', AT)
}

async function _keysAndSettings(
  deps: Pick<Deps, 'apiKeys' | 'signingKeys' | 'oauthProviders' | 'environmentSettings'>
): Promise<void> {
  const apiKeys: ApiKeyRepository = deps.apiKeys
  const signingKeys: SigningKeyStore = deps.signingKeys
  const oauthProviders: OAuthProviderStore = deps.oauthProviders
  // @ts-expect-error
  await apiKeys.insert(apiKey)
  // @ts-expect-error
  await apiKeys.revoke(ENV, 'key', AT)
  // @ts-expect-error
  await signingKeys.rotate(ENV, plan, AT)
  // @ts-expect-error
  await oauthProviders.upsert(provider)
  // @ts-expect-error
  await oauthProviders.delete(ENV, 'google')
  // @ts-expect-error
  await deps.environmentSettings.replace(ENV, 0, settings, AT)
  // @ts-expect-error the settings have no unrecorded write at all
  await deps.environmentSettings.replace(ENV, 0, settings, AT, Audit.none('fixture'))
  // An environment's first signing keys are a method of their own and take none.
  await signingKeys.insert(ENV, [])
}

async function _webhookEndpoints(endpoints: WebhookEndpointStore): Promise<void> {
  // @ts-expect-error an endpoint decides where an environment's events are sent
  await endpoints.insert(endpoint)
  // @ts-expect-error
  await endpoints.insert(endpoint, undefined)
  // @ts-expect-error
  await endpoints.update(ENV, 'endpoint', { enabled: false }, AT)
  // @ts-expect-error
  await endpoints.delete(ENV, 'endpoint')
  // @ts-expect-error the server switching an endpoint off changes where events are sent
  await endpoints.disable(ENV, 'endpoint', 'failing', AT)
  // @ts-expect-error
  await endpoints.disable(ENV, 'endpoint', 'gone', AT, undefined)
  // @ts-expect-error a new signing secret changes who can sign an environment's events
  await endpoints.rotateSecret(ENV, 'endpoint', rotation, AT)
  // @ts-expect-error
  await endpoints.rotateSecret(ENV, 'endpoint', rotation, AT, undefined)
  // @ts-expect-error ending an overlap early takes a secret away before its time
  await endpoints.revokePreviousSecret(ENV, 'endpoint', AT)
  // @ts-expect-error
  await endpoints.revokePreviousSecret(ENV, 'endpoint', AT, undefined)
  // Since when an endpoint has been failing is the worker's bookkeeping: a method of its own
  // that takes none (ADR 0012).
  await endpoints.setHealth(ENV, 'endpoint', null, { failingSince: AT, lastFailedAt: AT })
  // So is deleting a previous secret whose overlap has ended: it stopped signing at that end,
  // by the clock, and the rotation that set the end is what was recorded (ADR 0012).
  await endpoints.clearExpiredPreviousSecrets(ENV, AT, 10)
}

/** The memory adapters are what tests hold (`TestDeps`): they are as strict as the ports. */
async function _memoryAdapters(deps: TestDeps): Promise<void> {
  // @ts-expect-error
  await deps.users.create(user)
  // @ts-expect-error
  await deps.users.delete(ENV, 'user')
  // @ts-expect-error
  await deps.sessions.create(session, token)
  // @ts-expect-error
  await deps.sessions.revokeByUser(ENV, 'user', 'sign_out', AT)
  // @ts-expect-error
  await deps.passkeys.removeForUser(ENV, 'user')
  // @ts-expect-error
  await deps.factors.removeForUser(ENV, 'user')
  // @ts-expect-error
  await deps.apiKeys.insert(apiKey)
  // @ts-expect-error
  await deps.signingKeys.rotate(ENV, plan, AT)
  // @ts-expect-error
  await deps.oauthProviders.upsert(provider)
  // @ts-expect-error
  await deps.webhookEndpoints.insert(endpoint)
  // @ts-expect-error
  await deps.webhookEndpoints.delete(ENV, 'endpoint')
  // @ts-expect-error
  await deps.webhookEndpoints.disable(ENV, 'endpoint', 'failing', AT)
  // @ts-expect-error
  await deps.webhookEndpoints.rotateSecret(ENV, 'endpoint', rotation, AT)
  // @ts-expect-error
  await deps.webhookEndpoints.revokePreviousSecret(ENV, 'endpoint', AT)
}

function _reasons(): Recorded[] {
  return [
    Audit.none('fixture'),
    // @ts-expect-error the reasons are a closed list (ADR 0012), not free text
    Audit.none('nobody will notice'),
    // @ts-expect-error only `Audit.none` and `Audit.entry` build what a store takes
    {},
    // @ts-expect-error a literal is not an `Unrecorded`: its key is a symbol nobody can name
    { unrecorded: 'fixture' },
    // @ts-expect-error nor is one keyed by a symbol anyone can reach
    { [Symbol.for('unrecorded')]: 'fixture' },
    // @ts-expect-error
    { [Symbol.iterator]: 'fixture', unrecorded: 'fixture' },
  ]
}

/** The files that may build an `Unrecorded`: where it is defined, and tests and their support. */
function mayLeaveUnrecorded(file: string): boolean {
  return (
    /\.(test|suite|integration)\.ts$/.test(file) ||
    file === 'testing.ts' ||
    file.startsWith('testing/') ||
    file === 'modules/audit/service.ts' ||
    file === 'ports/activity-log.ts'
  )
}

/**
 * Every way a source file reaches for "not recorded", as text. The type is the first guard
 * (an `Unrecorded` cannot be written as a literal); this is the second, for the two functions
 * that can build one.
 */
function waysToLeaveUnrecorded(source: string, file = 'modules/example/service.ts'): string[] {
  const { code, bare } = withoutComments(source)
  const found: string[] = []
  // A literal shaped like the value before it was branded. It no longer compiles as one; a
  // file that writes it anyway is trying to.
  if (/(['"`]?)\bunrecorded\1\s*:/.test(code)) {
    found.push('a literal keyed `unrecorded`')
  }
  for (const [module, builder] of BUILDERS) {
    const names = (specifier: string) => moduleOf(specifier, file) === module
    for (const [, type, clause, specifier] of code.matchAll(IMPORT)) {
      if (type || !names(specifier as string)) {
        continue
      }
      if (namedBindings(clause as string).includes(builder)) {
        found.push(`imports \`${builder}\` from ${module}`)
      }
      const namespace = (clause as string).match(/\*\s*as\s+([\w$]+)/)?.[1]
      // A namespace is fine while every use of it is `Namespace.someOtherName`. Anything else
      // (the builder, a computed member, the namespace handed on or taken apart) is refused,
      // because from there the builder cannot be followed by reading.
      for (const use of namespace ? bare.matchAll(usesOf(namespace)) : []) {
        const member = use[1]
        if (member === undefined || member === builder) {
          found.push(`reaches \`${builder}\` through \`${namespace}\``)
          break
        }
      }
    }
    for (const [, clause, specifier] of code.matchAll(EXPORT_FROM)) {
      const all = (clause as string).startsWith('*')
      if (
        names(specifier as string) &&
        (all || namedBindings(clause as string).includes(builder))
      ) {
        found.push(`re-exports \`${builder}\` from ${module}`)
      }
    }
    // Only the audit service is ever loaded lazily for its builder; the port has no reason
    // to be, and nothing in the server loads either this way.
    for (const [, specifier] of code.matchAll(DYNAMIC_IMPORT)) {
      if (names(specifier as string)) {
        found.push(`loads ${module} with import()`)
      }
    }
  }
  return found
}

/** The two functions that build an `Unrecorded`, by the module that exports each. */
const BUILDERS = [
  ['modules/audit/service', 'none'],
  ['ports/activity-log', 'unrecordedFor'],
] as const
const IMPORT = /\bimport\s+(type\s+)?([\w$*{},\s]+?)\s+from\s*['"]([^'"]+)['"]/g
const EXPORT_FROM = /\bexport\s+(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

/** Every use of a namespace binding, with the member it reads when it is a plain `.name`. */
function usesOf(namespace: string): RegExp {
  return new RegExp(
    `(?<![\\w$.])${namespace.replace(/\$/g, '\\$')}\\b(?:\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`,
    'g'
  )
}

/** The exported names a `{ a, b as c, type d }` clause binds as values. */
function namedBindings(clause: string): string[] {
  const braces = clause.match(/\{([^}]*)\}/)?.[1] ?? ''
  return braces
    .split(',')
    .map((binding) => binding.trim())
    .filter((binding) => binding !== '' && !binding.startsWith('type '))
    .map((binding) => binding.split(/\s+as\s+/)[0] as string)
}

/** The module a specifier names, as a path under `apps/api/src` without its extension. */
function moduleOf(specifier: string, file: string): string {
  const from = specifier.startsWith('~/')
    ? specifier.slice(2).split('/')
    : specifier.startsWith('.')
      ? [...file.split('/').slice(0, -1), ...specifier.split('/')]
      : [specifier]
  const parts: string[] = []
  for (const part of from) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '.' && part !== '') {
      parts.push(part)
    }
  }
  return parts.join('/').replace(/\.ts$/, '')
}

/**
 * A source file without its comments (`code`), and also without the contents of its string
 * and template literals and without its import and export lines (`bare`): what is left of
 * `bare` is where a binding is used.
 */
function withoutComments(source: string): { code: string; bare: string } {
  let code = ''
  let bare = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string
    if (c === '/' && source[i + 1] === '/') {
      i = (source.indexOf('\n', i) + source.length + 1) % (source.length + 1)
      i--
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
    } else if (c === "'" || c === '"' || c === '`') {
      let end = i + 1
      while (end < source.length && source[end] !== c) {
        end += source[end] === '\\' ? 2 : 1
      }
      code += source.slice(i, end + 1)
      bare += `${c}${c}`
      i = end
    } else {
      code += c
      bare += c
    }
  }
  return { code, bare: bare.replace(/\b(?:import|export)\b[^;\n]*?\bfrom\s*['"]{2}/gs, '') }
}

async function _hooks(hooks: HookStore): Promise<void> {
  const strict = { enabled: true, failureMode: 'deny' } as const
  // @ts-expect-error a hook decides who may sign up
  await hooks.insert(hook)
  // @ts-expect-error
  await hooks.insert(hook, undefined)
  // @ts-expect-error switching a hook off, or letting it allow on failure, removes a check
  await hooks.update(ENV, 'hook', strict, { enabled: false }, AT)
  // @ts-expect-error
  await hooks.update(ENV, 'hook', strict, { failureMode: 'allow' }, AT, undefined)
  // @ts-expect-error
  await hooks.delete(ENV, 'hook', strict)
  // @ts-expect-error
  await hooks.delete(ENV, 'hook', strict, undefined)
  // When a call last failed is the server's own bookkeeping: a method of its own, taking none.
  await hooks.noteFailure(ENV, 'hook', AT, 'timeout')
}

describe('what a store is told about the audit entry of a write', () => {
  test('the type-level assertions above are compiled, not run', () => {
    for (const unused of [
      _users,
      _sessions,
      _passkeys,
      _factors,
      _keysAndSettings,
      _webhookEndpoints,
      _hooks,
      _memoryAdapters,
      _reasons,
    ]) {
      expect(typeof unused).toBe('function')
    }
  })

  test('an activity is written, an explicit `Audit.none` is not', async () => {
    const deps = createTestDeps()
    const entry = Audit.entry(deps, TEST_TENANT, {
      type: 'user.created',
      actor: { type: 'system', id: null, ipAddress: null, userAgent: null },
      target: { type: 'user', id: 'user' },
      data: { method: 'admin', emailVerified: false },
    })
    const none = Audit.none('fixture')
    expect(isUnrecorded(none)).toBe(true)
    expect(isUnrecorded(entry)).toBe(false)
    // Nothing to read, copy or serialise: no string key, and frozen.
    expect(Object.keys(none)).toEqual([])
    expect(JSON.stringify(none)).toBe('{}')
    expect(Object.isFrozen(none)).toBe(true)
    // A look-alike forced past the compiler is not one at run time either: a store takes it
    // for the activity it claims to be, so nothing is skipped silently.
    const forgeries: object[] = [
      { unrecorded: 'fixture' },
      { [Symbol('unrecorded')]: 'fixture' },
      { [Symbol.for('unrecorded')]: 'fixture' },
      Object.create(none),
    ]
    for (const forged of forgeries) {
      expect(isUnrecorded(forged as Recorded)).toBe(false)
      expect(activityOf(forged as Recorded)).toBe(forged as Activity)
    }
    expect(activityOf(entry)).toBe(entry)
    expect(activityOf(none)).toBeUndefined()
    expect(recordedOf([none, entry, none])).toEqual([entry])

    const log = new MemoryActivityLog()
    const users = new MemoryUserRepository(log)
    const person = (id: string): NewUser => ({
      id,
      projectId: TEST_TENANT.projectId,
      environmentId: ENV,
      credentialId: `${id}-credential`,
      passwordHash: null,
      email: `${id}@northline.app`,
      emailNormalized: `${id}@northline.app`,
      emailVerifiedAt: null,
      firstName: null,
      lastName: null,
      createdAt: AT,
      identityId: `${id}-identity`,
    })
    expect(await users.create(person('seeded'), none)).toBe(true)
    expect(log.entries).toHaveLength(0)
    expect(await users.create(person('signed-up'), entry)).toBe(true)
    expect(log.entries.map((recorded) => recorded.id)).toEqual([entry.id])
  })

  // `Audit.none` exists for rows that stand for something that happened elsewhere. The
  // server itself has no such write: every one of its store calls records.
  test('the server’s own code never passes `Audit.none`', async () => {
    const offenders: string[] = []
    let scanned = 0
    for await (const file of new Glob('**/*.ts').scan(`${import.meta.dir}/..`)) {
      scanned++
      if (mayLeaveUnrecorded(file)) {
        continue
      }
      const source = await Bun.file(`${import.meta.dir}/../${file}`).text()
      offenders.push(...waysToLeaveUnrecorded(source).map((way) => `${file}: ${way}`))
    }
    expect(scanned).toBeGreaterThan(200)
    expect(offenders).toEqual([])
  })

  // Review finding F1: the guard matched the text `Audit.none`, so any other spelling of the
  // same call walked past it. Each of these is source a server file could have held.
  test.each([
    [
      'a named import',
      "import { none } from '~/modules/audit/service'\nawait deps.users.create(user, none('fixture'))",
    ],
    [
      'a renamed import',
      "import { entry, none as skip } from '~/modules/audit/service'\nskip('fixture')",
    ],
    [
      'a namespace under another name',
      "import * as A from '~/modules/audit/service'\nA.none('fixture')",
    ],
    [
      'a member reached by a string',
      "import * as Audit from '~/modules/audit/service'\nAudit['no' + 'ne']('fixture')",
    ],
    [
      'a member taken apart',
      "import * as Audit from '~/modules/audit/service'\nconst { none: skip } = Audit",
    ],
    ['a relative path', "import { none } from '../audit/service'\nnone('fixture')"],
    [
      'a multi-line import',
      "import {\n  entry,\n  none,\n} from '~/modules/audit/service'\nnone('fixture')",
    ],
    ['a dynamic import', "const { none } = await import('~/modules/audit/service')"],
    ['a re-export', "export { none } from '~/modules/audit/service'"],
    ['a re-export of everything', "export * from '~/modules/audit/service'"],
    ['a literal', "const skipped = { 'unrecorded': 'fixture' }"],
    ['a literal with a bare key', 'const skipped = { unrecorded: reason }'],
    [
      'the port’s own constructor',
      "import { unrecordedFor } from '~/ports/activity-log'\nunrecordedFor('fixture')",
    ],
    [
      'the port’s constructor through a namespace',
      "import * as Log from '~/ports/activity-log'\nLog['unrecorded' + 'For']('fixture')",
    ],
  ])('the guard reports %s', (_name, source) => {
    expect(waysToLeaveUnrecorded(source)).not.toEqual([])
  })

  test.each([
    [
      'recording through the namespace',
      "import * as Audit from '~/modules/audit/service'\nAudit.entry(deps, scope, { type })\nAudit.list(deps, tenant, {})",
    ],
    [
      'the names a store needs',
      "import { type Activity, activityOf, type Recorded, recordedOf } from '~/ports/activity-log'",
    ],
    [
      'the word in another module and in prose',
      "import { none } from '~/lib/option'\n// none of this is unrecorded\nnone()",
    ],
    ['a type-only import', "import type { EntryInput } from '~/modules/audit/service'"],
  ])('the guard leaves %s alone', (_name, source) => {
    expect(waysToLeaveUnrecorded(source)).toEqual([])
  })
})
