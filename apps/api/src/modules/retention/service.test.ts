import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, durationToMs } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/service'
import * as Retention from '~/modules/retention/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Webhooks from '~/modules/webhook/service'
import { createTestDeps, TEST_ACTOR, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

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
    secretHash: 'a'.repeat(64),
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
    },
    Audit.none('fixture')
  )
  return { id, tokenId }
}

const hasSession = async (scope: Tenant, id: string) =>
  (await deps.sessions.findById(scope.environmentId, id)) !== null

describe('purge', () => {
  test('removes the counts of texted codes of days more than ninety days ago, and none sooner', async () => {
    // The test clock starts at midnight UTC: the counts are kept by day.
    const day = (ms: number) => from(ms).toISOString().slice(0, 10)
    const at = deps.clock.now()
    await deps.smsUsage.takeFromDay(tenant, day(-91 * DAY), '+1', 1_000_000, at)
    await deps.smsUsage.takeFromDay(tenant, day(-91 * DAY), '+49', 1_000_000, at)
    await deps.smsUsage.takeFromDay(tenant, day(-90 * DAY), '+1', 1_000_000, at)
    await deps.smsUsage.takeFromDay(tenant, day(0), '+1', 1_000_000, at)
    await deps.smsUsage.takeFromDay(otherTenant, day(-200 * DAY), '+1', 1_000_000, at)
    expect(await Retention.purge(deps)).toMatchObject({ smsCodeCounts: 3, failed: 0 })
    // The ninetieth day back is the first that stays.
    expect((await deps.smsUsage.summary(tenant.environmentId, day(-400 * DAY), 10)).sent).toBe(2)
    expect((await deps.smsUsage.summary(otherTenant.environmentId, day(-400 * DAY), 10)).sent).toBe(
      0
    )
    expect(await Retention.purge(deps)).toMatchObject({ smsCodeCounts: 0 })
    deps.clock.advance('24h')
    expect(await Retention.purge(deps)).toMatchObject({ smsCodeCounts: 1 })
  })

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
      pendingFactors: 0,
      passkeyChallenges: 0,
      instanceAuditLogs: 0,
      auditLogs: 0,
      webhookDeliveries: 0,
      events: 0,
      smsCodeCounts: 0,
      passwordHistory: 0,
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

  test('removes authenticator enrolments an hour after they lapse, and never a confirmed one', async () => {
    const pending = async (scope: Tenant, userId: string, expiresAt: Date) => {
      const id = deps.ids.next()
      expect(
        await deps.factors.startTotp({
          id,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId,
          type: 'totp',
          secret: `sealed-${id}`,
          createdAt: deps.clock.now(),
          expiresAt,
        })
      ).toBe(true)
      return id
    }
    const [abandoned, foreign, valid, confirmed] = [
      '00000000-0000-7000-8000-0000000000c1',
      '00000000-0000-7000-8000-0000000000c2',
      '00000000-0000-7000-8000-0000000000c3',
      '00000000-0000-7000-8000-0000000000c4',
    ] as const
    await pending(tenant, abandoned, from(10 * 60_000))
    await pending(otherTenant, foreign, from(10 * 60_000))
    await pending(tenant, valid, from(2 * HOUR))
    const factorId = await pending(tenant, confirmed, from(10 * 60_000))
    expect(
      await deps.factors.confirmTotp(tenant.environmentId, factorId, {
        activity: Audit.none('fixture'),
        step: 1,
        at: from(1),
        backupCodes: [{ id: deps.ids.next(), codeHash: 'hash-1' }],
      })
    ).toBe(true)
    const has = async (scope: Tenant, userId: string) =>
      (await deps.factors.findTotp(scope.environmentId, userId)) !== null

    // Lapsed, but inside the hour of grace: a confirmation in flight still finds its row.
    deps.clock.advance(10 * 60_000 + HOUR - 1)
    expect((await Retention.purge(deps)).pendingFactors).toBe(0)
    expect(await has(tenant, abandoned)).toBe(true)

    deps.clock.advance(1)
    expect(await Retention.purge(deps)).toEqual({
      environments: 2,
      failed: 0,
      flowAttempts: 0,
      verificationTokens: 0,
      sessions: 0,
      pendingFactors: 2,
      passkeyChallenges: 0,
      instanceAuditLogs: 0,
      auditLogs: 0,
      webhookDeliveries: 0,
      events: 0,
      smsCodeCounts: 0,
      passwordHistory: 0,
    })
    expect(await has(tenant, abandoned)).toBe(false)
    expect(await has(otherTenant, foreign)).toBe(false)
    // Not lapsed yet, or confirmed: kept, the backup codes included.
    expect(await has(tenant, valid)).toBe(true)
    expect(await deps.factors.findTotp(tenant.environmentId, confirmed)).toMatchObject({
      id: factorId,
      confirmedAt: expect.any(Date),
    })
    expect(await deps.factors.countBackupCodes(tenant.environmentId, confirmed)).toBe(1)
    // Nothing more to do on the next run; a confirmed factor survives every one.
    deps.clock.advance(365 * DAY)
    expect((await Retention.purge(deps)).pendingFactors).toBe(1)
    expect(await has(tenant, valid)).toBe(false)
    expect(await has(tenant, confirmed)).toBe(true)
  })

  test('a run that removed only lapsed enrolments is worth a log line, with the count', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    spies.push(info)
    await deps.factors.startTotp({
      id: deps.ids.next(),
      projectId: tenant.projectId,
      environmentId: tenant.environmentId,
      userId: USER,
      type: 'totp',
      secret: 'sealed',
      createdAt: deps.clock.now(),
      expiresAt: from(1),
    })
    deps.clock.advance(2 * HOUR)
    await Retention.run(deps)
    expect(info.mock.calls).toEqual([
      [
        'retention run finished',
        {
          environments: 2,
          failed: 0,
          flowAttempts: 0,
          verificationTokens: 0,
          sessions: 0,
          pendingFactors: 1,
          passkeyChallenges: 0,
          instanceAuditLogs: 0,
          auditLogs: 0,
          webhookDeliveries: 0,
          events: 0,
          smsCodeCounts: 0,
          passwordHistory: 0,
        },
      ],
    ])
    // The line has counts only: nothing about the user or the secret.
    expect(JSON.stringify(info.mock.calls)).not.toContain('sealed')
    expect(JSON.stringify(info.mock.calls)).not.toContain(USER)
  })

  test('an abandoned email sign-in leaves nothing behind: its attempt, binding hash and sign-in token all go', async () => {
    deps.environmentSettings.seed(tenant.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        signIn: {
          methods: {
            password: { enabled: true },
            emailCode: { enabled: true },
            emailLink: { enabled: true },
            passkey: { enabled: false },
          },
        },
      },
    })
    const context = {
      client: 'web',
      userAgent: null,
      ipAddress: null,
      originAllowed: true,
    } as const
    const scope = tenant
    const started = await Flows.signIn(deps, scope, { identifier: 'maya@northline.app' }, context)
    const prepared = await Flows.prepareFirstFactor(
      deps,
      scope,
      { id: started.attempt.id, secret: started.attempt.attemptSecret },
      { strategy: 'email_link', redirectUrl: 'http://localhost:5174/auth/link' },
      context
    )
    const stored = await deps.flowAttempts.findById(tenant.environmentId, started.attempt.id)
    expect(stored?.state.linkBindingHash).toBeString()
    expect(prepared.attempt.linkBinding).toBeString()
    const subject = { flowAttemptId: started.attempt.id }
    expect(
      await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', subject)
    ).not.toBeNull()

    // The attempt and its token expire together, ten minutes on; the attempt goes at once (and
    // in Postgres takes its tokens with it, by cascade), a token on its own an hour later.
    deps.clock.advance('10m')
    expect((await Retention.purge(deps)).flowAttempts).toBe(1)
    expect(await deps.flowAttempts.findById(tenant.environmentId, started.attempt.id)).toBeNull()
    deps.clock.advance(HOUR)
    await Retention.purge(deps)
    expect(
      await deps.verificationTokens.findLatest(tenant.environmentId, 'sign_in', subject)
    ).toBeNull()
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
    await deps.sessions.revoke(
      tenant.environmentId,
      revoked.id,
      'sign_out',
      deps.clock.now(),
      Audit.none('fixture')
    )
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

  test('an environment that saved no settings keeps its audit entries: the default is for ever', async () => {
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

  test('removes instance audit entries past the deployment’s retention period, and none sooner', async () => {
    const record = (type: 'instance.signed_in' | 'instance.sign_in_failed') =>
      deps.controlPlane.record({
        id: deps.ids.next(),
        type,
        actor: { type: 'instance_admin', id: null },
        target: null,
        ipAddress: null,
        userAgent: null,
        data: {},
        occurredAt: deps.clock.now(),
      })
    await record('instance.sign_in_failed')
    deps.clock.advance(100 * DAY)
    await record('instance.signed_in')
    // The default period is a year.
    expect(deps.config.instanceAuditRetentionDays).toBe(365)
    deps.clock.advance(264 * DAY)
    expect((await Retention.purge(deps)).instanceAuditLogs).toBe(0)
    expect(deps.controlPlane.entries).toHaveLength(2)
    deps.clock.advance(2 * DAY)
    expect((await Retention.purge(deps)).instanceAuditLogs).toBe(1)
    expect(deps.controlPlane.entries.map((entry) => entry.type)).toEqual(['instance.signed_in'])
  })

  test('a deployment can keep instance audit entries for another period', async () => {
    const short = createTestDeps({ config: { ...TEST_CONFIG, instanceAuditRetentionDays: 30 } })
    await short.controlPlane.record({
      id: short.ids.next(),
      type: 'instance.signed_out',
      actor: { type: 'instance_admin', id: null },
      target: null,
      ipAddress: null,
      userAgent: null,
      data: {},
      occurredAt: short.clock.now(),
    })
    short.clock.advance(31 * DAY)
    expect((await Retention.purge(short)).instanceAuditLogs).toBe(1)
  })

  test('a failing instance audit purge is logged and does not stop the environments’ purge', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    deps.controlPlane.deleteAuditBefore = async () => {
      throw new Error('connection refused')
    }
    try {
      const report = await Retention.purge(deps)
      expect(report.instanceAuditLogs).toBe(0)
      expect(report.failed).toBe(1)
      expect(report.environments).toBeGreaterThan(0)
    } finally {
      warn.mockRestore()
    }
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
      pendingFactors: 0,
      passkeyChallenges: 0,
      instanceAuditLogs: 0,
      auditLogs: 0,
      webhookDeliveries: 0,
      events: 0,
      smsCodeCounts: 0,
      passwordHistory: 0,
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

test('the retention job is the only code of the server that deletes audit entries', async () => {
  // Deleting evidence has one door (AGENTS.md, ADR 0012): a second caller, with a cutoff of
  // its own, would not be bound by the environment's period.
  const callers: string[] = []
  const source = new URL('../..', import.meta.url).pathname
  for await (const file of new Bun.Glob('**/*.ts').scan(source)) {
    const isTest = /\.(test|suite|integration)\.ts$/.test(file) || file === 'testing.ts'
    // Where the method is declared and implemented, and the instance audit log's own purge
    // of the same name (another port, reached only as `controlPlane.deleteAuditBefore`).
    const declares = /^(ports|adapters\/[^/]+)\/(activity|control-plane)/.test(file)
    if (isTest || declares) {
      continue
    }
    const text = await Bun.file(`${source}${file}`).text()
    if (/(?<!controlPlane\.)deleteAuditBefore\b/.test(text)) {
      callers.push(file)
    }
  }
  expect(callers).toEqual(['modules/retention/service.ts'])
})

describe('audit retention', () => {
  /** Record one audit entry in an environment, at the test clock's current time. */
  function auditEntry(scope: Tenant): string {
    const id = deps.ids.next()
    deps.activityLog.record([
      {
        id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        type: 'user.created',
        actor: { type: 'system', id: null },
        target: { type: 'user', id: USER },
        ipAddress: null,
        userAgent: null,
        data: {},
        occurredAt: deps.clock.now(),
      },
    ])
    return id
  }

  /** Store an environment's settings with this audit retention period, as they would sit. */
  function keepAuditFor(scope: Tenant, retentionDays: unknown): void {
    deps.environmentSettings.seed(scope.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        audit: { retentionDays: retentionDays as number | null },
      },
    })
  }

  const auditIds = (scope: Tenant) =>
    deps.activityLog.entries
      .filter((entry) => entry.environmentId === scope.environmentId)
      .map((entry) => entry.id)

  test('deletes an environment’s entries older than its period, and none sooner', async () => {
    keepAuditFor(tenant, 30)
    const old = auditEntry(tenant)
    deps.clock.advance(DAY)
    const younger = auditEntry(tenant)

    // Exactly as old as the period: kept. One millisecond older: gone.
    deps.clock.advance(29 * DAY)
    expect((await Retention.purge(deps)).auditLogs).toBe(0)
    expect(auditIds(tenant)).toEqual([old, younger])
    deps.clock.advance(1)
    expect(await Retention.purge(deps)).toMatchObject({ auditLogs: 1, failed: 0 })
    expect(auditIds(tenant)).toEqual([younger])
  })

  test('the period set through the admin API is the one applied', async () => {
    const old = auditEntry(tenant)
    await Settings.replace(
      deps,
      tenant,
      {
        expectedRevision: 0,
        settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, audit: { retentionDays: 7 } },
      },
      TEST_ACTOR
    )
    deps.clock.advance(7 * DAY + 1)
    // The entry that says the period was set is as old as the one it dooms: both go.
    expect((await Retention.purge(deps)).auditLogs).toBe(2)
    expect(auditIds(tenant)).not.toContain(old)
  })

  test('an environment whose period is `null` keeps every entry, however old', async () => {
    keepAuditFor(tenant, null)
    const entry = auditEntry(tenant)
    const deleteAudit = spyOn(deps.activityLog, 'deleteAuditBefore')
    spies.push(deleteAudit)
    deps.clock.advance(4_000 * DAY)
    expect(await Retention.purge(deps)).toMatchObject({ auditLogs: 0, failed: 0 })
    expect(auditIds(tenant)).toEqual([entry])
    // Not "a delete that matched nothing": no delete is asked for at all.
    expect(deleteAudit).not.toHaveBeenCalled()
  })

  test('two environments with different periods are each purged by their own', async () => {
    keepAuditFor(tenant, 7)
    keepAuditFor(otherTenant, 90)
    auditEntry(tenant)
    const long = auditEntry(otherTenant)

    deps.clock.advance(8 * DAY)
    expect((await Retention.purge(deps)).auditLogs).toBe(1)
    expect(auditIds(tenant)).toEqual([])
    expect(auditIds(otherTenant)).toEqual([long])

    deps.clock.advance(83 * DAY)
    expect((await Retention.purge(deps)).auditLogs).toBe(1)
    expect(auditIds(otherTenant)).toEqual([])
  })

  test('one environment’s period never deletes another environment’s entries', async () => {
    keepAuditFor(tenant, 1)
    const mine = auditEntry(tenant)
    const theirs = auditEntry(otherTenant)
    const deleteAudit = spyOn(deps.activityLog, 'deleteAuditBefore')
    spies.push(deleteAudit)
    deps.clock.advance(400 * DAY)
    expect((await Retention.purge(deps)).auditLogs).toBe(1)
    expect(auditIds(tenant)).not.toContain(mine)
    expect(auditIds(otherTenant)).toEqual([theirs])
    expect(deleteAudit.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      tenant.environmentId,
    ])
  })

  test.each([
    ['zero', 0],
    ['negative', -30],
    ['a fraction of a day', 0.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['a string', '30'],
    ['missing', undefined],
  ])('a stored period that is %s deletes nothing', async (_, stored) => {
    // The admin API refuses these; this is a document changed by hand, or by another version.
    keepAuditFor(tenant, stored)
    const entry = auditEntry(tenant)
    const deleteAudit = spyOn(deps.activityLog, 'deleteAuditBefore')
    spies.push(deleteAudit)
    deps.clock.advance(4_000 * DAY)
    expect((await Retention.purge(deps)).auditLogs).toBe(0)
    expect(auditIds(tenant)).toEqual([entry])
    expect(deleteAudit).not.toHaveBeenCalled()
  })

  test('reads the period from the source, past this instance’s settings cache', async () => {
    // A period lengthened on another instance must not be undercut by a stale copy here:
    // unlike every other setting, acting on an old value destroys something.
    const get = spyOn(deps.environmentSettings, 'get')
    spies.push(get)
    await Retention.purge(deps)
    // The memory store declares one parameter (it has no cache to read past): widen the calls.
    // Twice an environment: its audit period, and its password history (below).
    expect(get.mock.calls as unknown[][]).toEqual([
      [tenant.environmentId, true],
      [tenant.environmentId, true],
      [otherTenant.environmentId, true],
      [otherTenant.environmentId, true],
    ])
  })

  test('settings that cannot be read keep that environment’s entries; the others are purged', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warn)
    keepAuditFor(tenant, 1)
    keepAuditFor(otherTenant, 1)
    const kept = auditEntry(tenant)
    auditEntry(otherTenant)
    deps.clock.advance(10 * DAY)
    const get = deps.environmentSettings.get.bind(deps.environmentSettings)
    spies.push(
      spyOn(deps.environmentSettings, 'get').mockImplementation(async (environmentId) => {
        if (environmentId === tenant.environmentId) {
          throw new Error('settings store is down')
        }
        return get(environmentId)
      })
    )
    const deleteAudit = spyOn(deps.activityLog, 'deleteAuditBefore')
    spies.push(deleteAudit)
    expect(await Retention.purge(deps)).toMatchObject({ environments: 2, failed: 1, auditLogs: 1 })
    expect(auditIds(tenant)).toEqual([kept])
    expect(auditIds(otherTenant)).toEqual([])
    expect(deleteAudit.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      otherTenant.environmentId,
    ])
    expect(warn).toHaveBeenCalledWith('retention failed in one environment', {
      environmentId: tenant.environmentId,
      err: expect.anything(),
    })
  })

  test('a failing audit purge in one environment does not stop the others', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warn)
    keepAuditFor(tenant, 1)
    keepAuditFor(otherTenant, 1)
    const kept = auditEntry(tenant)
    auditEntry(otherTenant)
    deps.clock.advance(10 * DAY)
    const deleteAudit = deps.activityLog.deleteAuditBefore.bind(deps.activityLog)
    spies.push(
      spyOn(deps.activityLog, 'deleteAuditBefore').mockImplementation(
        async (environmentId, before, limit) => {
          if (environmentId === tenant.environmentId) {
            throw new Error('the audit store refused')
          }
          return deleteAudit(environmentId, before, limit)
        }
      )
    )
    expect(await Retention.purge(deps)).toMatchObject({ environments: 2, failed: 1, auditLogs: 1 })
    expect(auditIds(tenant)).toEqual([kept])
    expect(auditIds(otherTenant)).toEqual([])
  })

  test('an environment whose pass failed before its audit purge is finished by the next run', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warn)
    keepAuditFor(tenant, 1)
    auditEntry(tenant)
    deps.clock.advance(10 * DAY)
    spies.push(
      spyOn(deps.sessions, 'deleteEnded').mockRejectedValueOnce(new Error('sessions store is down'))
    )
    expect(await Retention.purge(deps)).toMatchObject({ failed: 1, auditLogs: 0 })
    expect(await Retention.purge(deps)).toMatchObject({ failed: 0, auditLogs: 1 })
  })

  test('deletes in batches, and stops at the run’s ceiling', async () => {
    keepAuditFor(tenant, 1)
    const total = Retention.RETENTION_BATCH_SIZE + 3
    for (let index = 0; index < total; index++) {
      auditEntry(tenant)
    }
    deps.clock.advance(2 * DAY)
    const batches = spyOn(deps.activityLog, 'deleteAuditBefore')
    spies.push(batches)
    expect((await Retention.purge(deps)).auditLogs).toBe(total)
    expect(batches.mock.calls.map(([, , limit]) => limit)).toEqual([
      Retention.RETENTION_BATCH_SIZE,
      Retention.RETENTION_BATCH_SIZE,
    ])
    const cutoff = new Date(deps.clock.now().getTime() - DAY)
    expect(batches.mock.calls.map(([, before]) => before)).toEqual([cutoff, cutoff])

    batches.mockImplementation(async (_environmentId, _before, limit) => limit)
    expect((await Retention.purge(deps)).auditLogs).toBe(
      Retention.RETENTION_MAX_BATCHES * Retention.RETENTION_BATCH_SIZE
    )
  })

  test('says in the server log which environment lost entries, how many and under what period', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    const debug = spyOn(logger, 'debug').mockImplementation(() => undefined)
    spies.push(info, debug)
    keepAuditFor(tenant, 30)
    keepAuditFor(otherTenant, 30)
    auditEntry(tenant)
    auditEntry(tenant)
    deps.clock.advance(31 * DAY)
    await Retention.run(deps)
    // The deleted entries cannot say so themselves: this line is the record that they went.
    expect(info.mock.calls).toEqual([
      [
        'audit entries past the retention period deleted',
        { environmentId: tenant.environmentId, retentionDays: 30, deleted: 2 },
      ],
      ['retention run finished', expect.objectContaining({ auditLogs: 2 })],
    ])
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
        {
          environments: 2,
          failed: 0,
          flowAttempts: 1,
          verificationTokens: 0,
          sessions: 0,
          pendingFactors: 0,
          passkeyChallenges: 0,
          instanceAuditLogs: 0,
          auditLogs: 0,
          webhookDeliveries: 0,
          events: 0,
          smsCodeCounts: 0,
          passwordHistory: 0,
        },
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
      {
        environments: 2,
        failed: 2,
        flowAttempts: 0,
        verificationTokens: 0,
        sessions: 0,
        pendingFactors: 0,
        passkeyChallenges: 0,
        instanceAuditLogs: 0,
        auditLogs: 0,
        webhookDeliveries: 0,
        events: 0,
        smsCodeCounts: 0,
        passwordHistory: 0,
      },
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

describe('the webhook worker’s leavings', () => {
  /** Record that something happened. Returns the event's id. */
  function happen(scope: Tenant = tenant): string {
    const activity = Audit.entry(deps, scope, {
      type: 'user.deleted',
      actor: TEST_ACTOR,
      target: { type: 'user', id: deps.ids.next() },
    })
    deps.activityLog.record([activity])
    return activity.id
  }

  const exists = (eventId: string) => deps.activityLog.outbox.some((row) => row.id === eventId)

  /** Mark an event settled, as the worker does, at the clock's time. */
  const settle = (eventId: string, scope: Tenant = tenant) =>
    deps.webhookDeliveries.markDelivered(scope.environmentId, [eventId], deps.clock.now())

  /** An endpoint nothing is ever sent to here: the store only needs it to exist. */
  async function endpoint(scope: Tenant = tenant): Promise<string> {
    const id = deps.ids.next()
    await deps.webhookEndpoints.insert(
      {
        id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        url: 'https://hooks.example.com/tula',
        eventTypes: ['user.deleted'],
        secret: 'sealed',
        previousSecret: null,
        previousSecretExpiresAt: null,
        enabled: true,
        disabledReason: null,
        failingSince: null,
        lastFailedAt: null,
        createdAt: deps.clock.now(),
        updatedAt: deps.clock.now(),
      },
      Audit.none('fixture')
    )
    return id
  }

  /** Queue a delivery of an event now, and end it or leave it pending. */
  async function delivery(
    endpointId: string,
    eventId: string,
    end: 'delivered' | 'failed' | null,
    scope: Tenant = tenant
  ): Promise<string> {
    const id = deps.ids.next()
    await deps.webhookDeliveries.enqueue([
      {
        id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        endpointId,
        eventId,
        eventType: 'user.deleted',
        at: deps.clock.now(),
      },
    ])
    if (end) {
      await deps.webhookDeliveries.recordAttempt(
        scope.environmentId,
        id,
        {
          id: deps.ids.next(),
          attemptedAt: deps.clock.now(),
          statusCode: end === 'delivered' ? 204 : 500,
          durationMs: 1,
          failureReason: null,
        },
        { state: end, nextAttemptAt: null, completedAt: deps.clock.now() },
        'pending'
      )
    }
    return id
  }

  const deliveryExists = (id: string) => deps.webhookDeliveries.rows.some((row) => row.id === id)

  test('a settled event is deleted thirty days after it was settled, not a moment sooner', async () => {
    const eventId = happen()
    deps.clock.advance('2d')
    await settle(eventId)
    deps.clock.advance(Retention.SETTLED_EVENT_RETENTION)
    // Exactly thirty days after it was settled (thirty-two after it happened): kept.
    expect(await Retention.purge(deps)).toMatchObject({ events: 0, failed: 0 })
    expect(exists(eventId)).toBe(true)
    deps.clock.advance(1)
    expect(await Retention.purge(deps)).toMatchObject({ events: 1, failed: 0 })
    expect(exists(eventId)).toBe(false)
  })

  test('an event no worker has settled is never deleted, however old', async () => {
    const eventId = happen()
    deps.clock.advance('400d')
    expect(await Retention.purge(deps)).toMatchObject({ events: 0 })
    expect(exists(eventId)).toBe(true)
  })

  test('deleting an event leaves its audit entry, and deleting an audit entry leaves its event', async () => {
    const eventId = happen()
    await settle(eventId)
    deps.clock.advance('31d')
    await Retention.purge(deps)
    expect(exists(eventId)).toBe(false)
    expect(deps.activityLog.entries.map((entry) => entry.id)).toContain(eventId)
  })

  test('an event is kept while a delivery of it is still pending, and goes once that delivery has ended', async () => {
    const at = await endpoint()
    const eventId = happen()
    const pending = await delivery(at, eventId, null)
    await settle(eventId)
    deps.clock.advance('31d')
    expect(await Retention.purge(deps)).toMatchObject({ events: 0 })
    expect(exists(eventId)).toBe(true)
    await deps.webhookDeliveries.giveUp(
      tenant.environmentId,
      [pending],
      'expired',
      deps.clock.now()
    )
    expect(await Retention.purge(deps)).toMatchObject({ events: 1 })
    expect(exists(eventId)).toBe(false)
  })

  test('the record of a delivery outlives its event: it is read, with its attempts, until ninety days are up', async () => {
    const at = await endpoint()
    const eventId = happen()
    const id = await delivery(at, eventId, 'failed')
    await settle(eventId)
    deps.clock.advance('31d')
    expect(await Retention.purge(deps)).toMatchObject({ events: 1, webhookDeliveries: 0 })
    expect(exists(eventId)).toBe(false)
    // The log is whole: which event, what was tried, how it ended.
    expect(await Webhooks.getDelivery(deps, tenant, at, id)).toMatchObject({
      eventId,
      eventType: 'user.deleted',
      state: 'failed',
      attempts: [{ attempt: 1, statusCode: 500 }],
    })
    // And "send it again" says plainly that there is nothing left to send.
    const error = await Webhooks.redeliver(deps, tenant, at, id).then(
      () => null,
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(ServiceException)
    expect(error).toMatchObject({
      code: 'webhook.cannot_redeliver',
      params: { reason: 'event_gone' },
    })

    deps.clock.advance('59d')
    expect(await Retention.purge(deps)).toMatchObject({ webhookDeliveries: 0 })
    expect(deliveryExists(id)).toBe(true)
    deps.clock.advance(1)
    expect(await Retention.purge(deps)).toMatchObject({ webhookDeliveries: 1 })
    expect(deliveryExists(id)).toBe(false)
    expect(deps.webhookDeliveries.attemptsOf(id)).toEqual([])
  })

  test('a delivery that is still pending is never deleted, however old', async () => {
    const at = await endpoint()
    const id = await delivery(at, happen(), null)
    deps.clock.advance('400d')
    expect(await Retention.purge(deps)).toMatchObject({ webhookDeliveries: 0 })
    expect(deliveryExists(id)).toBe(true)
  })

  test('both purges go in bounded batches through the stores, one environment at a time', async () => {
    const events = spyOn(deps.webhookDeliveries, 'deleteSettledEvents')
    const deliveries = spyOn(deps.webhookDeliveries, 'deleteEndedBefore')
    spies.push(events as never, deliveries as never)
    await Retention.purge(deps)
    for (const calls of [events.mock.calls, deliveries.mock.calls]) {
      expect(calls.map(([environment]) => environment).sort()).toEqual(
        [tenant.environmentId, otherTenant.environmentId].sort()
      )
      expect(calls.every(([, , limit]) => limit === Retention.RETENTION_BATCH_SIZE)).toBe(true)
    }
    const age = (calls: [string, Date, number][]) =>
      calls.map(([, before]) => deps.clock.now().getTime() - before.getTime())
    expect(new Set(age(events.mock.calls))).toEqual(
      new Set([durationToMs(Retention.SETTLED_EVENT_RETENTION)])
    )
    expect(new Set(age(deliveries.mock.calls))).toEqual(
      new Set([durationToMs(Retention.ENDED_DELIVERY_RETENTION)])
    )
  })

  test('a backlog larger than a batch is drained in one run', async () => {
    const at = await endpoint()
    const count = Retention.RETENTION_BATCH_SIZE + 20
    for (let index = 0; index < count; index++) {
      const eventId = happen()
      await delivery(at, eventId, 'delivered')
      await settle(eventId)
    }
    deps.clock.advance('91d')
    expect(await Retention.purge(deps)).toMatchObject({ events: count, webhookDeliveries: count })
    expect(deps.activityLog.outbox).toEqual([])
    expect(deps.webhookDeliveries.rows).toEqual([])
  })

  test('one environment’s purge never touches another’s events or deliveries', async () => {
    const mine = happen(tenant)
    const theirs = happen(otherTenant)
    const theirDelivery = await delivery(
      await endpoint(otherTenant),
      theirs,
      'delivered',
      otherTenant
    )
    await settle(mine)
    await settle(theirs, otherTenant)
    deps.clock.advance('91d')
    const purgeEvents = deps.webhookDeliveries.deleteSettledEvents.bind(deps.webhookDeliveries)
    spies.push(
      spyOn(deps.webhookDeliveries, 'deleteSettledEvents').mockImplementation(
        async (environment, before, limit) =>
          environment === otherTenant.environmentId ? 0 : purgeEvents(environment, before, limit)
      ) as never
    )
    const purgeDeliveries = deps.webhookDeliveries.deleteEndedBefore.bind(deps.webhookDeliveries)
    spies.push(
      spyOn(deps.webhookDeliveries, 'deleteEndedBefore').mockImplementation(
        async (environment, before, limit) =>
          environment === otherTenant.environmentId
            ? 0
            : purgeDeliveries(environment, before, limit)
      ) as never
    )
    await Retention.purge(deps)
    expect(exists(mine)).toBe(false)
    expect(exists(theirs)).toBe(true)
    expect(deliveryExists(theirDelivery)).toBe(true)
  })

  test('the periods: a delivery can be sent again for a month, and its record is read for three', () => {
    const events = durationToMs(Retention.SETTLED_EVENT_RETENTION)
    const deliveries = durationToMs(Retention.ENDED_DELIVERY_RETENTION)
    expect(events).toBe(30 * DAY)
    expect(deliveries).toBe(90 * DAY)
    // The log outlives the payload, and both outlive everything the worker itself still does.
    expect(deliveries).toBeGreaterThan(events)
    expect(events).toBeGreaterThan(durationToMs(Webhooks.WEBHOOK_DELIVERY_MAX_AGE))
    // Above the floors the database keeps (migration 0019): a day for an event, a week for a
    // delivery. The job never asks for less.
    expect(events).toBeGreaterThan(DAY)
    expect(deliveries).toBeGreaterThan(7 * DAY)
  })

  test('a run that removed only events and deliveries is worth a log line', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    spies.push(info as never)
    const eventId = happen()
    await settle(eventId)
    deps.clock.advance('31d')
    await Retention.run(deps)
    expect(info.mock.calls).toEqual([
      ['retention run finished', expect.objectContaining({ events: 1, webhookDeliveries: 0 })],
    ])
  })
})

describe('previous passwords beyond the password history (ADR 0038)', () => {
  /** Store an environment's settings with this `password.history`, as they would sit. */
  function historyOf(scope: Tenant, history: unknown): void {
    deps.environmentSettings.seed(scope.environmentId, {
      revision: 1,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        password: { ...DEFAULT_ENVIRONMENT_SETTINGS.password, history: history as number },
      },
    })
  }

  /** A user who has had `changes + 1` passwords, every one of them kept. */
  async function userWith(scope: Tenant, changes: number): Promise<string> {
    const id = deps.ids.next()
    await deps.users.create(
      {
        id,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        email: `${id}@northline.app`,
        emailNormalized: `${id}@northline.app`,
        emailVerifiedAt: null,
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: '$argon2id$0',
      },
      Audit.none('fixture')
    )
    for (let n = 1; n <= changes; n++) {
      await deps.users.setPasswordHash(
        scope.environmentId,
        id,
        `$argon2id$${n}`,
        deps.clock.now(),
        Audit.none('fixture'),
        { keep: 24 }
      )
    }
    return id
  }

  const previous = async (scope: Tenant, userId: string) =>
    (await deps.users.storedPasswords(scope.environmentId, userId, 24)).previous

  test('a lowered history deletes what is beyond it for users who changed nothing since', async () => {
    const user = await userWith(tenant, 6)
    historyOf(tenant, 3)
    expect(await Retention.purge(deps)).toMatchObject({ passwordHistory: 4, failed: 0 })
    // The current password is one of the three; the two before it stay.
    expect(await previous(tenant, user)).toEqual(['$argon2id$5', '$argon2id$4'])
    expect(await Retention.purge(deps)).toMatchObject({ passwordHistory: 0 })
  })

  test.each([
    [0, []],
    [1, []],
    [2, ['$argon2id$3']],
    [24, ['$argon2id$3', '$argon2id$2', '$argon2id$1', '$argon2id$0']],
  ])('a history of %d keeps the previous %j', async (history, kept) => {
    const user = await userWith(tenant, 4)
    historyOf(tenant, history)
    await Retention.purge(deps)
    expect(await previous(tenant, user)).toEqual(kept)
  })

  test('an environment that saved no settings uses the deployment’s number', async () => {
    const user = await userWith(tenant, 4)
    // The recommended preset keeps none.
    expect(await Retention.purge(deps)).toMatchObject({ passwordHistory: 4 })
    expect(await previous(tenant, user)).toEqual([])
  })

  test('each environment is purged by its own number', async () => {
    const here = await userWith(tenant, 4)
    const there = await userWith(otherTenant, 4)
    historyOf(tenant, 5)
    historyOf(otherTenant, 2)
    expect(await Retention.purge(deps)).toMatchObject({ passwordHistory: 3 })
    expect(await previous(tenant, here)).toHaveLength(4)
    expect(await previous(otherTenant, there)).toEqual(['$argon2id$3'])
  })

  test.each([-1, 1.5, 25, '2', null, undefined, Number.NaN])(
    'a stored history of %p deletes nothing',
    async (history) => {
      const user = await userWith(tenant, 4)
      historyOf(tenant, history)
      const purge = spyOn(deps.users, 'deletePasswordHistoryBeyond')
      spies.push(purge)
      expect(await Retention.purge(deps)).toMatchObject({ failed: 0 })
      expect(
        purge.mock.calls.filter(([environmentId]) => environmentId === tenant.environmentId)
      ).toEqual([])
      expect(await previous(tenant, user)).toHaveLength(4)
    }
  )

  test('settings that cannot be read keep that environment’s rows; the others are purged', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    spies.push(warn)
    const kept = await userWith(tenant, 3)
    const purged = await userWith(otherTenant, 3)
    const get = deps.environmentSettings.get.bind(deps.environmentSettings)
    spies.push(
      spyOn(deps.environmentSettings, 'get').mockImplementation(async (environmentId) => {
        if (environmentId === tenant.environmentId) {
          throw new Error('settings store is down')
        }
        return get(environmentId)
      })
    )
    expect(await Retention.purge(deps)).toMatchObject({ failed: 1, passwordHistory: 3 })
    expect(await previous(tenant, kept)).toHaveLength(3)
    expect(await previous(otherTenant, purged)).toEqual([])
  })

  test('deletes in bounded batches through the store, one environment at a time', async () => {
    await userWith(tenant, 3)
    historyOf(tenant, 1)
    historyOf(otherTenant, 4)
    const purge = spyOn(deps.users, 'deletePasswordHistoryBeyond')
    spies.push(purge)
    await Retention.purge(deps)
    expect(purge.mock.calls).toEqual([
      [tenant.environmentId, 0, Retention.RETENTION_BATCH_SIZE],
      [otherTenant.environmentId, 3, Retention.RETENTION_BATCH_SIZE],
    ])
  })

  test('says in the server log which environment lost rows and how many, and nothing of them', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => undefined)
    spies.push(info)
    const user = await userWith(tenant, 3)
    historyOf(tenant, 2)
    await Retention.run(deps)
    expect(info.mock.calls).toEqual([
      [
        'previous passwords beyond the password history deleted',
        { environmentId: tenant.environmentId, history: 2, deleted: 2 },
      ],
      ['retention run finished', expect.objectContaining({ passwordHistory: 2 })],
    ])
    const logged = JSON.stringify(info.mock.calls)
    expect(logged).not.toContain('argon2')
    expect(logged).not.toContain(user)
  })
})
