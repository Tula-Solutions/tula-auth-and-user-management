import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { RateLimitError, ServiceException } from '~/exceptions'
import { sha256Hex } from '~/lib/crypto'
import * as Verification from '~/modules/verification/service'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

type Scope = { projectId: string; environmentId: string }
const tenant: Scope = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
}
const otherTenant: Scope = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const FLOW = '00000000-0000-7000-8000-00000000f001'
const subject = { flowAttemptId: FLOW }
const EMAIL = 'Maya@Northline.app'
let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
})

function issue(overrides: Partial<Verification.IssueInput> = {}) {
  return Verification.issue(deps, tenant, {
    purpose: 'email_verification',
    destination: EMAIL,
    flowAttemptId: FLOW,
    ...overrides,
  })
}

/** The 6-digit code in the most recent email. */
function sentCode(): string {
  const code = /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1]
  if (!code) {
    throw new Error('no code in the last email')
  }
  return code
}

const wrong = (code: string) => (code === '000000' ? '000001' : '000000')

function verify(code: string, overrides: Partial<Verification.VerifyCodeInput> = {}) {
  return Verification.verifyCode(deps, tenant, {
    purpose: 'email_verification',
    subject,
    code,
    ...overrides,
  })
}

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

describe('issue', () => {
  test('emails a 6-digit code and returns only the masked destination and expiry', async () => {
    const issued = await issue()
    expect(issued).toEqual({
      id: expect.any(String),
      destination: 'M***@Northline.app',
      expiresAt: new Date(deps.clock.now().getTime() + 10 * 60_000),
    })
    const mail = deps.mailer.last()
    expect(mail.to).toBe(EMAIL)
    expect(mail.text).toMatch(/\b\d{6}\b/)
    expect(mail.html).toContain(sentCode())
    expect(JSON.stringify(issued)).not.toContain(sentCode())
  })

  test('stores the code only as an HMAC bound to the token id, and the normalized email', async () => {
    const { id } = await issue()
    const code = sentCode()
    const stored = await deps.verificationTokens.findLatest(
      tenant.environmentId,
      'email_verification',
      subject
    )
    expect(stored?.destination).toBe('maya@northline.app')
    expect(stored?.codeHash).toBe(
      await deps.keyedHash.hmac(Verification.KEYED_HASH_PURPOSE, `${id}:${code}`)
    )
    expect(stored?.codeHash).not.toBe(sha256Hex(code))
    expect(JSON.stringify(stored)).not.toContain(code)
    expect(stored?.linkTokenHash).toBeNull()
    expect(stored?.maxAttempts).toBe(Verification.MAX_ATTEMPTS)
  })

  test('adds a magic link only when the caller supplies a URL builder, storing its SHA-256', async () => {
    await issue({ linkUrl: (token) => `https://auth.test/verify/${token}` })
    const mail = deps.mailer.last()
    const token = /https:\/\/auth\.test\/verify\/([\w-]+)/.exec(mail.text)?.[1]
    expect(token?.length).toBe(43)
    expect(mail.html).toContain(`https://auth.test/verify/${token}`)
    const stored = await deps.verificationTokens.findLatest(
      tenant.environmentId,
      'email_verification',
      subject
    )
    expect(stored?.linkTokenHash).toBe(sha256Hex(token ?? ''))
  })

  test('a new code replaces the previous one', async () => {
    await issue()
    const first = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    await issue()
    const second = sentCode()
    if (first !== second) {
      expect((await rejection(verify(first))).code).toBe('verification.invalid_code')
    }
    expect((await verify(second)).destination).toBe('maya@northline.app')
  })

  test('limits sends per destination: one per cooldown, a few per hour', async () => {
    await issue()
    expect(await issue().catch((err) => err)).toBeInstanceOf(RateLimitError)
    // Case and whitespace variants are the same mailbox.
    expect(await issue({ destination: ' maya@northline.APP ' }).catch((e) => e)).toBeInstanceOf(
      RateLimitError
    )
    for (let sent = 1; sent < Verification.SENDS_PER_HOUR; sent++) {
      deps.clock.advance(Verification.RESEND_COOLDOWN)
      await issue()
    }
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    expect(await issue().catch((err) => err)).toBeInstanceOf(RateLimitError)
    expect(deps.mailer.outbox).toHaveLength(Verification.SENDS_PER_HOUR)
  })

  test('send limits are per destination and per environment', async () => {
    await issue()
    await issue({ destination: 'someone-else@northline.app' })
    await Verification.issue(deps, otherTenant, {
      purpose: 'email_verification',
      destination: EMAIL,
      flowAttemptId: FLOW,
    })
    expect(deps.mailer.outbox).toHaveLength(3)
  })

  test('a relay failure surfaces as an internal error that names neither code nor address', async () => {
    deps.mailer.failing = true
    const err = await rejection(issue())
    expect(err.status).toBe(500)
    expect(err.code).toBe('internal')
    expect(JSON.stringify(err.toJSON())).not.toContain('northline')
  })

  test('a relay error that quotes the recipient never reaches the logs or the response', async () => {
    const relayError = Object.assign(
      new Error(`550 5.1.1 <${EMAIL}>: Recipient address rejected`),
      {
        code: 'EENVELOPE',
        responseCode: 550,
      }
    )
    deps.mailer.send = async () => {
      throw relayError
    }
    const err = await rejection(issue())
    // handlers.ts logs `internalMessage` and the cause's message and stack for 5xx errors.
    const logged = JSON.stringify([err.internalMessage, (err.cause as Error | undefined)?.message])
    expect(logged.toLowerCase()).not.toContain('northline')
    expect(err.internalMessage).toContain('EENVELOPE')
    expect(err.internalMessage).toContain('550')
  })

  test('a failed send leaves the previous code working', async () => {
    await issue()
    const first = sentCode()
    deps.clock.advance(Verification.RESEND_COOLDOWN)
    deps.mailer.failing = true
    await rejection(issue())
    expect((await verify(first)).flowAttemptId).toBe(FLOW)
  })

  test('when two sends for one subject overlap, the one stored last is the one that works', async () => {
    const codeFor = (to: string) => {
      const mail = deps.mailer.outbox.find((message) => message.to === to)
      return /\b(\d{6})\b/.exec(mail?.text ?? '')?.[1] ?? ''
    }
    // The first send hangs in the relay while a second issue starts and finishes.
    let release = () => {}
    const relaySlow = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = deps.mailer.send.bind(deps.mailer)
    let calls = 0
    deps.mailer.send = async (message) => {
      calls += 1
      if (calls === 1) {
        await relaySlow
      }
      await send(message)
    }

    const slow = issue({ destination: 'slow@northline.app' })
    deps.clock.advance(1_000)
    await issue({ destination: 'fast@northline.app' })
    deps.clock.advance(1_000)
    release()
    await slow

    expect((await verify(codeFor('slow@northline.app'))).destination).toBe('slow@northline.app')
    const fast = codeFor('fast@northline.app')
    if (fast !== codeFor('slow@northline.app')) {
      expect((await rejection(verify(fast))).code).toBe('verification.expired')
    }
  })

  test('a custom delivery replaces the code email but keeps the token and the send limits', async () => {
    const delivered: Verification.Delivery[] = []
    await issue({
      deliver: async (delivery) => {
        delivered.push(delivery)
      },
    })
    expect(deps.mailer.outbox).toHaveLength(0)
    expect(delivered).toEqual([
      { to: EMAIL, code: expect.stringMatching(/^\d{6}$/), linkUrl: undefined, ttlMinutes: 10 },
    ])
    // The token is real: the code it was given verifies, and the cooldown was charged.
    expect((await verify(delivered[0]?.code ?? '')).flowAttemptId).toBe(FLOW)
    expect(await issue().catch((err) => err)).toBeInstanceOf(RateLimitError)
  })

  test('onAllowed runs only when the send limits allow the email, and can refuse it', async () => {
    let calls = 0
    const onAllowed = async () => {
      calls += 1
    }
    await issue({ onAllowed })
    expect(await issue({ onAllowed }).catch((err) => err)).toBeInstanceOf(RateLimitError)
    expect(calls).toBe(1)

    deps.clock.advance(Verification.RESEND_COOLDOWN)
    const refusal = new RateLimitError(5_000)
    expect(
      await issue({
        onAllowed: async () => {
          throw refusal
        },
      }).catch((err) => err)
    ).toBe(refusal)
    expect(deps.mailer.outbox).toHaveLength(1)
  })

  test('requires a flow attempt or a user', async () => {
    const err = await rejection(issue({ flowAttemptId: undefined }))
    expect(err.status).toBe(500)
    expect(deps.mailer.outbox).toHaveLength(0)
  })

  test('can be issued for a user instead of a flow attempt', async () => {
    const userId = '00000000-0000-7000-8000-0000000000a1'
    await issue({ purpose: 'password_reset', flowAttemptId: undefined, userId })
    const token = await verify(sentCode(), { purpose: 'password_reset', subject: { userId } })
    expect(token.userId).toBe(userId)
    expect(deps.mailer.last().subject.toLowerCase()).toContain('reset')
  })
})

describe('verifyCode', () => {
  test('accepts the emailed code once', async () => {
    const { id } = await issue()
    const code = sentCode()
    const token = await verify(code)
    expect(token).toMatchObject({ id, flowAttemptId: FLOW, destination: 'maya@northline.app' })
    expect(token.consumedAt).toEqual(deps.clock.now())
    expect((await rejection(verify(code))).code).toBe('verification.expired')
  })

  test('a wrong code is counted and reports how many attempts remain', async () => {
    await issue()
    const err = await rejection(verify(wrong(sentCode())))
    expect(err.status).toBe(422)
    expect(err.code).toBe('verification.invalid_code')
    expect(err.params).toEqual({ attemptsRemaining: Verification.MAX_ATTEMPTS - 1 })
  })

  test('the right code still works on the last allowed attempt', async () => {
    await issue()
    const code = sentCode()
    for (let i = 0; i < Verification.MAX_ATTEMPTS - 1; i++) {
      await rejection(verify(wrong(code)))
    }
    expect((await verify(code)).flowAttemptId).toBe(FLOW)
  })

  test('after the attempts are used up even the right code is refused', async () => {
    await issue()
    const code = sentCode()
    let last: ServiceException | undefined
    for (let i = 0; i < Verification.MAX_ATTEMPTS; i++) {
      last = await rejection(verify(wrong(code)))
    }
    expect(last?.params).toEqual({ attemptsRemaining: 0 })
    const err = await rejection(verify(code))
    expect(err.status).toBe(429)
    expect(err.code).toBe('verification.too_many_attempts')
  })

  test('concurrent guesses cannot exceed the attempt limit between them', async () => {
    await issue()
    const bad = wrong(sentCode())
    const results = await Promise.all(Array.from({ length: 12 }, () => rejection(verify(bad))))
    const counted = results.filter((err) => err.code === 'verification.invalid_code')
    expect(counted).toHaveLength(Verification.MAX_ATTEMPTS)
    expect(results.filter((err) => err.code === 'verification.too_many_attempts')).toHaveLength(
      12 - Verification.MAX_ATTEMPTS
    )
  })

  test('expires exactly at the TTL', async () => {
    await issue()
    const code = sentCode()
    deps.clock.advance(10 * 60_000 - 1)
    // One millisecond before expiry a wrong code is still just "wrong".
    expect((await rejection(verify(wrong(code)))).code).toBe('verification.invalid_code')
    deps.clock.advance(1)
    const err = await rejection(verify(code))
    expect(err.status).toBe(410)
    expect(err.code).toBe('verification.expired')
  })

  test.each([
    ['another environment', () => Verification.verifyCode(deps, otherTenant, input())],
    [
      'another flow attempt',
      () =>
        verify(sentCode(), { subject: { flowAttemptId: '00000000-0000-7000-8000-00000000f002' } }),
    ],
    ['another purpose', () => verify(sentCode(), { purpose: 'password_reset' })],
  ])('a code cannot be used from %s', async (_name, attempt) => {
    await issue()
    expect((await rejection(attempt())).code).toBe('verification.expired')
    // The real token was not touched by the foreign attempt.
    expect((await verify(sentCode())).flowAttemptId).toBe(FLOW)
  })

  test('reports expired when nothing was ever issued', async () => {
    expect((await rejection(verify('123456'))).code).toBe('verification.expired')
  })
})

function input(): Verification.VerifyCodeInput {
  return { purpose: 'email_verification', subject, code: sentCode() }
}

describe('verifyLink', () => {
  async function issueLink(): Promise<string> {
    await issue({ linkUrl: (token) => `https://auth.test/verify/${token}` })
    const token = /verify\/([\w-]+)/.exec(deps.mailer.last().text)?.[1]
    if (!token) {
      throw new Error('no link in the last email')
    }
    return token
  }
  const open = (linkToken: string, t = tenant) =>
    Verification.verifyLink(deps, t, { purpose: 'email_verification', linkToken })

  test('accepts the emailed link once, and the code stops working too', async () => {
    const linkToken = await issueLink()
    const code = sentCode()
    const token = await open(linkToken)
    expect(token).toMatchObject({ flowAttemptId: FLOW, destination: 'maya@northline.app' })
    expect((await rejection(open(linkToken))).code).toBe('verification.expired')
    expect((await rejection(verify(code))).code).toBe('verification.expired')
  })

  test('a link stops working once the code was used', async () => {
    const linkToken = await issueLink()
    await verify(sentCode())
    expect((await rejection(open(linkToken))).code).toBe('verification.expired')
  })

  test('a link from a token that is no longer the newest is refused even if unconsumed', async () => {
    // Two concurrent issues can both commit before either consumes the other's token.
    const linkToken = await issueLink()
    const stale = await deps.verificationTokens.findByLinkHash(
      tenant.environmentId,
      sha256Hex(linkToken)
    )
    if (!stale) {
      throw new Error('token not stored')
    }
    const store = deps.verificationTokens
    const raced = {
      ...deps,
      verificationTokens: {
        replace: store.replace.bind(store),
        findByLinkHash: store.findByLinkHash.bind(store),
        recordAttempt: store.recordAttempt.bind(store),
        consume: store.consume.bind(store),
        findLatest: async () => ({ ...stale, id: '00000000-0000-7000-8000-0000000000ff' }),
      },
    }
    const err = await rejection(
      Verification.verifyLink(raced, tenant, { purpose: 'email_verification', linkToken })
    )
    expect(err.code).toBe('verification.expired')
    // It was refused before being consumed.
    expect(
      (await store.findByLinkHash(tenant.environmentId, sha256Hex(linkToken)))?.consumedAt
    ).toBeNull()
  })

  test('rejects unknown, expired, foreign-environment and wrong-purpose links alike', async () => {
    const linkToken = await issueLink()
    expect((await rejection(open('not-a-real-token'))).code).toBe('verification.expired')
    expect((await rejection(open(linkToken, otherTenant))).code).toBe('verification.expired')
    expect(
      (
        await rejection(
          Verification.verifyLink(deps, tenant, { purpose: 'password_reset', linkToken })
        )
      ).code
    ).toBe('verification.expired')
    deps.clock.advance('10m')
    expect((await rejection(open(linkToken))).code).toBe('verification.expired')
  })
})

describe('code comparison', () => {
  test('goes through the constant-time comparison, for right and wrong codes alike', async () => {
    const crypto = await import('~/lib/crypto')
    const compared = spyOn(crypto, 'timingSafeEqual')
    try {
      await issue()
      const code = sentCode()
      expect((await rejection(verify(wrong(code)))).code).toBe('verification.invalid_code')
      await verify(code)
      expect(compared).toHaveBeenCalledTimes(2)
    } finally {
      compared.mockRestore()
    }
  })
})
