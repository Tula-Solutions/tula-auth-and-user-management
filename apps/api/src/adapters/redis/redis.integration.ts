import { afterAll, describe, expect, test } from 'bun:test'
import { describeLockout, SUITE_LOCKOUT_POLICY } from '~/adapters/lockout.suite'
import { FixedClock } from '~/adapters/memory/clock'
import { describeProofReplayGuard } from '~/adapters/proof-replay.suite'
import { describeRateLimiter } from '~/adapters/rate-limiter.suite'
import { CLOCK_SKEW_ALLOWANCE_MS } from '~/adapters/redis/commands'
import { connectRedis, redisProbe } from '~/adapters/redis/connection'
import { RedisLockout } from '~/adapters/redis/lockout'
import { RedisProofReplayGuard } from '~/adapters/redis/proof-replay'
import { RedisRateLimiter } from '~/adapters/redis/rate-limiter'
import { RedisRevokedSessions } from '~/adapters/redis/revoked-sessions'
import { RedisSigningKeyVersions } from '~/adapters/redis/signing-key-versions'
import { describeRevokedSessions } from '~/adapters/revoked-sessions.suite'
import { systemClock } from '~/adapters/system/clock'
import { ServiceUnavailableError } from '~/exceptions'
import { createKeyedHash } from '~/lib/keyed-hash'
import { TEST_MASTER_KEY } from '~/testing'

/**
 * The Redis adapters against a real server: the run that proves the Lua scripts, which the
 * in-memory fake used by unit tests can only imitate.
 *
 * Uses the Redis of `docker compose up -d` unless `REDIS_TEST_URL` says otherwise. Every key is
 * written under a namespace of this run's own and deleted afterwards.
 */
const url = process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379'
const namespace = `tula-test-${crypto.randomUUID()}`
const keyedHash = createKeyedHash(TEST_MASTER_KEY)

// Two connections: two API instances sharing one Redis.
const first = connectRedis(url, systemClock)
const second = connectRedis(url, systemClock)

const reachable = await Promise.all([first.send('PING', []), second.send('PING', [])]).then(
  () => true,
  () => false
)

if (!reachable) {
  // The host only: a URL can carry a password.
  const message = `Redis is not reachable at ${new URL(url).host}. Start it with \`docker compose up -d redis\` or set REDIS_TEST_URL.`
  if (process.env.CI) {
    // In CI a skipped run would leave the Lua scripts unproved without anyone noticing.
    throw new Error(message)
  }
  // Said on stderr as well: the test report does not print the names of skipped tests.
  process.stderr.write(`SKIPPED: ${message}\n`)
  test.skip(`SKIPPED: ${message}`, () => {})
} else {
  afterAll(async () => {
    const keys = (await first.send('KEYS', [`${namespace}:*`])) as string[]
    if (keys.length > 0) {
      await first.send('DEL', keys)
    }
    first.close()
    second.close()
  })

  describeRateLimiter('redis', async () => {
    const clock = new FixedClock()
    return {
      clock,
      limiter: new RedisRateLimiter(first, clock, keyedHash, namespace),
      peer: new RedisRateLimiter(second, clock, keyedHash, namespace),
    }
  })

  describeLockout('redis', async () => {
    const clock = new FixedClock()
    return {
      clock,
      lockout: new RedisLockout(first, namespace),
      peer: new RedisLockout(second, namespace),
    }
  })

  describeRevokedSessions('redis', async () => {
    const clock = new FixedClock()
    return {
      clock,
      list: new RedisRevokedSessions(first, clock, namespace),
      peer: new RedisRevokedSessions(second, clock, namespace),
    }
  })

  describeProofReplayGuard('redis', async () => {
    const clock = new FixedClock()
    return {
      clock,
      guard: new RedisProofReplayGuard(first, clock, namespace),
      peer: new RedisProofReplayGuard(second, clock, namespace),
      allowanceMs: CLOCK_SKEW_ALLOWANCE_MS,
      // A real server forgets by its own clock, not the test's.
      movesTime: false,
    }
  })

  describe('redis: the proof replay guard', () => {
    test('its key expires on its own, a little after the proof could last be accepted', async () => {
      const clock = new FixedClock()
      const id = crypto.randomUUID()
      await new RedisProofReplayGuard(first, clock, namespace).remember(
        id,
        new Date(clock.now().getTime() + 60_000)
      )
      const ttl = (await first.send('PTTL', [`${namespace}:dp:${id}`])) as number
      expect(ttl).toBeGreaterThan(60_000)
      expect(ttl).toBeLessThanOrEqual(60_000 + CLOCK_SKEW_ALLOWANCE_MS)
    })

    test('a key the server has dropped is new again', async () => {
      const clock = new FixedClock()
      const id = crypto.randomUUID()
      const guard = new RedisProofReplayGuard(first, clock, namespace)
      expect(await guard.remember(id, clock.now())).toBe(true)
      await first.send('DEL', [`${namespace}:dp:${id}`])
      expect(await guard.remember(id, clock.now())).toBe(true)
    })
  })

  describe('redis: what the scripts leave behind', () => {
    test('every key carries an expiry, so nothing needs sweeping', async () => {
      const clock = new FixedClock()
      const id = crypto.randomUUID()
      await new RedisRateLimiter(first, clock, keyedHash, namespace).hit(`ip:${id}`, 5, 60_000)
      await new RedisLockout(first, namespace).attempt(id, SUITE_LOCKOUT_POLICY, clock.now())
      await new RedisRevokedSessions(first, clock, namespace).add(
        id,
        new Date(clock.now().getTime() + 60_000)
      )
      const keys = ((await first.send('KEYS', [`${namespace}:*`])) as string[]).filter(
        (key) => key.endsWith(id) || key.includes(':rl:')
      )
      expect(keys.length).toBeGreaterThanOrEqual(3)
      for (const key of keys) {
        const ttl = (await first.send('PTTL', [key])) as number
        expect(ttl).toBeGreaterThan(0)
        expect(ttl).toBeLessThanOrEqual(60_000 + CLOCK_SKEW_ALLOWANCE_MS)
        expect(key).not.toContain('ip:')
      }
    })

    test('the signing-key marker written by one instance is read by the other', async () => {
      const environmentId = crypto.randomUUID()
      const mine = new RedisSigningKeyVersions(first, namespace)
      const theirs = new RedisSigningKeyVersions(second, namespace)
      expect(await theirs.current(environmentId)).toBeNull()
      await mine.bump(environmentId)
      const marker = await theirs.current(environmentId)
      expect(marker).toMatch(/^[0-9a-f-]{36}$/)
      await theirs.bump(environmentId)
      expect(await mine.current(environmentId)).not.toBe(marker)
    })

    test('the readiness probe passes', async () => {
      await redisProbe(first).check()
    })
  })

  describe('redis: a server that cannot be reached', () => {
    // Nothing listens on port 1, so the real client is refused.
    const down = connectRedis('redis://127.0.0.1:1', systemClock)
    const clock = new FixedClock()

    afterAll(() => {
      down.close()
    })

    test('every adapter refuses with service.unavailable instead of deciding', async () => {
      const attempts: (() => Promise<unknown>)[] = [
        () => new RedisRateLimiter(down, clock, keyedHash, namespace).hit('k', 5, 60_000),
        () => new RedisLockout(down, namespace).attempt('k', SUITE_LOCKOUT_POLICY, clock.now()),
        () => new RedisLockout(down, namespace).clear('k'),
        () => new RedisRevokedSessions(down, clock, namespace).has('s1', clock.now()),
        () => new RedisRevokedSessions(down, clock, namespace).add('s1', clock.now()),
        () => new RedisSigningKeyVersions(down, namespace).current('e1'),
        () => new RedisProofReplayGuard(down, clock, namespace).remember('p1', clock.now()),
      ]
      for (const attempt of attempts) {
        const error = await attempt().then(
          () => null,
          (thrown: unknown) => thrown
        )
        expect(error).toBeInstanceOf(ServiceUnavailableError)
        expect((error as ServiceUnavailableError).internalMessage).toMatch(
          /^redis [A-Z]+ failed: Redis[A-Za-z]+( ERR_[A-Z_]+)?$/
        )
      }
    })

    test('the readiness probe fails promptly', async () => {
      const started = performance.now()
      await expect(redisProbe(down).check()).rejects.toThrow()
      expect(performance.now() - started).toBeLessThan(1_500)
    })
  })
}
