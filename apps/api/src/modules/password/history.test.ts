import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import type { Tenant } from '~/dependencies'
import { ServiceException } from '~/exceptions'
import * as logger from '~/lib/logger'
import { base32Decode, totp } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as Sessions from '~/modules/session/service'
import * as Settings from '~/modules/settings/service'
import * as Users from '~/modules/user/service'
import { createTestDeps, TEST_ACTOR, TEST_CONFIG, TEST_TENANT, type TestDeps } from '~/testing'

// Password history (ADR 0038): a user's new password is refused when it is one of their last
// `password.history` passwords, the current one included.

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const otherTenant: Tenant = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

/** Passwords the recommended policy accepts, by number: `P(1)` is the account's first. */
const P = (n: number) => `granite lantern harbour ${n}`
const EMAIL = 'maya@northline.app'

let deps: TestDeps

/** Set the deployment's default `password.history`: what an environment with no settings has. */
function history(n: number): void {
  deps.config = {
    ...TEST_CONFIG,
    passwordPolicy: { ...PASSWORD_POLICY_PRESETS.recommended, preset: 'custom', history: n },
  }
}

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

afterEach(() => Notices.settled())

async function rejection(promise: Promise<unknown>): Promise<ServiceException> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ServiceException) {
      return err
    }
    throw err
  }
  throw new Error('expected a rejection')
}

/** A user whose password is `P(1)`. */
async function createUser(scope: Tenant = tenant, email = EMAIL) {
  return Users.create(deps, scope, { email, password: P(1), emailVerified: true }, TEST_ACTOR)
}

const signIn = (userId: string, scope: Tenant = tenant) =>
  Sessions.create(deps, scope, { userId, client: 'web', userAgent: null, ipAddress: null })

/** The user changes their own password, proving the current one. */
async function change(userId: string, from: number, to: number, scope: Tenant = tenant) {
  const { sessionId } = await signIn(userId, scope)
  return Users.changePassword(
    deps,
    scope,
    { userId, sessionId },
    { currentPassword: P(from), newPassword: P(to) }
  )
}

/** A reset: the proof is spent by `claim`. */
function reset(userId: string, to: number, claim: () => Promise<void> = async () => undefined) {
  return Users.resetPassword(
    deps,
    tenant,
    userId,
    P(to),
    { type: 'user', id: userId, ipAddress: null, userAgent: null },
    claim
  )
}

const liveSessions = (userId: string) =>
  deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())

const stored = (userId: string, scope: Tenant = tenant) =>
  deps.users.storedPasswords(scope.environmentId, userId, 24)

/** Which of the numbered passwords the stored hashes are, the current one first. */
async function remembered(userId: string, upTo: number, scope: Tenant = tenant) {
  const { current, previous } = await stored(userId, scope)
  const numbers: number[] = []
  for (const hash of [current, ...previous]) {
    for (let n = 1; n <= upTo; n++) {
      if (await Passwords.verify(hash, P(n))) {
        numbers.push(n)
      }
    }
  }
  return numbers
}

const auditOf = async (userId: string) =>
  (await deps.activityLog.listAudit(tenant.environmentId, { targetId: userId, page: 1, size: 50 }))
    .entries

function expectReused(error: ServiceException, n: number): void {
  expect(error.toJSON()).toEqual({
    status: 422,
    code: 'password.reused',
    detail: 'You have used this password recently. Choose a different one.',
    params: { history: n },
    errors: [
      {
        field: 'password',
        code: 'password.reused',
        message: 'You have used this password recently. Choose a different one.',
        params: { history: n },
      },
    ],
  })
}

describe('a history of zero behaves as it did before there was one', () => {
  test('any earlier password is accepted again, and nothing is kept', async () => {
    const user = await createUser()
    const read = spyOn(deps.users, 'storedPasswords')
    const counted = spyOn(deps.rateLimiter, 'hit')
    await change(user.id, 1, 2)
    await change(user.id, 2, 1)
    // The current password too: nothing is compared.
    await change(user.id, 1, 1)
    await reset(user.id, 1)
    expect(read).not.toHaveBeenCalled()
    expect(counted.mock.calls.filter(([key]) => key.startsWith('password_history'))).toEqual([])
    read.mockRestore()
    expect(await remembered(user.id, 2)).toEqual([1])
    expect((await stored(user.id)).previous).toEqual([])
  })

  test('the audit entry of a change is what it always was', async () => {
    const user = await createUser()
    await change(user.id, 1, 2)
    const [entry] = (await auditOf(user.id)).filter((e) => e.type === 'user.password_changed')
    expect(entry?.data).toEqual({ method: 'self' })
  })
})

describe('what counts as one of the last N', () => {
  test('N = 1 refuses the current password and nothing else', async () => {
    history(1)
    const user = await createUser()
    expectReused(await rejection(change(user.id, 1, 1)), 1)
    await change(user.id, 1, 2)
    // Nothing before the current one is kept, so the one before it is free again.
    expect((await stored(user.id)).previous).toEqual([])
    expectReused(await rejection(change(user.id, 2, 2)), 1)
    await change(user.id, 2, 1)
    expect(await remembered(user.id, 2)).toEqual([1])
  })

  test('N = 3 refuses the third-last and accepts the fourth-last', async () => {
    history(3)
    const user = await createUser()
    await change(user.id, 1, 2)
    await change(user.id, 2, 3)
    await change(user.id, 3, 4)
    // The last three are 4, 3 and 2.
    expect(await remembered(user.id, 4)).toEqual([4, 3, 2])
    for (const n of [4, 3, 2]) {
      expectReused(await rejection(change(user.id, 4, n)), 3)
    }
    await change(user.id, 4, 1)
    expect(await remembered(user.id, 4)).toEqual([1, 4, 3])
  })

  test('the same passphrase typed in another Unicode form is the same password', async () => {
    history(2)
    const composed = 'café lantern harbour 1'
    const decomposed = 'café lantern harbour 1'
    const user = await Users.create(
      deps,
      tenant,
      { email: EMAIL, password: composed, emailVerified: true },
      TEST_ACTOR
    )
    const { sessionId } = await signIn(user.id)
    const error = await rejection(
      Users.changePassword(
        deps,
        tenant,
        { userId: user.id, sessionId },
        { currentPassword: composed, newPassword: decomposed }
      )
    )
    expect(error.code).toBe('password.reused')
  })
})

describe('whose history it is', () => {
  test('another user’s old password is accepted', async () => {
    history(5)
    const maya = await createUser()
    const noor = await createUser(tenant, 'noor@northline.app')
    await change(maya.id, 1, 2)
    await change(maya.id, 2, 3)
    // Noor has only ever had P(1); Maya's 2 and 3 are nothing to her.
    await change(noor.id, 1, 2)
    await change(noor.id, 2, 3)
    expect(await remembered(noor.id, 3)).toEqual([3, 2, 1])
  })

  test('the same address in another environment has a history of its own', async () => {
    history(5)
    const here = await createUser()
    const there = await createUser(otherTenant)
    await change(here.id, 1, 2)
    await change(there.id, 1, 2, otherTenant)
    // Each has had 1 and 2; neither is refused the other's.
    await change(here.id, 2, 3)
    expectReused(await rejection(change(there.id, 2, 1, otherTenant)), 5)
    expect(await remembered(there.id, 3, otherTenant)).toEqual([2, 1])
  })

  test('each environment applies its own number', async () => {
    const state = await Settings.get(deps, otherTenant, true)
    await Settings.replace(
      deps,
      otherTenant,
      {
        expectedRevision: state.revision,
        settings: {
          ...state.settings,
          password: { ...state.settings.password, preset: 'custom', history: 2 },
        },
      },
      TEST_ACTOR
    )
    const here = await createUser()
    const there = await createUser(otherTenant)
    // Zero here: the current password is accepted as the new one.
    await change(here.id, 1, 1)
    expectReused(await rejection(change(there.id, 1, 1, otherTenant)), 2)
  })
})

describe('a refused or failed change changes nothing', () => {
  test('a reused password leaves the password, the history, the sessions and the log alone', async () => {
    history(3)
    const user = await createUser()
    await change(user.id, 1, 2)
    await Notices.settled()
    const before = await stored(user.id)
    const entries = (await auditOf(user.id)).length
    const mails = deps.mailer.outbox.length
    const { sessionId: otherSession } = await signIn(user.id)
    const beforeEntries = (await auditOf(user.id)).length
    expect(beforeEntries).toBeGreaterThanOrEqual(entries)

    expectReused(await rejection(change(user.id, 2, 1)), 3)
    expectReused(await rejection(reset(user.id, 2)), 3)
    await Notices.settled()

    expect(await stored(user.id)).toEqual(before)
    // No session ended, nothing was announced, and a refusal is not recorded.
    expect((await deps.sessions.findById(tenant.environmentId, otherSession))?.revokedAt).toBeNull()
    expect(deps.mailer.outbox).toHaveLength(mails)
    expect(
      (await auditOf(user.id)).filter((entry) => entry.type === 'user.password_changed')
    ).toHaveLength(1)
  })

  test('a reset whose password is reused does not spend its proof', async () => {
    history(2)
    const user = await createUser()
    let claimed = 0
    const claim = async () => {
      claimed += 1
    }
    expectReused(await rejection(reset(user.id, 1, claim)), 2)
    expect(claimed).toBe(0)
    await reset(user.id, 2, claim)
    expect(claimed).toBe(1)
    expect(await remembered(user.id, 2)).toEqual([2, 1])
  })

  test('a store that fails leaves the password and the history as they were', async () => {
    history(3)
    const user = await createUser()
    await change(user.id, 1, 2)
    const before = await stored(user.id)
    const write = spyOn(deps.users, 'setPasswordHash').mockRejectedValue(new Error('down'))
    await expect(change(user.id, 2, 3)).rejects.toThrow('down')
    write.mockRestore()
    expect(await stored(user.id)).toEqual(before)
  })
})

describe('the paths that store a password', () => {
  test('a reset is compared, and recorded in the history', async () => {
    history(3)
    const user = await createUser()
    expectReused(await rejection(reset(user.id, 1)), 3)
    await reset(user.id, 2)
    expectReused(await rejection(reset(user.id, 1)), 3)
    expect(await remembered(user.id, 2)).toEqual([2, 1])
  })

  test('an account an administrator made cannot be reset to the password it was given', async () => {
    history(1)
    // "Sign-up after an admin create": the owner's first own password, set by a reset.
    const user = await Users.create(deps, tenant, { email: EMAIL, password: P(1) }, TEST_ACTOR)
    expectReused(await rejection(reset(user.id, 1)), 1)
    await reset(user.id, 2)
  })

  test('an administrator’s password is never refused, and is kept in the history', async () => {
    history(3)
    const user = await createUser()
    await change(user.id, 1, 2)
    const counted = spyOn(deps.rateLimiter, 'hit')
    const read = spyOn(deps.users, 'storedPasswords')
    // One of the user's last three, and their current one: an administrator is told nothing.
    await Users.setPassword(deps, tenant, user.id, P(1), TEST_ACTOR)
    await Users.setPassword(deps, tenant, user.id, P(1), TEST_ACTOR)
    expect(read).not.toHaveBeenCalled()
    expect(counted.mock.calls.filter(([key]) => key.startsWith('password_history'))).toEqual([])
    read.mockRestore()
    counted.mockRestore()
    // What they replaced is remembered: 2, then the first of the two 1s.
    expect(await remembered(user.id, 2)).toEqual([1, 1, 2])
    // So the user cannot go back to what the administrator replaced.
    expectReused(await rejection(change(user.id, 1, 2)), 3)
  })

  test('a first password on an account that has none is compared with nothing', async () => {
    history(5)
    const user = await Users.create(deps, tenant, { email: EMAIL, emailVerified: true }, TEST_ACTOR)
    const counted = spyOn(deps.rateLimiter, 'hit')
    const verify = spyOn(Bun.password, 'verify')
    await reset(user.id, 1)
    expect(verify).not.toHaveBeenCalled()
    expect(counted.mock.calls.filter(([key]) => key.startsWith('password_history'))).toEqual([])
    verify.mockRestore()
    counted.mockRestore()
    expect(await stored(user.id)).toEqual({ current: expect.any(String), previous: [] })
    // From then on it has a history like any other.
    expectReused(await rejection(reset(user.id, 1)), 5)
  })

  test('a hash upgrade at sign-in adds nothing, and the password is still the current one', async () => {
    history(3)
    const user = await createUser()
    await change(user.id, 1, 2)
    const { current, previous } = await stored(user.id)
    const upgraded = await Passwords.hash(P(2))
    expect(
      await deps.users.upgradePasswordHash(
        tenant.environmentId,
        user.id,
        current ?? '',
        upgraded,
        deps.clock.now()
      )
    ).toBe(true)
    expect(await stored(user.id)).toEqual({ current: upgraded, previous })
    expectReused(await rejection(change(user.id, 2, 2)), 3)
    // One step on, the upgraded password is there once, not twice.
    await change(user.id, 2, 3)
    expect(await remembered(user.id, 3)).toEqual([3, 2, 1])
  })

  test('the passwords of an unproven address go with the password a stranger chose', async () => {
    history(5)
    // An administrator (or anyone with a key) made the account and set passwords on it.
    const user = await Users.create(deps, tenant, { email: EMAIL, password: P(1) }, TEST_ACTOR)
    await Users.setPassword(deps, tenant, user.id, P(2), TEST_ACTOR)
    expect(await remembered(user.id, 2)).toEqual([2, 1])
    // The owner proves the address without proving the password (ADR 0024).
    const actor = { type: 'user', id: user.id, ipAddress: null, userAgent: null } as const
    const target = { type: 'user', id: user.id } as const
    expect(
      await deps.users.markEmailVerified(
        tenant.environmentId,
        user.id,
        deps.clock.now(),
        Audit.entry(deps, tenant, { type: 'user.email_verified', actor, target }),
        {
          activity: Audit.entry(deps, tenant, {
            type: 'user.password_changed',
            actor,
            target,
            data: { method: 'email_verification', removed: true },
          }),
        }
      )
    ).toEqual({ passwordRemoved: true })
    expect(await stored(user.id)).toEqual({ current: null, previous: [] })
    // Either of the stranger's passwords is the owner's to choose.
    await reset(user.id, 2)
    await reset(user.id, 1)
    expect(await remembered(user.id, 2)).toEqual([1, 2])
  })

  test('deleting the user deletes what was kept', async () => {
    history(5)
    const user = await createUser()
    await change(user.id, 1, 2)
    await Users.remove(deps, tenant, user.id, TEST_ACTOR)
    expect(await stored(user.id)).toEqual({ current: null, previous: [] })
    expect(await deps.users.deletePasswordHistoryBeyond(tenant.environmentId, 0, 100)).toBe(0)
  })
})

describe('a changed policy', () => {
  test('a lowered number deletes the surplus at the user’s next change', async () => {
    history(5)
    const user = await createUser()
    await change(user.id, 1, 2)
    await change(user.id, 2, 3)
    await change(user.id, 3, 4)
    expect((await stored(user.id)).previous).toHaveLength(3)
    history(2)
    // Only the current and the one before it count now.
    await change(user.id, 4, 1)
    expect(await remembered(user.id, 4)).toEqual([1, 4])
  })

  test('zero deletes everything that was kept, and a raised number brings nothing back', async () => {
    history(5)
    const user = await createUser()
    await change(user.id, 1, 2)
    await change(user.id, 2, 3)
    history(0)
    await change(user.id, 3, 4)
    expect((await stored(user.id)).previous).toEqual([])
    history(5)
    // 1, 2 and 3 were not kept: only the current one is known.
    await change(user.id, 4, 1)
    expect(await remembered(user.id, 4)).toEqual([1, 4])
  })
})

describe('the cost of the comparison, and who can cause it', () => {
  async function withFour(): Promise<string> {
    history(4)
    const user = await createUser()
    await change(user.id, 1, 2)
    await change(user.id, 2, 3)
    await change(user.id, 3, 4)
    return user.id
  }

  test.each([
    ['the current password', 4],
    ['the oldest one kept', 1],
    ['none of them', 9],
  ])('every stored hash is verified when the candidate is %s', async (_name, candidate) => {
    const userId = await withFour()
    const { sessionId } = await signIn(userId)
    const hashes = await stored(userId)
    const verify = spyOn(Bun.password, 'verify')
    await Users.changePassword(
      deps,
      tenant,
      { userId, sessionId },
      { currentPassword: P(4), newPassword: P(candidate) }
    ).catch(() => undefined)
    const verified = verify.mock.calls.map(([, hash]) => hash)
    verify.mockRestore()
    // The current password's proof first, then all four, one after another, in order: no
    // early exit, whichever one matched.
    expect(verified).toEqual([
      hashes.current,
      hashes.current,
      ...hashes.previous,
    ] as typeof verified)
  })

  test('a wrong current password never reaches the comparison', async () => {
    const userId = await withFour()
    const { sessionId } = await signIn(userId)
    const read = spyOn(deps.users, 'storedPasswords')
    const error = await rejection(
      Users.changePassword(
        deps,
        tenant,
        { userId, sessionId },
        { currentPassword: 'not the password at all', newPassword: P(2) }
      )
    )
    expect(error.code).toBe('auth.invalid_credentials')
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  test('a password the policy or the breach check refuses is never compared', async () => {
    const userId = await withFour()
    const { sessionId } = await signIn(userId)
    const read = spyOn(deps.users, 'storedPasswords')
    const attempt = (newPassword: string) =>
      rejection(
        Users.changePassword(
          deps,
          tenant,
          { userId, sessionId },
          { currentPassword: P(4), newPassword }
        )
      )
    expect((await attempt('short')).code).toBe('password.too_short')
    const breached = spyOn(deps.breachChecker, 'check').mockResolvedValue('breached')
    // Reused as well: the breach answer comes first, and the history is not consulted.
    expect((await attempt(P(3))).code).toBe('password.breached')
    breached.mockRestore()
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
  })

  test('one user’s comparisons are counted, by id, and refused past the hourly allowance', async () => {
    history(1)
    const user = await createUser()
    const other = await createUser(tenant, 'noor@northline.app')
    const counted = spyOn(deps.rateLimiter, 'hit')
    for (let n = 0; n < Passwords.PASSWORD_HISTORY_CHECKS_PER_HOUR; n++) {
      expectReused(await rejection(reset(user.id, 1)), 1)
    }
    const keys = counted.mock.calls.map(([key]) => key).filter((key) => key.includes('history'))
    counted.mockRestore()
    expect(new Set(keys)).toEqual(new Set([`password_history:${tenant.environmentId}:${user.id}`]))
    const verify = spyOn(Bun.password, 'verify')
    let claimed = false
    const limited = await rejection(
      reset(user.id, 2, async () => {
        claimed = true
      })
    )
    expect(limited.code).toBe('rate_limited')
    // Refused before any hash was verified, and before the proof was spent.
    expect(verify).not.toHaveBeenCalled()
    verify.mockRestore()
    expect(claimed).toBe(false)
    // Another user is not held back by it, and an hour later nor is this one.
    await reset(other.id, 2)
    deps.clock.advance('1h')
    await reset(user.id, 2)
  })

  test('a limiter that cannot count refuses the change', async () => {
    history(2)
    const user = await createUser()
    const before = await stored(user.id)
    const down = spyOn(deps.rateLimiter, 'hit').mockRejectedValue(new Error('limiter down'))
    await expect(reset(user.id, 2)).rejects.toThrow('limiter down')
    down.mockRestore()
    expect(await stored(user.id)).toEqual(before)
  })
})

describe('a password that moved while it was being compared', () => {
  test('is compared again with what is stored, once more and not counted twice', async () => {
    history(3)
    const user = await createUser()
    const write = deps.users.setPasswordHash.bind(deps.users)
    let raced = false
    const store = spyOn(deps.users, 'setPasswordHash').mockImplementation(async (...args) => {
      if (!raced) {
        raced = true
        // Another change of the same user lands between the comparison and this write.
        await write(
          tenant.environmentId,
          user.id,
          await Passwords.hash(P(5)),
          deps.clock.now(),
          Audit.none('fixture'),
          { keep: 2 }
        )
      }
      return write(...args)
    })
    const counted = spyOn(deps.rateLimiter, 'hit')
    let claims = 0
    await reset(user.id, 2, async () => {
      claims += 1
    })
    expect(store).toHaveBeenCalledTimes(2)
    expect(claims).toBe(1)
    expect(counted.mock.calls.filter(([key]) => key.startsWith('password_history'))).toHaveLength(1)
    store.mockRestore()
    counted.mockRestore()
    expect(await remembered(user.id, 5)).toEqual([2, 5, 1])
  })

  test('is refused when what landed meanwhile is the same password', async () => {
    history(3)
    const user = await createUser()
    const write = deps.users.setPasswordHash.bind(deps.users)
    let raced = false
    const store = spyOn(deps.users, 'setPasswordHash').mockImplementation(async (...args) => {
      if (!raced) {
        raced = true
        await write(
          tenant.environmentId,
          user.id,
          await Passwords.hash(P(2)),
          deps.clock.now(),
          Audit.none('fixture'),
          { keep: 2 }
        )
      }
      return write(...args)
    })
    await signIn(user.id)
    let claims = 0
    expectReused(
      await rejection(
        reset(user.id, 2, async () => {
          claims += 1
        })
      ),
      3
    )
    store.mockRestore()
    // Stored once, by the change that won: never twice.
    expect(await remembered(user.id, 2)).toEqual([2, 1])
    // The proof was spent and the sessions ended before the first write, and neither is given
    // back when the second comparison refuses (ADR 0038, "Two changes at once"): pinned.
    expect(claims).toBe(1)
    expect(await liveSessions(user.id)).toEqual([])
  })

  test('that never holds still is given up on, with nothing stored', async () => {
    history(3)
    const user = await createUser()
    const before = await stored(user.id)
    await signIn(user.id)
    let claims = 0
    const store = spyOn(deps.users, 'setPasswordHash').mockResolvedValue('stale')
    const read = spyOn(deps.users, 'storedPasswords')
    const error = await rejection(
      reset(user.id, 2, async () => {
        claims += 1
      })
    )
    expect(error.code).toBe('service.unavailable')
    expect(error.status).toBe(503)
    // Three writes tried, each on a comparison of its own.
    expect(store).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenCalledTimes(3)
    store.mockRestore()
    read.mockRestore()
    await Notices.settled()
    expect(await stored(user.id)).toEqual(before)
    expect(deps.mailer.outbox).toEqual([])
    // Given up on after the proof was spent and the sessions ended, once each: pinned.
    expect(claims).toBe(1)
    expect(await liveSessions(user.id)).toEqual([])
  })
})

describe('a reset proves the inbox and nothing more', () => {
  const web: Flows.ClientContext = {
    client: 'web',
    userAgent: 'Mozilla/5.0',
    ipAddress: '203.0.113.7',
    originAllowed: true,
  }

  /** The 6-digit code in the most recent email whose subject leads with one. */
  function sentCode(): string {
    const message = deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))
    const code = message ? /^(\d{6}) /.exec(message.subject)?.[1] : undefined
    if (!code) {
      throw new Error('no code was emailed')
    }
    return code
  }

  // The password of a reset is stored before the second factor is asked for (the factor gates
  // the session, not the reset), so the comparison is reached with the emailed code alone.
  // Accepted and said in ADR 0038: whoever holds only the inbox of an account with a second
  // factor can learn that a candidate is one of its last N passwords.
  test('for a user with an authenticator, the emailed code alone gets `password.reused`, and the code is not spent', async () => {
    history(3)
    const user = await createUser()
    await change(user.id, 1, 2)
    const { secret } = await Mfa.startTotp(deps, tenant, user.id)
    await Mfa.confirmTotp(
      deps,
      tenant,
      { userId: user.id },
      totp(base32Decode(secret), deps.clock.now()),
      { type: 'user', id: user.id, ipAddress: null, userAgent: null }
    )
    await Notices.settled()

    const { attempt } = await Flows.startPasswordReset(deps, tenant, { email: EMAIL }, web)
    const ref = { id: attempt.id, secret: attempt.attemptSecret }
    const code = sentCode()
    const submit = (to: number) =>
      Flows.resetPassword(deps, tenant, ref, { code, password: P(to) }, web)

    // No second factor was proven, or even asked for.
    expectReused(await rejection(submit(1)), 3)
    expectReused(await rejection(submit(2)), 3)
    expect(await remembered(user.id, 3)).toEqual([2, 1])
    expect((await deps.flowAttempts.findById(tenant.environmentId, attempt.id))?.status).toBe(
      'needs_new_password'
    )

    // The code is unspent: the same one stores a password the user never had, still without
    // the factor. That password is stored for real, and only the session waits for the factor.
    const waiting = await submit(3)
    expect(waiting.attempt.step.status).toBe('needs_second_factor')
    expect(waiting.tokens).toBeUndefined()
    expect(await remembered(user.id, 3)).toEqual([3, 2, 1])
    expect(await liveSessions(user.id)).toEqual([])
  })
})

describe('nothing of the history leaves', () => {
  test('no hash, count or position in the error, the audit log, an email or a log line', async () => {
    history(4)
    const lines: string[] = []
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level).mockImplementation((message: string, fields?: unknown) => {
        lines.push(`${message} ${JSON.stringify(fields ?? {})}`)
      })
    )
    const user = await createUser()
    await change(user.id, 1, 2)
    await change(user.id, 2, 3)
    const error = await rejection(change(user.id, 3, 1))
    await Notices.settled()
    for (const spy of spies) {
      spy.mockRestore()
    }
    const { current, previous } = await stored(user.id)
    const leaked = [
      JSON.stringify(error.toJSON()),
      error.internalMessage ?? '',
      JSON.stringify(await auditOf(user.id)),
      JSON.stringify(deps.mailer.outbox),
      lines.join('\n'),
    ].join('\n')
    for (const hash of [current ?? '', ...previous]) {
      expect(hash.startsWith('$argon2id$')).toBe(true)
      expect(leaked).not.toContain(hash)
      // Nor the part of a hash that is the password's digest.
      expect(leaked).not.toContain(hash.split('$').at(-1) ?? hash)
    }
    expect(leaked).not.toContain('argon2')
    // The error says the policy's number and nothing about which entry matched.
    expect(Object.keys(error.params ?? {})).toEqual(['history'])
  })
})
