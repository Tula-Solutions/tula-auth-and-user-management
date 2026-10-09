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

// The development SMS inbox hands every code to whoever asks: the same two guards as the
// mock provider (ADR 0037).
describe('SMS_PROVIDER', () => {
  test('is none unless asked for, and dev is allowed in the local tier', () => {
    expect(parseEnv(base).SMS_PROVIDER).toBe('none')
    expect(parseEnv({ ...base, SMS_PROVIDER: 'none' }).SMS_PROVIDER).toBe('none')
    expect(parseEnv({ ...base, SMS_PROVIDER: 'dev' }).SMS_PROVIDER).toBe('dev')
  })

  test('refuses a provider it does not know', () => {
    expect(() => parseEnv({ ...base, SMS_PROVIDER: 'vonage' })).toThrow(/SMS_PROVIDER/)
    expect(() => parseEnv({ ...base, SMS_PROVIDER: 'Twilio' })).toThrow(/SMS_PROVIDER/)
    expect(() => parseEnv({ ...base, SMS_PROVIDER: 'true' })).toThrow(/SMS_PROVIDER/)
  })

  test.each(['dev', 'staging', 'prod'])('refuses to boot with the inbox in %s', (tier) => {
    const source = tier === 'dev' ? base : live
    expect(() => parseEnv({ ...source, ENVIRONMENT: tier, SMS_PROVIDER: 'dev' })).toThrow(
      /SMS_PROVIDER: dev is only allowed with ENVIRONMENT=local/
    )
    // Without it the same environment boots.
    expect(parseEnv({ ...source, ENVIRONMENT: tier }).SMS_PROVIDER).toBe('none')
  })

  test.each([
    'http://localhost:3003',
    'http://127.0.0.1:3003',
    'http://[::1]:3003',
    'http://auth.localhost:3003',
  ])('boots with the inbox when PUBLIC_URL is the loopback address %p', (url) => {
    expect(parseEnv({ ...base, SMS_PROVIDER: 'dev', PUBLIC_URL: url }).SMS_PROVIDER).toBe('dev')
  })

  test.each([
    'http://192.168.1.20:3003',
    'http://0.0.0.0:3003',
    'https://auth.example.com',
    'http://localhost.example.com:3003',
    'http://my-laptop.local:3003',
  ])('refuses the inbox when PUBLIC_URL is %p, even in the local tier', (url) => {
    expect(() => parseEnv({ ...base, SMS_PROVIDER: 'dev', PUBLIC_URL: url })).toThrow(
      /SMS_PROVIDER: dev is only allowed when PUBLIC_URL is a loopback address/
    )
    expect(parseEnv({ ...base, PUBLIC_URL: url }).SMS_PROVIDER).toBe('none')
  })
})

// TULA-29: the one sender that really sends. Its variables are judged only when it is chosen.
describe('SMS_PROVIDER=twilio', () => {
  const ACCOUNT = `AC${'0a1b2c3d'.repeat(4)}`
  const KEY = `SK${'9f8e7d6c'.repeat(4)}`
  const SERVICE = `MG${'1122aabb'.repeat(4)}`
  const SECRET = 'KeySecret-canary-Zq7Lm2Xw9Rt4Vb6Ny8Pd'
  const TOKEN = 'authtoken-canary-5f3a9c1e7b2d4f6a8c0e'
  const NUMBER = '+15005550006'
  const withKey = {
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: ACCOUNT,
    TWILIO_API_KEY_SID: KEY,
    TWILIO_API_KEY_SECRET: SECRET,
    TWILIO_MESSAGING_SERVICE_SID: SERVICE,
  }
  const withToken = {
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: ACCOUNT,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_FROM_NUMBER: NUMBER,
  }

  test.each([
    ['local', base],
    ['dev', base],
    ['staging', live],
    ['prod', live],
  ])('boots in %s with an API key and a Messaging Service', (tier, source) => {
    const env = parseEnv({ ...source, ENVIRONMENT: tier, ...withKey })
    expect(env.SMS_PROVIDER).toBe('twilio')
    expect(env.TWILIO_ACCOUNT_SID).toBe(ACCOUNT)
    expect(env.TWILIO_API_KEY_SID).toBe(KEY)
    expect(env.TWILIO_API_KEY_SECRET).toBe(SECRET)
    expect(env.TWILIO_MESSAGING_SERVICE_SID).toBe(SERVICE)
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined()
    expect(env.TWILIO_FROM_NUMBER).toBeUndefined()
  })

  test('boots with the auth token and one number', () => {
    const env = parseEnv({ ...live, ...withToken })
    expect(env.TWILIO_AUTH_TOKEN).toBe(TOKEN)
    expect(env.TWILIO_FROM_NUMBER).toBe(NUMBER)
  })

  test('a blank variable is an unset one', () => {
    const env = parseEnv({
      ...base,
      ...withKey,
      TWILIO_AUTH_TOKEN: '',
      TWILIO_FROM_NUMBER: '   ',
    })
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined()
    expect(env.TWILIO_FROM_NUMBER).toBeUndefined()
  })

  const refusals: [string, Record<string, string | undefined>, string[]][] = [
    [
      'nothing but the provider',
      { SMS_PROVIDER: 'twilio' },
      ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_MESSAGING_SERVICE_SID'],
    ],
    ['no account', { ...withKey, TWILIO_ACCOUNT_SID: undefined }, ['TWILIO_ACCOUNT_SID']],
    ['no credentials', { ...withToken, TWILIO_AUTH_TOKEN: undefined }, ['TWILIO_API_KEY_SID']],
    ['both ways to authenticate', { ...withKey, TWILIO_AUTH_TOKEN: TOKEN }, ['TWILIO_AUTH_TOKEN']],
    [
      'the auth token beside half an API key',
      { ...withToken, TWILIO_API_KEY_SID: KEY },
      ['TWILIO_AUTH_TOKEN'],
    ],
    [
      'an API key without its secret',
      { ...withKey, TWILIO_API_KEY_SECRET: undefined },
      ['TWILIO_API_KEY_SECRET'],
    ],
    [
      'a secret without its API key',
      { ...withKey, TWILIO_API_KEY_SID: undefined },
      ['TWILIO_API_KEY_SID'],
    ],
    [
      'no sender',
      { ...withKey, TWILIO_MESSAGING_SERVICE_SID: undefined },
      ['TWILIO_MESSAGING_SERVICE_SID'],
    ],
    ['both senders', { ...withKey, TWILIO_FROM_NUMBER: NUMBER }, ['TWILIO_FROM_NUMBER']],
    [
      'an account that is an API key',
      { ...withKey, TWILIO_ACCOUNT_SID: KEY },
      ['TWILIO_ACCOUNT_SID'],
    ],
    [
      'an account one character short',
      { ...withKey, TWILIO_ACCOUNT_SID: ACCOUNT.slice(0, -1) },
      ['TWILIO_ACCOUNT_SID'],
    ],
    [
      'an account one character long',
      { ...withKey, TWILIO_ACCOUNT_SID: `${ACCOUNT}0` },
      ['TWILIO_ACCOUNT_SID'],
    ],
    [
      'an account that is not hexadecimal',
      { ...withKey, TWILIO_ACCOUNT_SID: `AC${'z'.repeat(32)}` },
      ['TWILIO_ACCOUNT_SID'],
    ],
    [
      'an API key that is an account',
      { ...withKey, TWILIO_API_KEY_SID: ACCOUNT },
      ['TWILIO_API_KEY_SID'],
    ],
    [
      'a Messaging Service that is a number',
      { ...withKey, TWILIO_MESSAGING_SERVICE_SID: NUMBER },
      ['TWILIO_MESSAGING_SERVICE_SID'],
    ],
    [
      'a secret with a space in it',
      { ...withKey, TWILIO_API_KEY_SECRET: 'two words' },
      ['TWILIO_API_KEY_SECRET'],
    ],
    [
      'a token that is not ASCII',
      { ...withToken, TWILIO_AUTH_TOKEN: 'tökenvalue' },
      ['TWILIO_AUTH_TOKEN'],
    ],
    [
      'a token of 257 characters',
      { ...withToken, TWILIO_AUTH_TOKEN: 'a'.repeat(257) },
      ['TWILIO_AUTH_TOKEN'],
    ],
    [
      'a number without its plus',
      { ...withToken, TWILIO_FROM_NUMBER: '15005550006' },
      ['TWILIO_FROM_NUMBER'],
    ],
    [
      'a number with spaces',
      { ...withToken, TWILIO_FROM_NUMBER: '+1 500 555 0006' },
      ['TWILIO_FROM_NUMBER'],
    ],
    [
      'a number that starts with zero',
      { ...withToken, TWILIO_FROM_NUMBER: '+05005550006' },
      ['TWILIO_FROM_NUMBER'],
    ],
    [
      'a number of seven digits',
      { ...withToken, TWILIO_FROM_NUMBER: '+1500555' },
      ['TWILIO_FROM_NUMBER'],
    ],
    [
      'a number of sixteen digits',
      { ...withToken, TWILIO_FROM_NUMBER: '+1500555000612345' },
      ['TWILIO_FROM_NUMBER'],
    ],
    [
      'an alphanumeric sender as the number',
      { ...withToken, TWILIO_FROM_NUMBER: 'Northline' },
      ['TWILIO_FROM_NUMBER'],
    ],
  ]

  test.each(refusals)('refuses to boot with %s', (_name, twilio, refused) => {
    expect(invalidVars({ ...base, ...twilio })).toEqual(refused)
    // In a live tier too, and nothing else is complained about there.
    expect(invalidVars({ ...live, ...twilio })).toEqual(refused)
  })

  test('a refusal names the variable and never echoes a value', () => {
    const everything = {
      ...base,
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'account-canary',
      TWILIO_API_KEY_SID: 'key-canary',
      TWILIO_API_KEY_SECRET: 'secret canary',
      TWILIO_AUTH_TOKEN: 'token canary',
      TWILIO_MESSAGING_SERVICE_SID: 'service-canary',
      TWILIO_FROM_NUMBER: 'number-canary',
    }
    const said = issues(everything)
    expect(said.map((issue) => issue.slice(0, issue.indexOf(':'))).sort()).toEqual([
      'TWILIO_ACCOUNT_SID',
      'TWILIO_API_KEY_SECRET',
      'TWILIO_API_KEY_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'TWILIO_FROM_NUMBER',
      'TWILIO_MESSAGING_SERVICE_SID',
    ])
    expect(said.join('\n')).not.toContain('canary')
    // A well-formed secret in the wrong line is not repeated either.
    const misplaced = issues({ ...base, ...withKey, TWILIO_ACCOUNT_SID: SECRET }).join('\n')
    expect(misplaced).toContain('TWILIO_ACCOUNT_SID')
    expect(misplaced).not.toContain(SECRET)
  })

  // Decision of TULA-29: a file may carry another deployment's Twilio lines, and the webhook
  // worker reads the same schema while sending nothing.
  test.each(['none', 'dev', undefined])(
    'with SMS_PROVIDER=%p the Twilio variables are ignored, whatever they hold',
    (provider) => {
      const env = parseEnv({
        ...base,
        SMS_PROVIDER: provider,
        TWILIO_ACCOUNT_SID: 'not an account',
        TWILIO_API_KEY_SID: KEY,
        TWILIO_AUTH_TOKEN: 'both ways at once',
        TWILIO_MESSAGING_SERVICE_SID: SERVICE,
        TWILIO_FROM_NUMBER: 'and both senders',
      })
      expect(env.SMS_PROVIDER).toBe(provider ?? 'none')
    }
  )

  test('Twilio’s variables do not lift the development inbox’s rule', () => {
    // Twice: the tier, and the address that is not this machine.
    expect(invalidVars({ ...live, ...withKey, SMS_PROVIDER: 'dev' })).toEqual([
      'SMS_PROVIDER',
      'SMS_PROVIDER',
    ])
  })
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

  describe('TULA_ADMIN_TOKEN', () => {
    const token = 'k3Zr8vQ1nP5xW7bT2mY9cF4hJ6dL0sAg'

    test('is optional: unset and blank both mean "no instance routes"', () => {
      expect(parseEnv(base).TULA_ADMIN_TOKEN).toBeUndefined()
      expect(parseEnv({ ...base, TULA_ADMIN_TOKEN: '  ' }).TULA_ADMIN_TOKEN).toBeUndefined()
    })

    describe('needs an encrypted or loopback PUBLIC_URL, in every tier', () => {
      test.each([
        ['dev', 'http://auth.example.com'],
        ['local', 'http://auth.example.com'],
        ['dev', 'http://192.168.1.20:3003'],
        ['dev', 'http://localhost.example.com'],
      ])('%s with %s and a token is refused, without echoing the token', (tier, url) => {
        const source = { ...base, ENVIRONMENT: tier, PUBLIC_URL: url, TULA_ADMIN_TOKEN: token }
        expect(invalidVars(source)).toEqual(['PUBLIC_URL'])
        expect(issues(source).join('\n')).toContain('TULA_ADMIN_TOKEN')
        expect(issues(source).join('\n')).not.toContain(token)
      })

      test.each([
        ['dev', 'http://localhost:3003'],
        ['dev', 'http://127.0.0.1:3003'],
        ['local', 'http://[::1]:3003'],
        ['local', 'http://api.localhost:3003'],
        ['dev', 'https://auth.example.com'],
      ])('%s with %s and a token is accepted', (tier, url) => {
        const source = { ...base, ENVIRONMENT: tier, PUBLIC_URL: url, TULA_ADMIN_TOKEN: token }
        expect(parseEnv(source).TULA_ADMIN_TOKEN).toBe(token)
      })

      test('without a token a plain-http address on another host is still accepted in dev', () => {
        const source = { ...base, ENVIRONMENT: 'dev', PUBLIC_URL: 'http://auth.example.com' }
        expect(parseEnv(source).PUBLIC_URL).toBe('http://auth.example.com')
      })

      test('a live tier names PUBLIC_URL once: the https rule already covers it', () => {
        const source = { ...live, PUBLIC_URL: 'http://auth.example.com', TULA_ADMIN_TOKEN: token }
        expect(invalidVars(source)).toEqual(['PUBLIC_URL'])
      })
    })

    test('accepts a generated value', () => {
      expect(parseEnv({ ...base, TULA_ADMIN_TOKEN: token }).TULA_ADMIN_TOKEN).toBe(token)
      const hex = 'f3a91c0b7d2e4856a1c9e0d37b5f2a6418c07e9d3b5a2f6c'
      expect(parseEnv({ ...base, TULA_ADMIN_TOKEN: hex }).TULA_ADMIN_TOKEN).toBe(hex)
    })

    // What the check is: a floor against a value typed or copied by accident. It does not
    // measure randomness (nothing can, from one value). These rows are the documentation.
    test.each([
      [
        'hex from `openssl rand -hex 32`',
        '9b1f0c6e2a7d4853e0f1a2b3c4d5e6f79a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d',
      ],
      ['base64url of 32 bytes', 'Zq3vX0n8Kp2Tf6YbLw9Rj4Hs1DcGm7Ae5UoIxNyPzQk'],
      ['a short run inside a random value', 'c4e1abcdef77b2d09a4f5e6d8c1b3a70'],
      ['a block that appears twice, apart', 'k3Zr8vQ1-7fT2mY9c-k3Zr8vQ1-Xw4Lp0Sd'],
    ])('accepts %s', (_label, value) => {
      expect(parseEnv({ ...base, TULA_ADMIN_TOKEN: value }).TULA_ADMIN_TOKEN).toBe(value)
    })

    test.each([
      ['a block repeated', 'a1b2c3d4e5f6'.repeat(3)],
      ['a random-looking block typed twice', 'k3Zr8vQ1nP5xW7bT'.repeat(2)],
      ['a repeated block with a ragged end', `${'k3Zr8vQ1nP5xW7bT'.repeat(2)}k3Z`],
      ['the alphabet', 'abcdefghijklmnopqrstuvwxyzabcdefgh'],
      ['a run counting down', 'zyxwvutsrqponmlk-Zq3vX0n8Kp2Tf6Yb'],
      ['a run of digits', 'Zq3vX0n8Kp2Tf6Yb-12345678-Lw9Rj4Hs'],
      ['a keyboard row', 'qwertyuiopasdfghjklzxcvbnm135790'],
    ])('refuses %s, without echoing it', (_label, value) => {
      expect(invalidVars({ ...base, TULA_ADMIN_TOKEN: value })).toEqual(['TULA_ADMIN_TOKEN'])
      try {
        parseEnv({ ...base, TULA_ADMIN_TOKEN: value })
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(value)
      }
    })

    test.each([
      ['short', token.slice(0, 31)],
      ['repetitive', 'a'.repeat(40)],
      ['two characters', 'ab'.repeat(20)],
      ['a placeholder', 'changeme-changeme-changeme-12345678'],
      ['an example value', 'your-admin-token-goes-here-0123abcd'],
      ['with a space', `${token.slice(0, 20)} ${token.slice(20)}zz`],
      ['too long', 'k3Zr8vQ1nP5xW7bT2mY9cF4hJ6dL0sAg'.repeat(9)],
    ])('refuses a value that is %s, without echoing it', (_label, value) => {
      expect(invalidVars({ ...base, TULA_ADMIN_TOKEN: value })).toEqual(['TULA_ADMIN_TOKEN'])
      try {
        parseEnv({ ...base, TULA_ADMIN_TOKEN: value })
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(value)
      }
    })
  })
})

describe('WEBHOOK_WORKER', () => {
  test('unset or blank, deliveries are made inside the API, as before the switch existed', () => {
    expect(parseEnv(base).WEBHOOK_WORKER).toBe('api')
    expect(parseEnv({ ...base, WEBHOOK_WORKER: '' }).WEBHOOK_WORKER).toBe('api')
    expect(parseEnv({ ...base, WEBHOOK_WORKER: '  ' }).WEBHOOK_WORKER).toBe('api')
  })

  test.each(['api', 'separate'] as const)('%s is accepted as written', (value) => {
    expect(parseEnv({ ...base, WEBHOOK_WORKER: value }).WEBHOOK_WORKER).toBe(value)
  })

  // A closed set, exact: a near miss must stop the boot, never fall back to a default that
  // decides who delivers.
  test.each(['Separate', 'API', 'worker', 'off', 'true', 'none', 'api,separate', ' separate'])(
    '%p is refused',
    (value) => {
      expect(invalidVars({ ...base, WEBHOOK_WORKER: value })).toEqual(['WEBHOOK_WORKER'])
    }
  )

  test('it is accepted in a live tier too', () => {
    expect(parseEnv({ ...live, WEBHOOK_WORKER: 'separate' }).WEBHOOK_WORKER).toBe('separate')
  })
})
