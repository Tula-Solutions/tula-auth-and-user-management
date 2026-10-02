import { beforeEach, describe, expect, test } from 'bun:test'
import type { NewVerificationToken, VerificationTokenStore } from '~/ports/verification-token-store'

/** A tenant plus rows the store's foreign keys need. */
export interface SuiteTenant {
  projectId: string
  environmentId: string
  /** Create a flow attempt (a real row for Postgres) and return its id. */
  flowAttempt: () => Promise<string>
  /** Create a user and return its id. */
  user: () => Promise<string>
}

/** What a store under test provides. */
export interface SuiteContext {
  store: VerificationTokenStore
  a: SuiteTenant
  b: SuiteTenant
}

/**
 * Behaviour every `VerificationTokenStore` must have. Run against each adapter so the memory
 * store used by unit tests can't drift from Postgres.
 *
 * @param name - Adapter name for the report.
 * @param setup - Builds a fresh context; called before each test.
 */
export function describeVerificationTokenStore(
  name: string,
  setup: () => Promise<SuiteContext>
): void {
  describe(`${name} (VerificationTokenStore)`, () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const later = (ms: number) => new Date(now.getTime() + ms)
    let ctx: SuiteContext
    let counter = 0

    beforeEach(async () => {
      ctx = await setup()
    })

    function token(
      tenant: SuiteTenant,
      overrides: Partial<NewVerificationToken> = {}
    ): NewVerificationToken {
      counter += 1
      return {
        id: Bun.randomUUIDv7(),
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        userId: null,
        flowAttemptId: null,
        purpose: 'email_verification',
        destination: 'maya@northline.app',
        codeHash: `code-hash-${counter}`,
        linkTokenHash: null,
        maxAttempts: 3,
        expiresAt: later(600_000),
        createdAt: later(counter),
        ...overrides,
      }
    }

    test('stores a token and finds it by flow attempt with zeroed counters', async () => {
      const flowAttemptId = await ctx.a.flowAttempt()
      const input = token(ctx.a, { flowAttemptId })
      await ctx.store.replace(input, now)
      const found = await ctx.store.findLatest(ctx.a.environmentId, 'email_verification', {
        flowAttemptId,
      })
      expect(found).toEqual({ ...input, attempts: 0, consumedAt: null })
    })

    test('finds a token by user when it has no flow attempt', async () => {
      const userId = await ctx.a.user()
      const input = token(ctx.a, { userId, purpose: 'password_reset' })
      await ctx.store.replace(input, now)
      expect(
        (await ctx.store.findLatest(ctx.a.environmentId, 'password_reset', { userId }))?.id
      ).toBe(input.id)
      expect(
        await ctx.store.findLatest(ctx.a.environmentId, 'email_verification', { userId })
      ).toBeNull()
    })

    test('a new token consumes earlier ones for the same subject and purpose only', async () => {
      const flowAttemptId = await ctx.a.flowAttempt()
      const otherFlow = await ctx.a.flowAttempt()
      const first = token(ctx.a, { flowAttemptId, linkTokenHash: 'link-first' })
      const bystander = token(ctx.a, { flowAttemptId: otherFlow, linkTokenHash: 'link-other' })
      const second = token(ctx.a, { flowAttemptId })
      await ctx.store.replace(first, now)
      await ctx.store.replace(bystander, now)
      await ctx.store.replace(second, later(1_000))

      expect(
        (await ctx.store.findLatest(ctx.a.environmentId, 'email_verification', { flowAttemptId }))
          ?.id
      ).toBe(second.id)
      expect(
        (await ctx.store.findByLinkHash(ctx.a.environmentId, 'link-first'))?.consumedAt
      ).toEqual(later(1_000))
      expect(
        (await ctx.store.findByLinkHash(ctx.a.environmentId, 'link-other'))?.consumedAt
      ).toBeNull()
      expect(await ctx.store.consume(ctx.a.environmentId, first.id, later(2_000))).toBe(false)
    })

    test('counts attempts up to the maximum and never past it, even concurrently', async () => {
      const flowAttemptId = await ctx.a.flowAttempt()
      const input = token(ctx.a, { flowAttemptId })
      await ctx.store.replace(input, now)
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          ctx.store.recordAttempt(ctx.a.environmentId, input.id, later(1))
        )
      )
      const counted = results.filter((result) => result !== null)
      expect(counted.map((result) => result?.attempts).sort()).toEqual([1, 2, 3])
      expect(
        (await ctx.store.findLatest(ctx.a.environmentId, 'email_verification', { flowAttemptId }))
          ?.attempts
      ).toBe(3)
    })

    test('consume is single-use', async () => {
      const flowAttemptId = await ctx.a.flowAttempt()
      const input = token(ctx.a, { flowAttemptId })
      await ctx.store.replace(input, now)
      const results = await Promise.all([
        ctx.store.consume(ctx.a.environmentId, input.id, later(5)),
        ctx.store.consume(ctx.a.environmentId, input.id, later(5)),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(await ctx.store.recordAttempt(ctx.a.environmentId, input.id, later(6))).toBeNull()
    })

    test('an expired token can be neither attempted nor consumed', async () => {
      const flowAttemptId = await ctx.a.flowAttempt()
      const input = token(ctx.a, { flowAttemptId, expiresAt: later(1_000) })
      await ctx.store.replace(input, now)
      expect(await ctx.store.recordAttempt(ctx.a.environmentId, input.id, later(1_000))).toBeNull()
      expect(await ctx.store.consume(ctx.a.environmentId, input.id, later(1_000))).toBe(false)
      expect(await ctx.store.consume(ctx.a.environmentId, input.id, later(999))).toBe(true)
    })

    test('one environment cannot read, attempt or consume another’s tokens', async () => {
      const flowAttemptId = await ctx.a.flowAttempt()
      const input = token(ctx.a, { flowAttemptId, linkTokenHash: 'link-tenant-a' })
      await ctx.store.replace(input, now)
      const foreign = ctx.b.environmentId
      expect(
        await ctx.store.findLatest(foreign, 'email_verification', { flowAttemptId })
      ).toBeNull()
      expect(await ctx.store.findByLinkHash(foreign, 'link-tenant-a')).toBeNull()
      expect(await ctx.store.recordAttempt(foreign, input.id, later(1))).toBeNull()
      expect(await ctx.store.consume(foreign, input.id, later(1))).toBe(false)
      expect(await ctx.store.consume(ctx.a.environmentId, input.id, later(1))).toBe(true)
    })

    test('an unknown link hash finds nothing', async () => {
      expect(await ctx.store.findByLinkHash(ctx.a.environmentId, 'nope')).toBeNull()
    })
  })
}
