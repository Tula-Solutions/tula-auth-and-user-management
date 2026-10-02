import { describe, expect, spyOn, test } from 'bun:test'
import { EnvError, loadEnv, parseEnv } from '~/env'

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
      'PUBLIC_URL',
    ])
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

  test('dev tier may use local services', () => {
    expect(parseEnv({ ...base, ENVIRONMENT: 'dev' }).BREACH_CHECK).toBe('offline')
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
