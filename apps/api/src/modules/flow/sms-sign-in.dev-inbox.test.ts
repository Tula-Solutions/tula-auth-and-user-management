import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type FlowAttempt } from '@tula/contract'
import { DevSmsSender } from '~/adapters/sms/dev'
import type { Deps } from '~/dependencies'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Audit from '~/modules/audit/service'
import * as Sms from '~/modules/sms/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// A texted sign-in code and the development inbox (ADR 0037, TULA-71).
//
// A sign-in's message is handed to the sender and not waited for, and its token is stored
// only after the sender took it. The development sender "takes" a message by keeping it
// where `GET /v1/dev/sms/messages` reads it. So a tool that polls the inbox (the
// conformance runner against a live server) could read a code and present it before a
// token stood behind it: the right code, answered `auth.invalid_credentials`. These hold
// that a code the inbox shows is a code that can be used, over the routes a tool calls.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const ORIGIN = 'https://app.northline.test'
const SCOPE = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const NUMBER = '+14155550142'
const UNKNOWN = '+14155550177'
const USER = '0198c0de-0000-7000-8000-000000000071'

let deps: TestDeps
let inbox: DevSmsSender
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
  deps.clock.set(new Date('2026-10-08T09:00:00.000Z'))
  deps.environments.add({
    id: SCOPE.environmentId,
    projectId: SCOPE.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  deps.environmentSettings.seed(SCOPE.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: {
          ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods,
          smsCode: { enabled: true },
        },
      },
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      sms: { enabled: true, allowedCountries: ['US'], dailyMessageLimit: 500, templates: {} },
    },
  })
  const now = deps.clock.now()
  await deps.users.create(
    {
      id: USER,
      projectId: SCOPE.projectId,
      environmentId: SCOPE.environmentId,
      email: 'maya@northline.app',
      emailNormalized: 'maya@northline.app',
      emailVerifiedAt: now,
      firstName: null,
      lastName: null,
      createdAt: now,
      identityId: `${USER}-identity`,
      credentialId: `${USER}-credential`,
      passwordHash: null,
    } as Parameters<typeof deps.users.create>[0],
    Audit.none('fixture')
  )
  await deps.users.setPhoneNumber(
    SCOPE.environmentId,
    USER,
    NUMBER,
    now,
    Audit.none('fixture'),
    Audit.none('fixture')
  )
  // The deployment as `SMS_PROVIDER=dev` builds it: the development sender, and its inbox
  // route. Everything else is the memory adapters.
  inbox = new DevSmsSender(deps.clock)
  app = createApp({ ...deps, sms: inbox, smsInbox: inbox } as Deps)
})

const post = (path: string, body: unknown, secret?: string) =>
  app.request(`/v1/client${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tula-client': 'ios',
      'x-tula-publishable-key': PK,
      origin: ORIGIN,
      ...(secret !== undefined && { 'x-tula-attempt': secret }),
    },
    body: JSON.stringify(body),
  })

async function start(identifier: string): Promise<FlowAttempt> {
  const res = await post('/sign-ins', { identifier })
  expect(res.status).toBe(200)
  return (await res.json()) as FlowAttempt
}

async function prepare(attempt: FlowAttempt): Promise<void> {
  const res = await post(
    `/sign-ins/${attempt.id}/first-factor/prepare`,
    { strategy: 'sms_code' },
    attempt.attemptSecret
  )
  expect(res.status).toBe(200)
}

const submit = (attempt: FlowAttempt, code: string) =>
  post(
    `/sign-ins/${attempt.id}/first-factor/attempt`,
    { strategy: 'sms_code', code },
    attempt.attemptSecret
  )

/** The codes a tool on this machine reads from the inbox route for a number, oldest first. */
async function readable(to: string = NUMBER): Promise<string[]> {
  const res = await app.request(`/v1/dev/sms/messages?to=${encodeURIComponent(to)}`, {
    headers: { host: 'localhost:3003' },
  })
  expect(res.status).toBe(200)
  const { messages } = (await res.json()) as { messages: { text: string }[] }
  return messages.map(({ text }) => /code is (\d{6})\./.exec(text)?.[1] ?? '')
}

/**
 * Hold the write of a code's token where the detached work makes it, as a slow database
 * does on a live server.
 *
 * @returns `reached` resolves once the write was asked for (the sender has taken the
 *   message by then); `release` lets it go through, or fail.
 */
function holdTokenWrite() {
  const real = deps.verificationTokens.replace.bind(deps.verificationTokens)
  let reach = () => {}
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  let release: (outcome?: 'fail') => void = () => {}
  const held = new Promise<'fail' | undefined>((resolve) => {
    release = resolve
  })
  const spy = spyOn(deps.verificationTokens, 'replace').mockImplementation(async (...args) => {
    reach()
    if ((await held) === 'fail') {
      throw new Error(`the store is down for ${NUMBER}`)
    }
    return real(...args)
  })
  return {
    reached,
    release,
    /** Let a write still held go through, wait for it, and put the store back. */
    restore: async () => {
      release()
      await Sms.settled()
      spy.mockRestore()
    },
  }
}

describe('a texted sign-in code and the development inbox', () => {
  test('a code is not readable in the inbox before its token is stored', async () => {
    const write = holdTokenWrite()
    try {
      const attempt = await start(NUMBER)
      await prepare(attempt)
      // The sender has taken the message; the token's write is under way and not done.
      await write.reached
      // What a tool that polls the inbox sees in that gap: nothing to present yet.
      // (Before the message was held back it was readable here, and presenting its code
      // was answered 401 `auth.invalid_credentials`.)
      expect(await readable()).toEqual([])

      write.release()
      await Sms.settled()
      const codes = await readable()
      expect(codes).toHaveLength(1)
      // Readable means usable: the code the inbox shows signs in.
      const res = await submit(attempt, codes[0] as string)
      expect(res.status).toBe(200)
      expect(((await res.json()) as FlowAttempt).step.status).toBe('complete')
    } finally {
      await write.restore()
    }
  })

  test('a code whose token could not be stored never becomes readable', async () => {
    const write = holdTokenWrite()
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
    try {
      const attempt = await start(NUMBER)
      await prepare(attempt)
      await write.reached
      write.release('fail')
      await Sms.settled()
      // One more turn of the loop, for anything that would still show the message.
      await new Promise((resolve) => setTimeout(resolve, 0))
      // Nothing to read: a tool waits for a code and gives up, where it would otherwise
      // present the right code and be told the credentials are wrong.
      expect(await readable()).toEqual([])
      // Said where it always was, with fixed words.
      expect(warn.mock.calls.filter(([line]) => line === 'texted code not stored')).toHaveLength(1)
    } finally {
      warn.mockRestore()
      await write.restore()
    }
  })

  test('a number nobody signs in with is texted nothing, before and after its token', async () => {
    const write = holdTokenWrite()
    try {
      const attempt = await start(UNKNOWN)
      await prepare(attempt)
      await write.reached
      expect(await readable(UNKNOWN)).toEqual([])
      write.release()
      await Sms.settled()
      expect(await readable(UNKNOWN)).toEqual([])
      expect(inbox.messages()).toEqual([])
    } finally {
      await write.restore()
    }
  })

  test('a code whose send is waited for is readable when the request is answered', async () => {
    // A phone number's own code (`POST /v1/client/me/phone`) and a second factor's are sent
    // and waited for, and stored before the answer: nothing holds them back.
    await Sms.sendCode({ ...deps, sms: inbox } as Deps, SCOPE, {
      kind: 'phone_verification',
      to: NUMBER,
      code: '739204',
      asker: { type: 'user', id: USER },
      newNumber: true,
      address: null,
    })
    expect(inbox.messages(NUMBER).map(({ text }) => /(\d{6})\./.exec(text)?.[1])).toEqual([
      '739204',
    ])
  })
})
