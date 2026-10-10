import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  EnvironmentSettingsSchema,
  EVENT_DATA_SCHEMAS,
  MAX_SETTING_NAME_LENGTH,
  MAX_SMS_TEMPLATE_LENGTH,
  SMS_TEMPLATE_KINDS,
  type SmsTemplates,
  settingsWeakenings,
} from '@tula/contract'
import { createApp } from '~/index'
import * as Settings from '~/modules/settings/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// Text message wording as a setting (ADR 0042): saved through the settings document, refused
// when a template could not carry its code or could imitate the server's own line, recorded
// by key and never by text.

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const ADMIN = '/v1/admin/settings'
const CANARY = 'Canary-wording-3a9d'

let deps: TestDeps
let app: ReturnType<typeof createApp>

interface State {
  revision: number
  settings: EnvironmentSettings
}

interface Failure {
  code: string
  errors?: { field: string; code: string; message: string }[]
}

beforeEach(async () => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

const read = async (key = SK) =>
  (await (
    await app.request(ADMIN, { headers: { authorization: `Bearer ${key}` } })
  ).json()) as State

function put(body: unknown, revision: number, key = SK) {
  return app.request(ADMIN, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      'if-match': `"${revision}"`,
    },
    body: JSON.stringify(body),
  })
}

const templates = (value: SmsTemplates) => ({ sms: { templates: value } })

async function refused(value: unknown): Promise<Failure['errors']> {
  const response = await put({ sms: { templates: value } }, 0)
  expect(response.status).toBe(422)
  const failure = (await response.json()) as Failure
  expect(failure.code).toBe('validation.failed')
  expect((await read()).revision).toBe(0)
  return failure.errors
}

describe('saving text message templates', () => {
  test('an environment that saved nothing has none', async () => {
    expect((await read()).settings.sms.templates).toEqual({})
  })

  test('a template is saved and read back as written, for its environment only', async () => {
    const saved = { sign_in: { text: 'Use {{code}} to sign in to {{appName}}.' } }
    expect((await put(templates(saved), 0)).status).toBe(200)
    expect((await read()).settings.sms.templates).toEqual(saved)
    expect((await read(PROD_SK)).settings.sms.templates).toEqual({})
  })

  test('saving a template leaves the rest of the sms section as it was', async () => {
    await put({ sms: { enabled: true, allowedCountries: ['DE'], dailyMessageLimit: 40 } }, 0)
    const { settings } = await read()
    await put(
      { ...settings, sms: { ...settings.sms, templates: { sign_in: { text: 'Code: {{code}}' } } } },
      1
    )
    expect((await read()).settings.sms).toEqual({
      enabled: true,
      allowedCountries: ['DE'],
      dailyMessageLimit: 40,
      templates: { sign_in: { text: 'Code: {{code}}' } },
    })
  })

  test.each([
    ['without its code', 'Your sign-in code is on its way.', 'the text must contain {{code}}'],
    ['with its code twice', 'Code {{code}} and {{code}}.', '{{code}} must be written only once'],
    [
      'with a second code line',
      'Code {{code}} @evil.example #x',
      'a word must not start with @ or #: that is how the line the server adds is recognised',
    ],
    [
      'with digits that read as a code',
      'Not 999999 but {{code}}.',
      'must not contain four or more digits in a row: only the code may',
    ],
    ['with a line break', 'Code {{code}}.\nBye', 'must be one line, with no control characters'],
    [
      'with a link',
      'Code {{code}}. See https://x.test',
      'must not contain a link, an address or a domain name (put a space after a full stop)',
    ],
    [
      'that starts with the code',
      '{{code}} is your code.',
      'must start with a letter of its own, not with a placeholder',
    ],
    ['over the cap', `A${'a'.repeat(MAX_SMS_TEMPLATE_LENGTH)} {{code}}`, null],
  ])(
    'a template %s is refused under its field, and nothing is stored',
    async (_name, text, message) => {
      for (const kind of SMS_TEMPLATE_KINDS) {
        const errors = await refused({ [kind]: { text } })
        expect(errors?.map((error) => error.field)).toContain(`sms.templates.${kind}.text`)
        if (message !== null) {
          expect(errors?.map((error) => error.message)).toContain(message)
        }
      }
    }
  )

  test('a kind nobody knows and a key beside the text are refused', async () => {
    expect(await refused({ welcome: { text: 'Code {{code}}' } })).toBeDefined()
    expect(await refused({ sign_in: { text: 'Code {{code}}', lastLine: '@x #1' } })).toBeDefined()
  })

  test('a refusal never repeats the template’s text', async () => {
    const response = await put(
      templates({ sign_in: { text: `${CANARY} @x #1 99999 https://x.test {{nope}}` } }),
      0
    )
    expect(response.status).toBe(422)
    expect(await response.text()).not.toContain(CANARY)
  })
})

describe('the record of a change', () => {
  const saved: SmsTemplates = {
    phone_verification: { text: `${CANARY} check {{code}}` },
    sign_in: { text: `${CANARY} sign-in {{code}}` },
    second_factor: { text: `${CANARY} second step {{code}}` },
  }

  test('names the kind that changed, never the text', async () => {
    await put(templates(saved), 0)
    const [entry] = deps.activityLog.ofType('environment.settings_updated')
    expect(entry?.data).toEqual({
      revision: 1,
      changed: [
        'sms.templates.phone_verification.text',
        'sms.templates.second_factor.text',
        'sms.templates.sign_in.text',
      ],
    })
    const audit = await app.request('/v1/admin/audit-logs?action=environment.settings_updated', {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(await audit.text()).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.events)).not.toContain(CANARY)
  })

  test('removing a template is its key too', async () => {
    await put(templates(saved), 0)
    await put(templates({ sign_in: saved.sign_in }), 1)
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 2,
      changed: ['sms.templates.phone_verification.text', 'sms.templates.second_factor.text'],
    })
  })

  // The email precedent (ADR 0039): wording changes who reads what, not who gets in.
  test('is not a weakening, in either direction', async () => {
    await put(templates(saved), 0)
    expect(deps.activityLog.ofType('environment.settings_updated')[0]?.data).not.toHaveProperty(
      'weakened'
    )
    const before = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
    const after = EnvironmentSettingsSchema.parse({
      signIn: { methods: { smsCode: { enabled: true } } },
      sms: { enabled: true, allowedCountries: ['US'], templates: saved },
    })
    const same = EnvironmentSettingsSchema.parse({
      signIn: { methods: { smsCode: { enabled: true } } },
      sms: { enabled: true, allowedCountries: ['US'] },
    })
    expect(settingsWeakenings(same, after)).toEqual([])
    expect(settingsWeakenings(after, same)).toEqual([])
    expect(Settings.weakened(same, after)).toBe(false)
    expect(Settings.changedKeys(before, before)).toEqual([])
  })

  test('every kind’s key fits the event’s list of changed settings', () => {
    const after = EnvironmentSettingsSchema.parse({ sms: { templates: saved } })
    const keys = Settings.changedKeys(DEFAULT_ENVIRONMENT_SETTINGS, after)
    expect(keys).toHaveLength(SMS_TEMPLATE_KINDS.length)
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(MAX_SETTING_NAME_LENGTH)
    const { changed } = EVENT_DATA_SCHEMAS['environment.settings_updated'].shape
    expect(changed.parse(keys)).toEqual(keys)
  })
})
