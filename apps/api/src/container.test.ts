import { describe, expect, spyOn, test } from 'bun:test'
import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { HibpBreachChecker } from '~/adapters/breach/hibp'
import { offlineBreachChecker } from '~/adapters/breach/offline'
import { SmtpMailer } from '~/adapters/mail/smtp'
import { MemoryLockout } from '~/adapters/memory/lockout'
import { MemoryRateLimiter } from '~/adapters/memory/rate-limiter'
import { MemoryRevokedSessions } from '~/adapters/memory/revoked-sessions'
import { PostgresVerificationTokenStore } from '~/adapters/postgres/verification-tokens'
import { RedisLockout } from '~/adapters/redis/lockout'
import { RedisRateLimiter } from '~/adapters/redis/rate-limiter'
import { RedisRevokedSessions } from '~/adapters/redis/revoked-sessions'
import { createContainer } from '~/container'
import { parseEnv } from '~/env'
import * as logger from '~/lib/logger'
import { SmsSendError } from '~/ports/sms-sender'

const base = {
  ENVIRONMENT: 'dev',
  // Nothing listens here: building the container must not open a connection.
  DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:1/tula',
  TULA_MASTER_KEY: 'a'.repeat(64),
  // No dashboard here, whether or not this checkout has built one.
  DASHBOARD_DIR: '/nonexistent/tula-dashboard',
}

describe('createContainer', () => {
  test('wires production adapters from env without connecting', async () => {
    const env = parseEnv({
      ...base,
      CORS_ORIGINS: 'https://app.test',
      TRUST_PROXY: 'true',
      PASSWORD_POLICY: 'strict',
      BREACH_CHECK: 'hibp',
    })
    const { deps, close } = createContainer(env)
    expect(deps.config).toEqual({
      tier: 'dev',
      publicUrl: 'http://localhost:3003',
      corsOrigins: ['https://app.test'],
      trustProxy: true,
      passwordPolicy: PASSWORD_POLICY_PRESETS.strict,
      oauthMock: false,
      instanceAdminTokenHash: null,
      dashboardDir: null,
      apiDocs: true,
      instanceAuditRetentionDays: 365,
      deliversWebhooks: true,
    })
    expect(deps.breachChecker).toBeInstanceOf(HibpBreachChecker)
    expect(deps.mailer).toBeInstanceOf(SmtpMailer)
    expect(deps.verificationTokens).toBeInstanceOf(PostgresVerificationTokenStore)
    expect(await deps.keyedHash.hmac('test', 'x')).toMatch(/^[0-9a-f]{64}$/)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database'])
    expect(deps.ids.next()).toMatch(/^[0-9a-f-]{36}$/)
    await close()
  })

  test.each(['local', 'dev', 'staging', 'prod'] as const)(
    'the outbound guard is given the %s tier and nothing else: no resolver, no extra certificate',
    async (tier) => {
      const { deps, close } = createContainer(
        parseEnv({
          ...base,
          ENVIRONMENT: tier,
          // What the live tiers insist on; nothing here is ever connected to.
          REDIS_URL: 'redis://127.0.0.1:1',
          SMTP_URL: 'smtps://relay.example.com:465',
          MAIL_FROM: 'Tula <auth@example.com>',
          BREACH_CHECK: 'hibp',
          PUBLIC_URL: 'https://auth.example.com',
        })
      )
      // Exactly this: the system resolver and the system's certificate authorities.
      expect(deps.outbound).toEqual({ tier })
      await close()
    }
  )

  test('the jitter of webhook retries is a number from 0 up to, never including, 1, and not a fixed one', async () => {
    const { deps, close } = createContainer(parseEnv(base))
    const drawn = Array.from({ length: 200 }, () => deps.jitter())
    expect(drawn.every((value) => value >= 0 && value < 1)).toBe(true)
    // 32 random bits each: two hundred equal draws would mean it is not random at all.
    expect(new Set(drawn).size).toBeGreaterThan(100)
    await close()
  })

  test('defaults to the recommended policy and the offline breach list', async () => {
    const { deps, close } = createContainer(parseEnv(base))
    expect(deps.config.passwordPolicy).toEqual(PASSWORD_POLICY_PRESETS.recommended)
    expect(deps.breachChecker).toBe(offlineBreachChecker)
    await close()
  })

  test('without REDIS_URL the shared state is held in process memory', async () => {
    const { deps, close } = createContainer(parseEnv(base))
    expect(deps.rateLimiter).toBeInstanceOf(MemoryRateLimiter)
    expect(deps.lockout).toBeInstanceOf(MemoryLockout)
    expect(deps.revokedSessions).toBeInstanceOf(MemoryRevokedSessions)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database'])
    await close()
  })

  test('with REDIS_URL the shared state is in Redis and readiness checks it, without connecting', async () => {
    // Nothing listens here either: building the container must not open a connection.
    const env = parseEnv({ ...base, REDIS_URL: 'redis://127.0.0.1:1' })
    const { deps, close } = createContainer(env)
    expect(deps.rateLimiter).toBeInstanceOf(RedisRateLimiter)
    expect(deps.lockout).toBeInstanceOf(RedisLockout)
    expect(deps.revokedSessions).toBeInstanceOf(RedisRevokedSessions)
    expect(deps.probes.map((probe) => probe.name)).toEqual(['database', 'redis'])
    await close()
  })
})

describe('the webhook worker as its own service (WEBHOOK_WORKER)', () => {
  test.each([
    ['api', 'api', true],
    ['api', 'separate', false],
    ['worker', 'separate', true],
  ] as const)(
    'a process started as %s where WEBHOOK_WORKER is %s: deliversWebhooks is %p',
    async (role, mode, expected) => {
      const { deps, close } = createContainer(parseEnv({ ...base, WEBHOOK_WORKER: mode }), role)
      expect(deps.config.deliversWebhooks).toBe(expected)
      await close()
    }
  )

  test('a worker where the API instances deliver is refused before anything is built', () => {
    expect(() => createContainer(parseEnv({ ...base, WEBHOOK_WORKER: 'api' }), 'worker')).toThrow(
      'Set WEBHOOK_WORKER=separate on every container'
    )
  })

  test('the role defaults to the API: every existing caller is an API instance', async () => {
    const { deps, close } = createContainer(parseEnv({ ...base, WEBHOOK_WORKER: 'separate' }))
    expect(deps.config.deliversWebhooks).toBe(false)
    await close()
  })

  test.each(['api', 'worker'] as const)(
    'the outbound guard of a %s process is the tier and nothing else',
    async (role) => {
      const { deps, close } = createContainer(
        parseEnv({ ...base, WEBHOOK_WORKER: 'separate' }),
        role
      )
      expect(deps.outbound).toEqual({ tier: 'dev' })
      await close()
    }
  )

  test('a worker is ready when the database answers: it uses nothing of Redis', async () => {
    const env = parseEnv({
      ...base,
      WEBHOOK_WORKER: 'separate',
      REDIS_URL: 'redis://127.0.0.1:1',
    })
    const worker = createContainer(env, 'worker')
    expect(worker.deps.probes.map((probe) => probe.name)).toEqual(['database'])
    await worker.close()
    // An API instance of the same deployment still checks both.
    const api = createContainer(env, 'api')
    expect(api.deps.probes.map((probe) => probe.name)).toEqual(['database', 'redis'])
    await api.close()
  })
})

describe('the mock OAuth provider', () => {
  // Review finding F5: nobody should be able to run with the mock on and not know.
  test('says loudly at boot that it is on, and says nothing when it is off', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const local = { ...base, ENVIRONMENT: 'local' }
      const off = createContainer(parseEnv(local))
      expect(off.deps.config.oauthMock).toBe(false)
      expect(warn).not.toHaveBeenCalled()
      await off.close()

      const on = createContainer(parseEnv({ ...local, OAUTH_MOCK_PROVIDER: 'true' }))
      expect(on.deps.config.oauthMock).toBe(true)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /OAUTH_MOCK_PROVIDER is on.*never.*outside local development/i
      )
      await on.close()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('a PUBLIC_URL no device-binding proof can name', () => {
  // Review round 3 of TULA-19: such a deployment still boots, and says once what it lost.
  test('boots, and warns once in words that name the variable and not its value', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const fine = createContainer(parseEnv({ ...base, PUBLIC_URL: 'http://tula_api:3003' }))
      expect(warn).not.toHaveBeenCalled()
      await fine.close()

      const api = createContainer(
        parseEnv({ ...base, PUBLIC_URL: 'https://canary-host.example/my api' })
      )
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /^PUBLIC_URL cannot be named by a device-binding proof.*unavailable on this deployment/
      )
      expect(JSON.stringify(warn.mock.calls)).not.toContain('canary-host')
      await api.close()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the SMS sender', () => {
  const local = { ...base, ENVIRONMENT: 'local' }
  const message = { to: '+14155550142', text: 'Your Acme verification code is 123456.' }

  test('without a provider every send is refused, there is no inbox and nothing is logged', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const info = spyOn(logger, 'info').mockImplementation(() => {})
    try {
      const { deps, close } = createContainer(parseEnv(local))
      expect(deps.smsInbox).toBeNull()
      expect(deps.sms.configured).toBe(false)
      let thrown: unknown
      try {
        await deps.sms.send(message)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(SmsSendError)
      expect((thrown as SmsSendError).reason).toBe('not_configured')
      // Never a log line in place of a message: it would hold the code.
      expect(warn).not.toHaveBeenCalled()
      expect(info).not.toHaveBeenCalled()
      await close()
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  test('the development inbox keeps what is sent, and says loudly at boot that it is on', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const { deps, close } = createContainer(parseEnv({ ...local, SMS_PROVIDER: 'dev' }))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(
        /SMS_PROVIDER is dev.*never.*outside local development/i
      )
      await deps.sms.send(message)
      expect(deps.smsInbox?.messages().map((sent) => sent.text)).toEqual([message.text])
      // The sender and the inbox are one object: what is sent is what is read.
      expect(deps.smsInbox as unknown).toBe(deps.sms)
      await close()
    } finally {
      warn.mockRestore()
    }
  })

  describe('Twilio', () => {
    const ACCOUNT = `AC${'0a1b2c3d'.repeat(4)}`
    const KEY = `SK${'9f8e7d6c'.repeat(4)}`
    const SERVICE = `MG${'1122aabb'.repeat(4)}`
    const SECRET = 'KeySecret-canary-Zq7Lm2Xw9Rt4Vb6Ny8Pd'
    const TOKEN = 'authtoken-canary-5f3a9c1e7b2d4f6a8c0e'
    const NUMBER = '+15005550006'
    const NOTHING_OF_THEM = /canary|AC0a1b|SK9f8e|MG1122|5005550006/
    const accepted = () =>
      Response.json({ sid: `SM${'abcdef01'.repeat(4)}`, status: 'queued' }, { status: 201 })
    const live = {
      ...base,
      ENVIRONMENT: 'prod',
      SMTP_URL: 'smtps://relay.example.com:465',
      MAIL_FROM: 'Example <no-reply@example.com>',
      BREACH_CHECK: 'hibp',
      PUBLIC_URL: 'https://auth.example.com',
      REDIS_URL: 'rediss://cache.example.com:6380',
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: ACCOUNT,
    }
    const ways: [
      string,
      Record<string, string>,
      string,
      [string, string],
      { authentication: string; sender: string },
    ][] = [
      [
        'an API key and a Messaging Service',
        {
          TWILIO_API_KEY_SID: KEY,
          TWILIO_API_KEY_SECRET: SECRET,
          TWILIO_MESSAGING_SERVICE_SID: SERVICE,
        },
        btoa(`${KEY}:${SECRET}`),
        ['MessagingServiceSid', SERVICE],
        { authentication: 'api_key', sender: 'messaging_service' },
      ],
      [
        'the auth token and one number',
        { TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM_NUMBER: NUMBER },
        btoa(`${ACCOUNT}:${TOKEN}`),
        ['From', NUMBER],
        { authentication: 'auth_token', sender: 'number' },
      ],
    ]

    test.each(ways)(
      'SMS_PROVIDER=twilio sends through Twilio with %s',
      async (_name, variables, basic, field, said) => {
        const info = spyOn(logger, 'info').mockImplementation(() => {})
        const debug = spyOn(logger, 'debug').mockImplementation(() => {})
        // No request leaves this test: `fetch` is the stub.
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
          accepted()) as unknown as typeof fetch)
        try {
          const { deps, close } = createContainer(parseEnv({ ...live, ...variables }))
          // A real sender, and no inbox to read its messages from.
          expect(deps.sms.configured).toBe(true)
          expect(deps.smsInbox).toBeNull()
          // Said at boot: which way, never a value.
          expect(info.mock.calls).toEqual([
            ['SMS_PROVIDER is twilio: text messages are sent through Twilio', said],
          ])
          // Building the container sends nothing and asks Twilio nothing.
          expect(fetchSpy).not.toHaveBeenCalled()

          await deps.sms.send(message)
          expect(fetchSpy).toHaveBeenCalledTimes(1)
          const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
          expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`)
          expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${basic}`)
          const form = new URLSearchParams(String(init.body))
          expect(form.get(field[0])).toBe(field[1])
          expect(form.get('To')).toBe(message.to)
          expect(form.get('Body')).toBe(message.text)

          // The credentials are the adapter's alone: nothing of them is in the dependencies.
          const visible = Bun.inspect(deps, { depth: 6 })
          for (const secret of [SECRET, TOKEN, basic]) {
            expect(visible).not.toContain(secret)
          }
          expect(JSON.stringify(info.mock.calls)).not.toMatch(NOTHING_OF_THEM)
          await close()
        } finally {
          fetchSpy.mockRestore()
          info.mockRestore()
          debug.mockRestore()
        }
      }
    )

    // Behind `env.ts`, as for the inbox: an environment object that did not come through
    // `parseEnv` gets no sender built from half a configuration, or from a choice of two.
    const incomplete: [string, Record<string, string>][] = [
      [
        'no account',
        { TWILIO_API_KEY_SID: KEY, TWILIO_API_KEY_SECRET: SECRET, TWILIO_FROM_NUMBER: NUMBER },
      ],
      ['no credentials', { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_FROM_NUMBER: NUMBER }],
      [
        'half an API key',
        { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_API_KEY_SID: KEY, TWILIO_FROM_NUMBER: NUMBER },
      ],
      [
        'both ways to authenticate',
        {
          TWILIO_ACCOUNT_SID: ACCOUNT,
          TWILIO_API_KEY_SID: KEY,
          TWILIO_API_KEY_SECRET: SECRET,
          TWILIO_AUTH_TOKEN: TOKEN,
          TWILIO_FROM_NUMBER: NUMBER,
        },
      ],
      ['no sender', { TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN }],
      [
        'both senders',
        {
          TWILIO_ACCOUNT_SID: ACCOUNT,
          TWILIO_AUTH_TOKEN: TOKEN,
          TWILIO_MESSAGING_SERVICE_SID: SERVICE,
          TWILIO_FROM_NUMBER: NUMBER,
        },
      ],
    ]

    test.each(incomplete)(
      'refuses to build a sender with %s, and says no value',
      (_name, variables) => {
        const info = spyOn(logger, 'info').mockImplementation(() => {})
        try {
          const env = { ...parseEnv(local), SMS_PROVIDER: 'twilio' as const, ...variables }
          let thrown: unknown
          try {
            createContainer(env)
          } catch (error) {
            thrown = error
          }
          expect(thrown).toBeInstanceOf(Error)
          expect(String(thrown)).toMatch(/SMS_PROVIDER is twilio/)
          expect(String(thrown)).not.toMatch(NOTHING_OF_THEM)
          expect(info).not.toHaveBeenCalled()
        } finally {
          info.mockRestore()
        }
      }
    )

    test('with another provider the Twilio variables build nothing', async () => {
      const info = spyOn(logger, 'info').mockImplementation(() => {})
      try {
        const { deps, close } = createContainer(
          parseEnv({
            ...local,
            TWILIO_ACCOUNT_SID: ACCOUNT,
            TWILIO_AUTH_TOKEN: TOKEN,
            TWILIO_FROM_NUMBER: NUMBER,
          })
        )
        expect(deps.sms.configured).toBe(false)
        expect(info).not.toHaveBeenCalled()
        await close()
      } finally {
        info.mockRestore()
      }
    })
  })

  // The tier is checked again in the container, behind `env.ts`: an environment object that
  // did not come through `parseEnv` must not get an inbox either.
  test.each(['dev', 'staging', 'prod'] as const)(
    'no inbox in %s, whatever the variable says',
    async (tier) => {
      const warn = spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        const env = { ...parseEnv(local), ENVIRONMENT: tier, SMS_PROVIDER: 'dev' as const }
        const { deps, close } = createContainer(env)
        expect(deps.smsInbox).toBeNull()
        await expect(deps.sms.send(message)).rejects.toBeInstanceOf(SmsSendError)
        await close()
      } finally {
        warn.mockRestore()
      }
    }
  )
})

describe('the instance admin token', () => {
  test('is kept as its SHA-256 only, and the diagnostics probes are wired', async () => {
    const token = 'k3Zr8vQ1nP5xW7bT2mY9cF4hJ6dL0sAg'
    const { deps, close } = createContainer(parseEnv({ ...base, TULA_ADMIN_TOKEN: token }))
    expect(deps.config.instanceAdminTokenHash).toBe(
      new Bun.CryptoHasher('sha256').update(token).digest('hex')
    )
    expect(JSON.stringify(deps.config)).not.toContain(token)
    // No Redis in this environment: nothing to ping.
    expect(deps.diagnostics.redis).toBeNull()
    expect(deps.diagnostics.shippedMigrations.length).toBeGreaterThan(10)
    await close()
  })
})
