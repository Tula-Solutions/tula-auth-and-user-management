import { describe, expect, spyOn, test } from 'bun:test'
import { EnvError, isLoopbackUrl, loadEnv, parseEnv } from '~/env'

const MASTER_KEY = 'a'.repeat(64)
const base = {
  ENVIRONMENT: 'local',
  DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:5432/tula',
  TULA_MASTER_KEY: MASTER_KEY,
}
const live = {
  ...base,
  ENVIRONMENT: 'prod',
  SMTP_URL: 'smtps://relay.example.com:465',
  MAIL_FROM: 'Example <no-reply@example.com>',
  BREACH_CHECK: 'hibp',
  PUBLIC_URL: 'https://auth.example.com',
  REDIS_URL: 'rediss://cache.example.com:6380',
}

function issues(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source)
  } catch (error) {
    if (error instanceof EnvError) {
      return error.issues
    }
    throw error
  }
  return []
}

/** The variable each issue names, e.g. `['SMTP_URL', 'BREACH_CHECK']`. */
function invalidVars(source: Record<string, string | undefined>): string[] {
  return issues(source).map((issue) => issue.slice(0, issue.indexOf(':')))
}

describe('parseEnv', () => {
  test('applies defaults for a minimal local config', () => {
    const env = parseEnv(base)
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      ENVIRONMENT: 'local',
      PORT: 3003,
      LOG_LEVEL: 'info',
      SMTP_URL: 'smtp://127.0.0.1:1025',
      MAIL_FROM: 'Tula Auth <no-reply@localhost>',
      PUBLIC_URL: 'http://localhost:3003',
      BREACH_CHECK: 'offline',
      CORS_ORIGINS: [],
      TRUST_PROXY: false,
    })
  })

  test('parses lists, flags and numbers', () => {
    const env = parseEnv({
      ...base,
      PORT: '8080',
      CORS_ORIGINS: ' https://a.test, ,https://b.test ',
      TRUST_PROXY: 'YES',
    })
    expect(env.PORT).toBe(8080)
    expect(env.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test'])
    expect(env.TRUST_PROXY).toBe(true)
  })

  test('requires ENVIRONMENT instead of defaulting to local', () => {
    expect(invalidVars({ ...base, ENVIRONMENT: undefined })).toEqual(['ENVIRONMENT'])
  })

  test.each([
    ['missing', undefined],
    ['too short', 'ab'.repeat(16)],
    ['not hex', 'z'.repeat(64)],
  ])('rejects a %s TULA_MASTER_KEY without echoing it', (_, value) => {
    const found = issues({ ...base, TULA_MASTER_KEY: value })
    expect(found.map((issue) => issue.split(':')[0])).toEqual(['TULA_MASTER_KEY'])
    if (value) {
      expect(found.join()).not.toContain(value)
    }
  })

  test('rejects a non-Postgres DATABASE_URL', () => {
    expect(invalidVars({ ...base, DATABASE_URL: 'mysql://x@localhost/db' })).toEqual([
      'DATABASE_URL',
    ])
  })

  test('accepts a correctly configured live tier', () => {
    expect(parseEnv(live).ENVIRONMENT).toBe('prod')
  })

  test.each(['staging', 'prod'])('%s refuses Mailpit, offline breach checks and http', (tier) => {
    expect(invalidVars({ ...base, ENVIRONMENT: tier })).toEqual([
      'SMTP_URL',
      'MAIL_FROM',
      'BREACH_CHECK',
      'REDIS_URL',
      'PUBLIC_URL',
    ])
  })

  test.each(['staging', 'prod'])('%s refuses to start without Redis', (tier) => {
    const { REDIS_URL: _unset, ...withoutRedis } = live
    expect(issues({ ...withoutRedis, ENVIRONMENT: tier })).toEqual([
      `REDIS_URL: is required in ${tier}: rate limits, lockout and revoked sessions must be shared between instances`,
    ])
    expect(invalidVars({ ...live, ENVIRONMENT: tier, REDIS_URL: '  ' })).toEqual(['REDIS_URL'])
  })

  test.each(['local', 'dev'])('%s runs without Redis, and with it when set', (tier) => {
    expect(parseEnv({ ...base, ENVIRONMENT: tier }).REDIS_URL).toBeUndefined()
    // A blank value, as in a copied `.env.example`, means unset.
    expect(parseEnv({ ...base, ENVIRONMENT: tier, REDIS_URL: '' }).REDIS_URL).toBeUndefined()
    expect(
      parseEnv({ ...base, ENVIRONMENT: tier, REDIS_URL: 'redis://127.0.0.1:6379' }).REDIS_URL
    ).toBe('redis://127.0.0.1:6379')
  })

  test.each(['redis://h:6379', 'rediss://h:6380/2', 'valkey://h', 'valkeys://u:p@h:1'])(
    'accepts the Redis URL %p',
    (url) => {
      expect(parseEnv({ ...base, REDIS_URL: url }).REDIS_URL).toBe(url)
    }
  )

  test.each(['http://h:6379', 'h:6379', 'not a url'])('rejects the Redis URL %p', (url) => {
    expect(invalidVars({ ...base, REDIS_URL: url })).toEqual(['REDIS_URL'])
  })

  test('an invalid Redis URL is reported without echoing it', () => {
    expect(issues({ ...base, REDIS_URL: 'http://:hunter2@h' }).join(' ')).not.toContain('hunter2')
  })

  test('the live-tier SMTP check also catches localhost', () => {
    expect(invalidVars({ ...live, SMTP_URL: 'smtp://localhost:25' })).toEqual(['SMTP_URL'])
  })

  test.each(['no-reply@localhost', 'Tula <no-reply@LOCALHOST>'])(
    'a live tier refuses the localhost sender %p',
    (from) => {
      expect(invalidVars({ ...live, MAIL_FROM: from })).toEqual(['MAIL_FROM'])
    }
  )

  test.each(['', 'not an address', 'Tula <no-reply>'])('rejects the sender %p', (from) => {
    expect(invalidVars({ ...base, MAIL_FROM: from })).toEqual(['MAIL_FROM'])
  })

  test('the live-tier SMTP check also catches the Compose stack’s Mailpit', () => {
    expect(invalidVars({ ...live, SMTP_URL: 'smtp://mailpit:1025' })).toEqual(['SMTP_URL'])
    expect(invalidVars({ ...live, SMTP_URL: 'smtp://MAILPIT:1025' })).toEqual(['SMTP_URL'])
  })

  test('dev tier may use local services', () => {
    expect(parseEnv({ ...base, ENVIRONMENT: 'dev' }).BREACH_CHECK).toBe('offline')
  })
})

describe('OAUTH_MOCK_PROVIDER', () => {
  test('is off unless asked for, and allowed in the local tier', () => {
    expect(parseEnv(base).OAUTH_MOCK_PROVIDER).toBe(false)
    expect(parseEnv({ ...base, OAUTH_MOCK_PROVIDER: 'false' }).OAUTH_MOCK_PROVIDER).toBe(false)
    expect(parseEnv({ ...base, OAUTH_MOCK_PROVIDER: 'true' }).OAUTH_MOCK_PROVIDER).toBe(true)
  })

  test.each(['dev', 'staging', 'prod'])('refuses to boot with it in %s', (tier) => {
    const source = tier === 'dev' ? base : live
    expect(() => parseEnv({ ...source, ENVIRONMENT: tier, OAUTH_MOCK_PROVIDER: 'true' })).toThrow(
      /OAUTH_MOCK_PROVIDER: is only allowed with ENVIRONMENT=local/
    )
    // Without it the same environment boots.
    expect(parseEnv({ ...source, ENVIRONMENT: tier }).OAUTH_MOCK_PROVIDER).toBe(false)
  })

  // Review finding F5: `local` is a label an operator sets. The mock signs anyone in as any
  // address, so it must also be impossible on an API that other machines are told to reach.
  test.each([
    'http://localhost:3003',
    'http://127.0.0.1:3003',
    'http://[::1]:3003',
    'http://auth.localhost:3003',
    'http://LOCALHOST:3003/',
  ])('boots with it when PUBLIC_URL is the loopback address %p', (url) => {
    expect(
      parseEnv({ ...base, OAUTH_MOCK_PROVIDER: 'true', PUBLIC_URL: url }).OAUTH_MOCK_PROVIDER
    ).toBe(true)
  })

  test.each([
    'http://192.168.1.20:3003',
    'http://0.0.0.0:3003',
    'https://auth.example.com',
    'http://localhost.example.com:3003',
    'http://notlocalhost:3003',
    'http://127.0.0.1.example.com:3003',
    'http://my-laptop.local:3003',
  ])('refuses to boot with it when PUBLIC_URL is %p, even in the local tier', (url) => {
    expect(() => parseEnv({ ...base, OAUTH_MOCK_PROVIDER: 'true', PUBLIC_URL: url })).toThrow(
      /OAUTH_MOCK_PROVIDER: is only allowed when PUBLIC_URL is a loopback address/
    )
    // Without the mock the same PUBLIC_URL boots.
    expect(parseEnv({ ...base, PUBLIC_URL: url }).OAUTH_MOCK_PROVIDER).toBe(false)
  })

  // Review finding F8: the loopback check parsed PUBLIC_URL itself and threw a raw TypeError
  // for a value that is not a URL, instead of letting boot fail with a validation message.
  test.each(['not a url', '', 'localhost:3003', '//localhost'])(
    'a PUBLIC_URL that is not a URL (%p) is a validation error, not a crash',
    (url) => {
      expect(isLoopbackUrl(url)).toBe(false)
      let thrown: unknown
      try {
        parseEnv({ ...base, OAUTH_MOCK_PROVIDER: 'true', PUBLIC_URL: url })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).not.toBeInstanceOf(TypeError)
      expect((thrown as Error).message).toMatch(/PUBLIC_URL/)
    }
  )
})

// Same finding (F8), the live tiers: their cross-field rules parsed SMTP_URL and PUBLIC_URL too.
describe('a live tier with a URL that does not parse', () => {
  test.each([
    ['PUBLIC_URL', 'not a url'],
    ['SMTP_URL', 'nope'],
  ])('%s is a validation error, not a crash', (name, value) => {
    let thrown: unknown
    try {
      parseEnv({ ...live, [name]: value })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(EnvError)
    expect((thrown as Error).message).toMatch(new RegExp(name))
  })
})

describe('loadEnv', () => {
  test('exits with a readable report when invalid', () => {
    const saved = process.env.ENVIRONMENT
    process.env.ENVIRONMENT = 'nope'
    const exit = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => loadEnv()).toThrow('exit')
      expect(exit).toHaveBeenCalledWith(1)
      expect(String(stderr.mock.calls[0]?.[0])).toContain('Invalid environment configuration')
    } finally {
      exit.mockRestore()
      stderr.mockRestore()
      process.env.ENVIRONMENT = saved
    }
  })

  test('returns the parsed env when valid', () => {
    const saved = { ...process.env }
    Object.assign(process.env, base)
    try {
      expect(loadEnv().ENVIRONMENT).toBe('local')
    } finally {
      for (const key of Object.keys(base)) {
        if (saved[key] === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = saved[key]
        }
      }
    }
  })
})
