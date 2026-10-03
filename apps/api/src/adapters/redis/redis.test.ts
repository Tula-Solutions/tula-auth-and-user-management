import { describe, expect, test } from 'bun:test'
import { describeLockout, SUITE_LOCKOUT_POLICY } from '~/adapters/lockout.suite'
import { FixedClock } from '~/adapters/memory/clock'
import { describeRateLimiter } from '~/adapters/rate-limiter.suite'
import {
  CLOCK_SKEW_ALLOWANCE_MS,
  call,
  evalScript,
  integers,
  type RedisCommands,
  redisErrorReason,
} from '~/adapters/redis/commands'
import { FakeRedis } from '~/adapters/redis/fake'
import { lockoutSchedule, RedisLockout } from '~/adapters/redis/lockout'
import { RedisRateLimiter } from '~/adapters/redis/rate-limiter'
import { RedisRevokedSessions } from '~/adapters/redis/revoked-sessions'
import { RedisSigningKeyVersions } from '~/adapters/redis/signing-key-versions'
import { describeRevokedSessions } from '~/adapters/revoked-sessions.suite'
import { ServiceUnavailableError } from '~/exceptions'
import { createKeyedHash } from '~/lib/keyed-hash'
import { CREDENTIAL_LOCKOUT } from '~/ports/lockout'
import { TEST_MASTER_KEY } from '~/testing'

const keyedHash = createKeyedHash(TEST_MASTER_KEY)

/** Two adapters of each kind over one fake server: two API instances sharing one Redis. */
function setup() {
  const clock = new FixedClock()
  const redis = new FakeRedis(clock)
  return {
    clock,
    redis,
    limiter: new RedisRateLimiter(redis, clock, keyedHash),
    lockout: new RedisLockout(redis),
    list: new RedisRevokedSessions(redis, clock),
    versions: new RedisSigningKeyVersions(redis),
  }
}

/** A client whose every reply is `reply`, for replies a healthy server never sends. */
function replying(reply: unknown): RedisCommands {
  return { send: async () => reply }
}

async function refusal(work: Promise<unknown>): Promise<ServiceUnavailableError> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(ServiceUnavailableError)
  return error as ServiceUnavailableError
}

describeRateLimiter('redis (fake server)', async () => {
  const { clock, redis, limiter } = setup()
  return { clock, limiter, peer: new RedisRateLimiter(redis, clock, keyedHash) }
})

describeLockout('redis (fake server)', async () => {
  const { clock, redis, lockout } = setup()
  return { clock, lockout, peer: new RedisLockout(redis) }
})

describeRevokedSessions('redis (fake server)', async () => {
  const { clock, redis, list } = setup()
  return { clock, list, peer: new RedisRevokedSessions(redis, clock) }
})

describe('when Redis is unreachable', () => {
  test('the rate limiter refuses instead of allowing', async () => {
    const { redis, limiter } = setup()
    await limiter.hit('sign_in:ip:203.0.113.7', 5, 60_000)
    redis.fail()
    const error = await refusal(limiter.hit('sign_in:ip:203.0.113.7', 5, 60_000))
    expect(error.toJSON()).toEqual({
      status: 503,
      code: 'service.unavailable',
      detail: 'The service is temporarily unavailable. Try again shortly.',
    })
    expect(error.internalMessage).toBe('redis EVAL failed: RedisError ERR_REDIS_CONNECTION_CLOSED')
    expect(error.cause).toBeUndefined()
  })

  test('the lockout refuses the attempt and the clear', async () => {
    const { clock, redis, lockout } = setup()
    redis.fail()
    await refusal(lockout.attempt('sign_in:e1:abc', CREDENTIAL_LOCKOUT, clock.now()))
    expect((await refusal(lockout.clear('sign_in:e1:abc'))).internalMessage).toBe(
      'redis DEL failed: RedisError ERR_REDIS_CONNECTION_CLOSED'
    )
  })

  test('attempts refused during an outage were not counted', async () => {
    const { clock, redis, lockout } = setup()
    redis.fail()
    for (let i = 0; i < 20; i++) {
      await refusal(lockout.attempt('k', SUITE_LOCKOUT_POLICY, clock.now()))
    }
    redis.recover()
    for (let i = 0; i < 4; i++) {
      expect((await lockout.attempt('k', SUITE_LOCKOUT_POLICY, clock.now())).allowed).toBe(true)
    }
    expect((await lockout.attempt('k', SUITE_LOCKOUT_POLICY, clock.now())).allowed).toBe(false)
  })

  test('the revoked-session list cannot say a session is fine', async () => {
    const { clock, redis, list } = setup()
    const until = new Date(clock.now().getTime() + 60_000)
    await list.add('s1', until)
    redis.fail()
    await refusal(list.has('s1', clock.now()))
    await refusal(list.has('never-revoked', clock.now()))
    await refusal(list.add('s2', until))
    redis.recover()
    expect(await list.has('s1', clock.now())).toBe(true)
    expect(await list.has('s2', clock.now())).toBe(false)
  })

  test('the signing-key marker can be neither read nor replaced', async () => {
    const { redis, versions } = setup()
    redis.fail()
    await refusal(versions.current('e1'))
    await refusal(versions.bump('e1'))
  })

  test('the reason never includes the client’s message', async () => {
    const { redis, limiter } = setup()
    redis.fail(
      Object.assign(new Error('connect ECONNREFUSED redis://:hunter2@cache.internal:6379'), {
        code: 'ECONNREFUSED',
      })
    )
    const error = await refusal(limiter.hit('k', 1, 1_000))
    expect(error.internalMessage).toBe('redis EVAL failed: Error ECONNREFUSED')
    expect(JSON.stringify(error)).not.toContain('hunter2')
  })
})

describe('when Redis sends a reply the adapters do not understand', () => {
  test.each([
    ['nothing', null],
    ['a string', 'OK'],
    ['too few numbers', [1]],
    ['a fraction', [1, 0.5]],
    ['text in place of a number', [1, 'soon']],
  ] as [string, unknown][])('the rate limiter refuses on %s', async (_label, reply) => {
    const limiter = new RedisRateLimiter(replying(reply), new FixedClock(), keyedHash)
    const error = await refusal(limiter.hit('k', 5, 1_000))
    expect(error.internalMessage).toBe('redis sent an unexpected reply')
  })

  test('the lockout refuses', async () => {
    const lockout = new RedisLockout(replying('OK'))
    await refusal(lockout.attempt('k', CREDENTIAL_LOCKOUT, new Date()))
  })

  test.each([
    ['a number', 5],
    ['text that is not a time', 'soon'],
    ['a list', ['1']],
  ] as [string, unknown][])('the revoked-session list refuses on %s', async (_label, reply) => {
    const list = new RedisRevokedSessions(replying(reply), new FixedClock())
    await refusal(list.has('s1', new Date()))
    await refusal(list.add('s1', new Date()))
  })

  test('the signing-key marker refuses', async () => {
    await refusal(new RedisSigningKeyVersions(replying(7)).current('e1'))
  })
})

describe('what is stored in Redis', () => {
  test('rate-limit keys are namespaced and hold neither the address nor the bucket name', async () => {
    const { redis, limiter } = setup()
    await limiter.hit('sign_in:ip:203.0.113.7', 5, 60_000)
    await limiter.hit('verification_hourly:e1:someone@example.com', 5, 60_000)
    const keys = redis.keys()
    expect(keys).toHaveLength(2)
    for (const key of keys) {
      expect(key).toMatch(/^tula:rl:[0-9a-f]{64}$/)
    }
    expect(keys.join(' ')).not.toContain('203.0.113.7')
    expect(keys.join(' ')).not.toContain('example.com')
  })

  test('the same bucket name is the same key on every instance, and a different one elsewhere', async () => {
    const { clock, redis, limiter } = setup()
    await limiter.hit('k', 5, 60_000)
    await new RedisRateLimiter(redis, clock, createKeyedHash(TEST_MASTER_KEY)).hit('k', 5, 60_000)
    expect(redis.keys()).toHaveLength(1)
    await new RedisRateLimiter(redis, clock, createKeyedHash('cd'.repeat(32))).hit('k', 5, 60_000)
    expect(redis.keys()).toHaveLength(2)
  })

  test('lockout and revoked-session keys are namespaced by kind', async () => {
    const { clock, redis, lockout, list, versions } = setup()
    await lockout.attempt('sign_in:e1:abc', CREDENTIAL_LOCKOUT, clock.now())
    await list.add('s1', new Date(clock.now().getTime() + 60_000))
    await versions.bump('e1')
    expect(redis.keys().sort()).toEqual(['tula:lo:sign_in:e1:abc', 'tula:rs:s1', 'tula:sk:e1'])
  })

  test('a namespace of one’s own keeps deployments apart', async () => {
    const { clock, redis } = setup()
    await new RedisLockout(redis, 'other').attempt('k', CREDENTIAL_LOCKOUT, clock.now())
    await new RedisRevokedSessions(redis, clock, 'other').add('s1', clock.now())
    await new RedisRateLimiter(redis, clock, keyedHash, 'other').hit('k', 1, 1_000)
    await new RedisSigningKeyVersions(redis, 'other').bump('e1')
    expect(redis.keys().every((key) => key.startsWith('other:'))).toBe(true)
  })

  test('every key expires on its own: nothing needs sweeping', async () => {
    const { clock, redis, limiter, lockout, list } = setup()
    await limiter.hit('k', 5, 60_000)
    await lockout.attempt('k', SUITE_LOCKOUT_POLICY, clock.now())
    await list.add('s1', new Date(clock.now().getTime() + 60_000))
    expect(await redis.send('PTTL', [redis.keys().find((key) => key.includes(':rl:')) ?? ''])).toBe(
      60_000
    )
    expect(await redis.send('PTTL', ['tula:lo:k'])).toBe(60_000 + CLOCK_SKEW_ALLOWANCE_MS)
    expect(await redis.send('PTTL', ['tula:rs:s1'])).toBe(60_000 + CLOCK_SKEW_ALLOWANCE_MS)
    clock.advance(60_000 + CLOCK_SKEW_ALLOWANCE_MS)
    expect(redis.keys()).toEqual([])
  })

  test('a revoked session outlives its tokens by the clock-skew allowance', async () => {
    const { clock, redis, list } = setup()
    await list.add('s1', new Date(clock.now().getTime() + 60_000))
    clock.advance(60_000 + CLOCK_SKEW_ALLOWANCE_MS - 1)
    // An instance whose clock runs behind still finds the entry.
    expect(await list.has('s1', new Date(clock.now().getTime() - CLOCK_SKEW_ALLOWANCE_MS))).toBe(
      true
    )
    expect(redis.keys()).toEqual(['tula:rs:s1'])
  })
})

describe('RedisSigningKeyVersions', () => {
  test('has no marker until the keys change, then a new one each time', async () => {
    const { versions } = setup()
    expect(await versions.current('e1')).toBeNull()
    await versions.bump('e1')
    const first = await versions.current('e1')
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    await versions.bump('e1')
    expect(await versions.current('e1')).not.toBe(first)
    expect(await versions.current('e2')).toBeNull()
  })

  test('a second instance sees the marker the first one wrote', async () => {
    const { redis, versions } = setup()
    await versions.bump('e1')
    expect(await new RedisSigningKeyVersions(redis).current('e1')).toBe(
      (await versions.current('e1')) as string
    )
  })
})

describe('lockoutSchedule', () => {
  test('lists each wait up to the first that reaches the cap', () => {
    expect(lockoutSchedule(SUITE_LOCKOUT_POLICY)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(lockoutSchedule(CREDENTIAL_LOCKOUT)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000,
    ])
  })

  test('is never empty and never unbounded', () => {
    expect(
      lockoutSchedule({ freeAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, forgetAfterMs: 1 })
    ).toEqual([0])
    const endless = lockoutSchedule({
      freeAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: Number.MAX_SAFE_INTEGER,
      forgetAfterMs: 1,
    })
    expect(endless).toHaveLength(31)
    expect(endless.at(-1)).toBe(2 ** 30)
  })
})

describe('redisErrorReason', () => {
  const coded = (message: string, code: unknown) => Object.assign(new Error(message), { code })

  // The expected text comes first so the report shows it rather than each error's stack.
  test.each([
    [
      'Error ERR_REDIS_CONNECTION_CLOSED',
      coded('Connection closed', 'ERR_REDIS_CONNECTION_CLOSED'),
    ],
    [
      'Error ERR_REDIS_SERVER_ERROR WRONGTYPE',
      coded('WRONGTYPE Operation against a key holding the wrong kind', 'ERR_REDIS_SERVER_ERROR'),
    ],
    ['Error ERR_REDIS_SERVER_ERROR', coded('lowercase reply', 'ERR_REDIS_SERVER_ERROR')],
    ['TypeError', new TypeError('redis://user:pw@host is not valid')],
    ['Error', coded('a code that is not text', 42)],
    ['NonError', 'a string'],
    ['NonError', undefined],
  ] as [string, unknown][])('describes a failure as %s', (expected, error) => {
    expect(redisErrorReason(error)).toBe(expected)
  })
})

describe('call, evalScript and integers', () => {
  test('pass the reply through when Redis answers', async () => {
    const { redis } = setup()
    expect(await call(redis, 'PING', [])).toBe('PONG')
    expect(integers([1, 2], 2)).toEqual([1, 2])
  })

  test('evalScript sends the script with its key count, keys and arguments', async () => {
    const sent: [string, string[]][] = []
    const redis: RedisCommands = {
      async send(command, args) {
        sent.push([command, args])
        return [1]
      },
    }
    await evalScript(redis, 'return {1}', ['k1', 'k2'], ['a'])
    expect(sent).toEqual([['EVAL', ['return {1}', '2', 'k1', 'k2', 'a']]])
  })
})

describe('FakeRedis', () => {
  test('answers the plain commands like a server', async () => {
    const clock = new FixedClock()
    const redis = new FakeRedis(clock)
    expect(await redis.send('GET', ['k'])).toBeNull()
    expect(await redis.send('PTTL', ['k'])).toBe(-2)
    expect(await redis.send('SET', ['k', 'v'])).toBe('OK')
    expect(await redis.send('PTTL', ['k'])).toBe(-1)
    expect(await redis.send('SET', ['k', 'v2', 'PX', '500'])).toBe('OK')
    expect(await redis.send('GET', ['k'])).toBe('v2')
    clock.advance(500)
    expect(await redis.send('GET', ['k'])).toBeNull()
    await redis.send('SET', ['k', 'v'])
    expect(await redis.send('DEL', ['k'])).toBe(1)
    expect(await redis.send('DEL', ['k'])).toBe(0)
    // A lifetime that is not positive deletes, as PEXPIRE and SET PX would refuse or expire.
    await redis.send('SET', ['gone', 'v', 'PX', '0'])
    expect(redis.keys()).toEqual([])
  })

  test('a hash is not a string', async () => {
    const { clock, redis, lockout } = setup()
    await lockout.attempt('k', CREDENTIAL_LOCKOUT, clock.now())
    expect(await redis.send('GET', ['tula:lo:k'])).toBeNull()
  })

  test('rejects commands and scripts it does not know, as a server error', async () => {
    const redis = new FakeRedis(new FixedClock())
    for (const work of [redis.send('FLUSHALL', []), redis.send('EVAL', ['return 1', '0'])]) {
      const error = await work.then(
        () => null,
        (thrown: unknown) => thrown
      )
      expect(redisErrorReason(error)).toBe('RedisError ERR_REDIS_SERVER_ERROR ERR')
    }
    expect(await refusal(evalScript(redis, 'return 1', [], []))).toMatchObject({
      internalMessage: 'redis EVAL failed: RedisError ERR_REDIS_SERVER_ERROR ERR',
    })
  })
})
