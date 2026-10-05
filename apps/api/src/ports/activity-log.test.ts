import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { MemoryActivityLog } from '~/adapters/memory/activity-log'
import { MemoryUserRepository } from '~/adapters/memory/users'
import type { Deps } from '~/dependencies'
import * as Audit from '~/modules/audit/service'
import { type Activity, activityOf, type Recorded, recordedOf } from '~/ports/activity-log'
import type { ApiKeyRepository, NewApiKey } from '~/ports/api-key-repository'
import type { EnvironmentSettingsStore } from '~/ports/environment-settings-store'
import type { FactorStore } from '~/ports/factor-store'
import type { OAuthProviderRecord, OAuthProviderStore } from '~/ports/oauth-provider-store'
import type { PasskeyRecord, PasskeyStore } from '~/ports/passkey-store'
import type { NewRefreshToken, NewSession, SessionStore } from '~/ports/session-store'
import type { RotationPlan, SigningKeyStore } from '~/ports/signing-key-store'
import type { NewIdentity, NewUser, UserRepository } from '~/ports/user-repository'
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
}

function _reasons(): Recorded[] {
  return [
    Audit.none('fixture'),
    // @ts-expect-error the reasons are a closed list (ADR 0012), not free text
    Audit.none('nobody will notice'),
    // @ts-expect-error only `Audit.none` and `Audit.entry` build what a store takes
    {},
  ]
}

describe('what a store is told about the audit entry of a write', () => {
  test('the type-level assertions above are compiled, not run', () => {
    for (const unused of [
      _users,
      _sessions,
      _passkeys,
      _factors,
      _keysAndSettings,
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
    })
    const none = Audit.none('fixture')
    expect(none).toEqual({ unrecorded: 'fixture' })
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
    const allowedIn = (file: string) =>
      /\.(test|suite|integration)\.ts$/.test(file) ||
      file === 'testing.ts' ||
      file.startsWith('testing/') ||
      // Where it is defined and documented.
      file === 'modules/audit/service.ts' ||
      file === 'ports/activity-log.ts'
    const offenders: string[] = []
    let scanned = 0
    for await (const file of new Glob('**/*.ts').scan(`${import.meta.dir}/..`)) {
      scanned++
      if (allowedIn(file)) {
        continue
      }
      const source = await Bun.file(`${import.meta.dir}/../${file}`).text()
      if (/\bAudit\s*\.\s*none\b|\bunrecorded\s*:/.test(source)) {
        offenders.push(file)
      }
    }
    expect(scanned).toBeGreaterThan(200)
    expect(offenders).toEqual([])
  })
})
