import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { durationToMs } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Retention from '~/modules/retention/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const DAY = 86_400_000
const HOUR = 3_600_000
const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
const USER = '00000000-0000-7000-8000-0000000000a1'
let deps: TestDeps
let spies: Mock<(...args: never[]) => unknown>[] = []

beforeEach(() => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
})

afterEach(() => {
  for (const spy of spies) {
    spy.mockRestore()
  }
  spies = []
})

/** Time relative to the test clock's current time. */
const from = (ms: number) => new Date(deps.clock.now().getTime() + ms)

async function flowAttempt(scope: Tenant, expiresAt: Date): Promise<string> {
  const id = deps.ids.next()
  await deps.flowAttempts.create({
    id,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    kind: 'sign_up',
    status: 'needs_email_verification',
    userId: null,
    identifier: 'maya@northline.app',
    state: { client: 'web', passwordHash: '$argon2id$never-used' },
    expiresAt,
    createdAt: deps.clock.now(),
  })
  return id
}

async function verificationToken(scope: Tenant, userId: string, expiresAt: Date): Promise<string> {
  const id = deps.ids.next()
  await deps.verificationTokens.replace(
    {
      id,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId,
      flowAttemptId: null,
      purpose: 'password_reset',
      destination: 'maya@northline.app',
      codeHash: `hash-${id}`,
      linkTokenHash: null,
      maxAttempts: 5,
      expiresAt,
      createdAt: deps.clock.now(),
    },
    deps.clock.now()
  )
  return id
}

const hasToken = async (scope: Tenant, userId: string) =>
  (await deps.verificationTokens.findLatest(scope.environmentId, 'password_reset', { userId })) !==
  null

async function session(
  scope: Tenant,
  overrides: { idleExpiresAt?: Date; absoluteExpiresAt?: Date | null } = {}
) {
  const id = deps.ids.next()
  const tokenId = deps.ids.next()
  await deps.sessions.create(
    {
      id,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: USER,
      profile: 'web',
      client: 'web',
      userAgent: null,
      ipAddress: null,
      lastActiveAt: deps.clock.now(),
      idleExpiresAt: from(7 * DAY),
      absoluteExpiresAt: from(30 * DAY),
      createdAt: deps.clock.now(),
      ...overrides,
    },
    {
      id: tokenId,
      sessionId: id,
      tokenHash: `hash-${tokenId}`,
      parentId: null,
      expiresAt: from(7 * DAY),
      createdAt: deps.clock.now(),
    }
  )
  return { id, tokenId }
}

const hasSession = async (scope: Tenant, id: string) =>
  (await deps.sessions.findById(scope.environmentId, id)) !== null

describe('purge', () => {
  test('removes expired flow attempts in every environment, with their pending password hashes', async () => {
    const abandoned = await flowAttempt(tenant, from(10 * 60_000))
    const other = await flowAttempt(otherTenant, from(10 * 60_000))
    deps.clock.advance('5m')
    const live = await flowAttempt(tenant, from(10 * 60_000))

    expect(await Retention.purge(deps)).toMatchObject({ environments: 2, flowAttempts: 0 })
    deps.clock.advance('5m')
    expect(await Retention.purge(deps)).toEqual({
      environments: 2,
      failed: 0,
      flowAttempts: 2,
      verificationTokens: 0,
      sessions: 0,
    })
    expect(await deps.flowAttempts.findById(tenant.environmentId, abandoned)).toBeNull()
    expect(await deps.flowAttempts.findById(otherTenant.environmentId, other)).toBeNull()
    expect(await deps.flowAttempts.findById(tenant.environmentId, live)).not.toBeNull()
  })

  test('removes verification tokens an hour after they expire, used or not, and none sooner', async () => {
    const used = '00000000-0000-7000-8000-0000000000b1'
    const unused = '00000000-0000-7000-8000-0000000000b2'
    const later = '00000000-0000-7000-8000-0000000000b3'
    const usedId = await verificationToken(tenant, used, from(10 * 60_000))
    await verificationToken(tenant, unused, from(10 * 60_000))
    await verificationToken(otherTenant, later, from(20 * 60_000))
    expect(await deps.verificationTokens.consume(tenant.environmentId, usedId, from(1))).toBe(true)

    // Expired, but inside the hour of grace: a request in flight still finds its token.
    deps.clock.advance(10 * 60_000 + HOUR - 1)
    expect((await Retention.purge(deps)).verificationTokens).toBe(0)
    expect(await hasToken(tenant, used)).toBe(true)

    deps.clock.advance(1)
    expect((await Retention.purge(deps)).verificationTokens).toBe(2)
    expect(await hasToken(tenant, used)).toBe(false)
    expect(await hasToken(tenant, unused)).toBe(false)
    expect(await hasToken(otherTenant, later)).toBe(true)
  })

  test('removes sessions thirty days after they expire, with their refresh tokens', async () => {
    const expired = await session(tenant)
    const longer = await session(tenant, { idleExpiresAt: from(8 * DAY) })
    const foreign = await session(otherTenant)
    const retention = durationToMs(Retention.ENDED_SESSION_RETENTION)

    // One millisecond short of thirty days after the idle expiry: nothing goes yet.
    deps.clock.advance(7 * DAY + retention - 1)
    expect((await Retention.purge(deps)).sessions).toBe(0)
    expect(await hasSession(tenant, expired.id)).toBe(true)

    deps.clock.advance(1)
    expect((await Retention.purge(deps)).sessions).toBe(2)
    expect(await hasSession(tenant, expired.id)).toBe(false)
    expect(await deps.sessions.findTokenById(tenant.environmentId, expired.tokenId)).toBeNull()
    expect(await hasSession(otherTenant, foreign.id)).toBe(false)
    // Expired a day later, so it has a day left.
    expect(await hasSession(tenant, longer.id)).toBe(true)
    expect(await deps.sessions.findTokenById(tenant.environmentId, longer.tokenId)).not.toBeNull()
  })

  test('a revoked session goes thirty days after the revocation, not before', async () => {
    const revoked = await session(tenant, {
      idleExpiresAt: from(400 * DAY),
      absoluteExpiresAt: null,
    })
    await deps.sessions.revoke(tenant.environmentId, revoked.id, 'sign_out', deps.clock.now())
    deps.clock.advance(30 * DAY - 1)
    expect((await Retention.purge(deps)).sessions).toBe(0)
    deps.clock.advance(1)
    expect((await Retention.purge(deps)).sessions).toBe(1)
    expect(await deps.sessions.findTokenById(tenant.environmentId, revoked.tokenId)).toBeNull()
  })

  test('a session that can still be refreshed survives every run and still refreshes', async () => {
    const tokens = await Sessions.create(deps, tenant, {
      userId: USER,
      client: 'ios',
      userAgent: null,
      ipAddress: null,
    })
    // Kept alive by a refresh every six days, for far longer than the retention period.
    let refreshToken = tokens.refreshToken ?? ''
    for (let week = 0; week < 4; week++) {
      deps.clock.advance(6 * DAY)
      expect((await Retention.purge(deps)).sessions).toBe(0)
      refreshToken = (await Sessions.refresh(deps, tenant, refreshToken)).refreshToken ?? ''
      expect(refreshToken).not.toBe('')
    }
    expect(await hasSession(tenant, tokens.sessionId)).toBe(true)
  })

  test('a purged session’s refresh token is refused like any unknown token', async () => {
    const tokens = await Sessions.create(deps, tenant, {
      userId: USER,
      client: 'ios',
      userAgent: null,
      ipAddress: null,
    })
    deps.clock.advance(7 * DAY + 30 * DAY)
    expect((await Retention.purge(deps)).sessions).toBe(1)
    const refused = await Sessions.refresh(deps, tenant, tokens.refreshToken ?? '').then(
      () => null,
      (error: unknown) => error
    )
    expect(refused).toBeInstanceOf(ServiceException)
    expect((refused as ServiceException).status).toBe(401)
  })

  test('never deletes an audit entry', async () => {
    const tokens = await Sessions.create(deps, tenant, {
      userId: USER,
      client: 'ios',
      userAgent: null,
      ipAddress: null,
    })
    await Sessions.revoke(deps, tenant, {
      userId: USER,
      sessionId: tokens.sessionId,
      reason: 'revoked_by_admin',
      actor: TEST_ACTOR,
    })
    const recorded = deps.activityLog.entries.length
    expect(recorded).toBeGreaterThan(0)
    deps.clock.advance(400 * DAY)
    expect((await Retention.purge(deps)).sessions).toBe(1)
    expect(deps.activityLog.entries).toHaveLength(recorded)
    const { totalCount } = await deps.activityLog.listAudit(tenant.environmentId, {
      targetId: tokens.sessionId,
      page: 1,
      size: 10,
    })
    expect(totalCount).toBe(recorded)
  })

  test('one failing environment is logged and skipped; the others are still purged', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warn)
    await flowAttempt(tenant, from(1))
    const other = await flowAttempt(otherTenant, from(1))
    const stale = await session(otherTenant)
    deps.clock.advance(400 * DAY)
    const deleteExpired = deps.flowAttempts.deleteExpired.bind(deps.flowAttempts)
    spies.push(
      spyOn(deps.flowAttempts, 'deleteExpired').mockImplementation(
        async (environmentId, now, limit) => {
          if (environmentId === tenant.environmentId) {
            throw new Error('database unavailable')
          }
          return deleteExpired(environmentId, now, limit)
        }
      )
    )
    expect(await Retention.purge(deps)).toEqual({
      environments: 2,
      failed: 1,
      flowAttempts: 1,
      verificationTokens: 0,
      sessions: 1,
    })
    expect(await deps.flowAttempts.findById(otherTenant.environmentId, other)).toBeNull()
    expect(await hasSession(otherTenant, stale.id)).toBe(false)
    expect(warn).toHaveBeenCalledWith('retention failed in one environment', {
      environmentId: tenant.environmentId,
      err: expect.anything(),
    })
  })

  test('deletes in batches until a short one comes back', async () => {
    const total = Retention.RETENTION_BATCH_SIZE + 3
    for (let index = 0; index < total; index++) {
      await flowAttempt(tenant, from(1))
    }
    deps.clock.advance('1m')
    const batches = spyOn(deps.flowAttempts, 'deleteExpired')
    spies.push(batches)
    expect((await Retention.purge(deps)).flowAttempts).toBe(total)
    const forTenant = batches.mock.calls.filter(([id]) => id === tenant.environmentId)
    expect(forTenant.map(([, , limit]) => limit)).toEqual([
      Retention.RETENTION_BATCH_SIZE,
      Retention.RETENTION_BATCH_SIZE,
    ])
  })

  test('one run stops at its ceiling, leaving a backlog to the next', async () => {
    const batches = spyOn(deps.sessions, 'deleteEnded').mockImplementation(
      // A store that always has another full batch: the run must still end.
      async (_environmentId, _before, limit) => limit
    )
    spies.push(batches)
    const report = await Retention.purge(deps)
    expect(batches).toHaveBeenCalledTimes(2 * Retention.RETENTION_MAX_BATCHES)
    expect(report.sessions).toBe(
      2 * Retention.RETENTION_MAX_BATCHES * Retention.RETENTION_BATCH_SIZE
    )
  })
})

describe('run', () => {
  test('a second runner skips while the first is still running, and logs nothing', async () => {
    // Two API instances: their own dependency objects over the same stores and the same lock.
    const first = deps
    const second: TestDeps = { ...deps }
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    const debug = spyOn(logger, 'debug').mockImplementation(() => undefined)
    spies.push(info, debug)
    await flowAttempt(tenant, from(1))
    deps.clock.advance('1m')

    let finish: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let entered: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const listAll = deps.environments.listAll.bind(deps.environments)
    const slow = spyOn(deps.environments, 'listAll').mockImplementationOnce(async () => {
      entered()
      await gate
      return listAll()
    })
    spies.push(slow)

    const running = Retention.run(first)
    await started
    expect(await Retention.run(second)).toBeNull()
    expect(info).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()

    finish()
    expect(await running).toMatchObject({ flowAttempts: 1, failed: 0 })
    // The lock is free again: the other instance takes the next round.
    expect(await Retention.run(second)).toMatchObject({ flowAttempts: 0 })
  })

  test('logs one line per run, with counts only', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    const debug = spyOn(logger, 'debug').mockImplementation(() => undefined)
    spies.push(info, debug)
    await flowAttempt(tenant, from(1))
    deps.clock.advance('1m')

    const report = await Retention.run(deps)
    expect(info.mock.calls).toEqual([
      [
        'retention run finished',
        { environments: 2, failed: 0, flowAttempts: 1, verificationTokens: 0, sessions: 0 },
      ],
    ])
    expect(info.mock.calls[0]?.[1]).toEqual({ ...report })
    // A run with nothing to delete is routine: debug, so an idle server's log stays quiet.
    await Retention.run(deps)
    expect(info).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls.map(([message]) => message)).toEqual(['retention run finished'])
  })

  test('a run in which an environment failed is logged as a warning', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warn)
    spies.push(
      spyOn(deps.sessions, 'deleteEnded').mockRejectedValue(new Error('database unavailable'))
    )
    expect(await Retention.run(deps)).toMatchObject({ environments: 2, failed: 2 })
    expect(warn.mock.calls.at(-1)).toEqual([
      'retention run finished',
      { environments: 2, failed: 2, flowAttempts: 0, verificationTokens: 0, sessions: 0 },
    ])
  })

  test('a run that cannot list environments fails, and frees the lock', async () => {
    spies.push(
      spyOn(deps.environments, 'listAll').mockRejectedValueOnce(new Error('database unavailable'))
    )
    await expect(Retention.run(deps)).rejects.toThrow('database unavailable')
    expect(await Retention.run(deps)).toMatchObject({ environments: 2 })
  })
})
