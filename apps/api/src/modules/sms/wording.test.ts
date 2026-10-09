import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  readStoredEnvironmentSettings,
  SMS_TEMPLATE_KINDS,
  type SmsTemplateKind,
} from '@tula/contract'
import * as logger from '~/lib/logger'
import * as Sms from '~/modules/sms/service'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

// An environment's own wording of a text message (ADR 0042), through the one path a message
// takes. A template changes the sentence and nothing else: who is sent what, and what is
// counted, is `service.test.ts`'s and must read the same with a template saved.

const SCOPE = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const OTHER = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const CODE = '482913'
const CANARY = 'Wording-canary-7d1e'
const ORIGIN = 'https://app.northline.app'

let deps: TestDeps
let revision = 0
let serial = 0

function configure(
  templates: unknown,
  environmentId: string = SCOPE.environmentId,
  more: Partial<EnvironmentSettings> = {}
) {
  revision += 1
  deps.environmentSettings.seed(environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      app: { name: 'Northline', supportEmail: null },
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      ...more,
      sms: {
        enabled: true,
        allowedCountries: ['US'],
        dailyMessageLimit: 500,
        // The memory store keeps what it is given, so that the service's own defence can
        // be tested with a template no save would accept.
        templates: templates as EnvironmentSettings['sms']['templates'],
      },
    },
  })
}

function message(kind: SmsTemplateKind = 'sign_in'): Sms.CodeMessage {
  serial += 1
  return {
    kind,
    to: `+1202555${String(1000 + serial)}`,
    code: CODE,
    asker: { type: 'user', id: `user-${serial}` },
    newNumber: false,
    address: `198.51.100.${serial % 250}`,
  }
}

beforeEach(() => {
  deps = createTestDeps()
  deps.clock.set(new Date('2026-10-08T09:00:00.000Z'))
})

describe('a text message in the environment’s own words', () => {
  test('each kind is sent with its own template, and the server’s line after it', async () => {
    configure({
      phone_verification: { text: 'Your {{appName}} number check: {{code}}' },
      sign_in: { text: 'Use {{code}} to sign in to {{appName}}.' },
    })
    await Sms.sendCode(deps, SCOPE, message('phone_verification'))
    expect(deps.sms.last().text).toBe(
      `Your Northline number check: ${CODE}\n\n@app.northline.app #${CODE}`
    )
    await Sms.sendCode(deps, SCOPE, message('sign_in'))
    expect(deps.sms.last().text).toBe(
      `Use ${CODE} to sign in to Northline.\n\n@app.northline.app #${CODE}`
    )
  })

  test('a kind with no template is the built-in text, beside one that has one', async () => {
    configure({ sign_in: { text: 'Use {{code}} to sign in.' } })
    await Sms.sendCode(deps, SCOPE, message('phone_verification'))
    expect(deps.sms.last().text).toBe(
      `Your Northline verification code is ${CODE}.\n\n@app.northline.app #${CODE}`
    )
  })

  test('every kind is the built-in text, byte for byte, when nothing is saved', async () => {
    configure({})
    for (const kind of SMS_TEMPLATE_KINDS) {
      await Sms.sendCode(deps, SCOPE, message(kind))
      expect(deps.sms.last().text).toBe(
        `Your Northline verification code is ${CODE}.\n\n@app.northline.app #${CODE}`
      )
    }
  })

  test('another environment’s template is never used', async () => {
    configure({ sign_in: { text: `${CANARY} {{code}}` } }, OTHER.environmentId)
    configure({})
    await Sms.sendCode(deps, SCOPE, message())
    expect(deps.sms.last().text).not.toContain(CANARY)
  })

  test('an inherited key is not a template', async () => {
    configure(Object.create({ sign_in: { text: `${CANARY} {{code}}` } }))
    await Sms.sendCode(deps, SCOPE, message())
    expect(deps.sms.last().text).not.toContain(CANARY)
  })

  test.each([
    ['one with no code', { text: `${CANARY} is on its way.` }, 'invalid'],
    [
      'one with a second code line',
      { text: `${CANARY} {{code}} @evil.example #999999` },
      'invalid',
    ],
    ['one with a link', { text: `${CANARY} {{code}} https://evil.example` }, 'invalid'],
    ['one that is no template', CANARY, 'invalid'],
  ])(
    'a stored template that no longer passes (%s) is not sent, and the send does not fail',
    async (_name, stored, reason) => {
      configure({ sign_in: stored })
      const warn = spyOn(logger, 'warn').mockImplementation(() => {})
      try {
        await Sms.sendCode(deps, SCOPE, message())
        expect(deps.sms.last().text).toBe(
          `Your Northline verification code is ${CODE}.\n\n@app.northline.app #${CODE}`
        )
        expect(warn.mock.calls).toEqual([
          [
            'text message template not used: the built-in text was sent',
            { environmentId: SCOPE.environmentId, kind: 'sign_in', reason },
          ],
        ])
        // Neither the wording nor the code, the number or the app's name.
        expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY)
        expect(JSON.stringify(warn.mock.calls)).not.toContain(CODE)
      } finally {
        warn.mockRestore()
      }
    }
  )

  test('an app name with six digits after the code, and no origin: the built-in text, logged', async () => {
    configure({ sign_in: { text: 'Use {{code}} for {{appName}}.' } }, SCOPE.environmentId, {
      app: { name: 'Acme 123456', supportEmail: null },
      urls: { allowedOrigins: [], allowedRedirectUrls: [] },
    })
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await Sms.sendCode(deps, SCOPE, message())
      expect(deps.sms.last().text).toBe(`Your Acme 123456 verification code is ${CODE}.`)
      expect(warn.mock.calls[0]?.[1]).toEqual({
        environmentId: SCOPE.environmentId,
        kind: 'sign_in',
        reason: 'code_not_last',
      })
    } finally {
      warn.mockRestore()
    }
  })

  test('what a real store hands on has no template that does not pass', () => {
    const { settings, droppedSmsTemplates } = readStoredEnvironmentSettings({
      sms: { templates: { sign_in: { text: `${CANARY} https://evil.example {{code}}` } } },
    })
    expect(settings.sms.templates).toEqual({})
    expect(droppedSmsTemplates).toEqual(['sign_in'])
  })
})

describe('a template changes words, and nothing about who is sent what', () => {
  test('the same limiter rows and the same count are taken with and without a template', async () => {
    const run = async (templates: unknown) => {
      deps = createTestDeps()
      deps.clock.set(new Date('2026-10-08T09:00:00.000Z'))
      configure(templates)
      const hit = spyOn(deps.rateLimiter, 'hit')
      serial = 0
      await Sms.sendCode(deps, SCOPE, message())
      return {
        keys: hit.mock.calls.map(([key, rule]) => [key, rule]),
        sent: await deps.smsUsage.sentOn(SCOPE.environmentId, '2026-10-08'),
        to: deps.sms.outbox.map(({ to }) => to),
      }
    }
    const without = await run({})
    const withOne = await run({ sign_in: { text: 'Use {{code}} to sign in.' } })
    expect(withOne).toEqual(without)
    expect(without.sent).toBe(1)
  })

  test('a decoy sends nothing whatever the wording', async () => {
    configure({ sign_in: { text: 'Use {{code}} to sign in.' } })
    await Sms.sendCode(deps, SCOPE, {
      decoy: true,
      identifier: '+12025550199',
      asker: await Sms.signInAsker(deps, SCOPE.environmentId, '+12025550199'),
      address: '198.51.100.7',
    })
    expect(deps.sms.outbox).toHaveLength(0)
  })

  test('SMS switched off refuses before any wording is read', async () => {
    configure({ sign_in: { text: 'Use {{code}} to sign in.' } })
    const settings = (await deps.environmentSettings.get(SCOPE.environmentId))?.settings
    revision += 1
    deps.environmentSettings.seed(SCOPE.environmentId, {
      revision,
      settings: {
        ...(settings as EnvironmentSettings),
        sms: { ...(settings as EnvironmentSettings).sms, enabled: false },
      },
    })
    await expect(Sms.sendCode(deps, SCOPE, message())).rejects.toMatchObject({
      code: 'sms.disabled',
    })
    expect(deps.sms.outbox).toHaveLength(0)
  })
})
