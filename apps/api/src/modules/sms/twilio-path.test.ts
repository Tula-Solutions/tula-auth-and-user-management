import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ClientConfigSchema, DEFAULT_ENVIRONMENT_SETTINGS } from '@tula/contract'
import { createTwilioSmsSender } from '~/adapters/sms/twilio'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Sms from '~/modules/sms/service'
import { codeText } from '~/modules/sms/templates'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// TULA-29: the Twilio sender in the place of the memory one, behind the one send path and
// the client configuration. `fetch` is stubbed in every test: nothing here reaches Twilio.

const PK = 'tula_pk_dev_publishable0000000000000000000000000'
const ACCOUNT = `AC${'0a1b2c3d'.repeat(4)}`
const SECRET = 'KeySecret-canary-Zq7Lm2Xw9Rt4Vb6Ny8Pd'
const TO = '+14155550142'
const CODE = '482913'
const TODAY = '2026-10-08'
const SCOPE = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
let answer: () => Response
const spies: { mockRestore: () => void }[] = []

function settings(sms: { enabled: boolean; allowedCountries: string[] }) {
  deps.environmentSettings.seed(SCOPE.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      app: { ...DEFAULT_ENVIRONMENT_SETTINGS.app, name: 'Zürich Café' },
      urls: { ...DEFAULT_ENVIRONMENT_SETTINGS.urls, allowedOrigins: ['https://app.example.com'] },
      sms: { ...sms, dailyMessageLimit: 500 },
    },
  })
}

beforeEach(() => {
  deps = createTestDeps()
  deps.clock.set(new Date(`${TODAY}T09:00:00.000Z`))
  deps.environments.add({
    id: SCOPE.environmentId,
    projectId: SCOPE.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  // The real adapter where the tests' memory sender was.
  Object.assign(deps, {
    sms: createTwilioSmsSender({
      accountSid: ACCOUNT,
      credentials: { kind: 'api_key', sid: `SK${'9f8e7d6c'.repeat(4)}`, secret: SECRET },
      sender: { kind: 'messaging_service', sid: `MG${'1122aabb'.repeat(4)}` },
    }),
  })
  settings({ enabled: true, allowedCountries: ['US'] })
  answer = () => Response.json({ sid: `SM${'abcdef01'.repeat(4)}` }, { status: 201 })
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
    answer()) as unknown as typeof fetch)
  spies.push(spyOn(logger, 'debug').mockImplementation(() => {}))
})

afterEach(() => {
  fetchSpy.mockRestore()
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

const message = (): Sms.CodeMessage => ({
  to: TO,
  code: CODE,
  asker: { type: 'user', id: 'user-1' },
  newNumber: true,
  address: '198.51.100.7',
})

describe('GET /v1/client/config with the Twilio sender', () => {
  async function phone(): Promise<{ enabled: boolean } | undefined> {
    await seedApiKey(deps, PK)
    const res = await createApp(deps).request('/v1/client/config', {
      headers: { 'x-tula-publishable-key': PK },
    })
    expect(res.status).toBe(200)
    return ClientConfigSchema.parse(await res.json()).phone
  }

  test('a phone number can be added where text messages are on, as with the development inbox', async () => {
    expect(await phone()).toEqual({ enabled: true })
    // Answering what a screen may offer asks Twilio nothing.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test.each([
    ['switched off', { enabled: false, allowedCountries: ['US'] }],
    ['on with no country', { enabled: true, allowedCountries: [] }],
  ])('and not where they are %s', async (_name, sms) => {
    settings(sms)
    expect(await phone()).toEqual({ enabled: false })
  })
})

describe('Sms.sendCode through Twilio', () => {
  test('what Twilio is handed is the template’s text, to the number, unchanged', async () => {
    await Sms.sendCode(deps, SCOPE, message())
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const form = new URLSearchParams(String(init.body))
    const text = codeText({
      appName: 'Zürich Café',
      allowedOrigins: ['https://app.example.com'],
      code: CODE,
    })
    expect(form.get('Body')).toBe(text)
    // The name that is not ASCII, the blank line and the origin-bound last line all arrive.
    expect(text).toBe(`Your Zürich Café verification code is ${CODE}.\n\n@app.example.com #${CODE}`)
    expect(form.get('To')).toBe(TO)
    expect(await deps.smsUsage.sentOn(SCOPE.environmentId, TODAY)).toBe(1)
  })

  test('a message Twilio refuses is sms.unavailable, is counted back out of the day and is not tried again', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(warn)
    answer = () =>
      Response.json(
        {
          code: 21608,
          message: `The number ${TO} is unverified. canary-in-the-answer`,
          status: 400,
        },
        { status: 400, headers: { 'x-canary': 'canary-in-a-header' } }
      )
    const failure = await Sms.sendCode(deps, SCOPE, message()).catch((error) => error)
    // The fixed, generic error: its code, and nothing of Twilio's answer or of the number.
    expect(failure).toMatchObject({ code: 'sms.unavailable', status: 503 })
    const thrown = [String(failure), failure.stack, JSON.stringify(failure)].join('\n')
    for (const part of ['canary', TO, '4155550142', CODE, SECRET, ACCOUNT, '21608', 'unverified']) {
      expect(thrown).not.toContain(part)
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await deps.smsUsage.sentOn(SCOPE.environmentId, TODAY)).toBe(0)

    // Two lines: the adapter's, with Twilio's own words masked, and the send path's, with
    // the environment and the fixed word.
    expect(warn.mock.calls).toEqual([
      [
        'twilio did not take a text message',
        {
          reason: 'refused',
          status: 400,
          twilioCode: 21608,
          twilioMessage: 'The number [redacted] is unverified. canary-in-the-answer',
        },
      ],
      ['text message not sent', { environmentId: SCOPE.environmentId, reason: 'failed' }],
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('canary-in-a-header')
  })

  // What the day's count is held to rests on this: only an answer that refuses gives a
  // message back. A 4xx is one; a 5xx is Twilio failing, and may follow a message it took.
  test.each([
    [400, 'failed', 0],
    [429, 'failed', 0],
    [503, 'unconfirmed', 1],
    [502, 'unconfirmed', 1],
  ] as const)(
    'after a %d the send is %s and the day’s count is %d',
    async (status, reason, counted) => {
      const warn = spyOn(logger, 'warn').mockImplementation(() => {})
      spies.push(warn)
      answer = () => Response.json({ code: 20000 + status, message: 'no', status }, { status })
      const failure = await Sms.sendCode(deps, SCOPE, message()).catch((error) => error)
      // The same answer to the caller either way.
      expect(failure).toMatchObject({ code: 'sms.unavailable', status: 503 })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(await deps.smsUsage.sentOn(SCOPE.environmentId, TODAY)).toBe(counted)
      expect(warn.mock.calls.at(-1)).toEqual([
        'text message not sent',
        {
          environmentId: SCOPE.environmentId,
          reason,
          ...(reason === 'unconfirmed' && { count: 'kept' }),
        },
      ])
    }
  )

  test('a number the settings do not allow never reaches Twilio', async () => {
    const refused = await Sms.sendCode(deps, SCOPE, { ...message(), to: '+4915112345678' }).catch(
      (error) => error
    )
    expect(refused).toMatchObject({ code: 'sms.country_not_allowed' })
    settings({ enabled: false, allowedCountries: ['US'] })
    expect(await Sms.sendCode(deps, SCOPE, message()).catch((error) => error)).toMatchObject({
      code: 'sms.disabled',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('a limit that refuses a message sends nothing to Twilio', async () => {
    const info = spyOn(logger, 'info').mockImplementation(() => {})
    spies.push(info)
    await Sms.sendCode(deps, SCOPE, message())
    // The asker's minute: the second try is refused before the sender is reached.
    expect(await Sms.sendCode(deps, SCOPE, message()).catch((error) => error)).toMatchObject({
      code: 'rate_limited',
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
