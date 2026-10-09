import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EMAIL_TEMPLATE_KINDS,
  EMAIL_TEMPLATE_RULES,
  type EmailTemplates,
  type EnvironmentSettings,
  EnvironmentSettingsSchema,
  EVENT_DATA_SCHEMAS,
  MAX_CHANGED_SETTINGS,
  MAX_EMAIL_BODY_LENGTH,
  MAX_EMAIL_SUBJECT_LENGTH,
  MAX_SETTING_NAME_LENGTH,
  settingsWeakenings,
} from '@tula/contract'
import { cacheEnvironmentSettings } from '~/adapters/cache/environment-settings'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Email from '~/modules/email/service'
import * as Settings from '~/modules/settings/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

// Email wording as a setting (ADR 0039): saved through the settings document, refused when a
// template could not do its message's job, recorded by key and never by text.

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000000000'
const ADMIN = '/v1/admin/settings'
const CANARY = 'canary-wording-5e0b'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const prod = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }

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
  await seedApiKey(deps, PK)
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

const templates = (value: EmailTemplates) => ({ emails: { templates: value } })

async function refused(value: unknown): Promise<Failure['errors']> {
  const response = await put({ emails: { templates: value } }, 0)
  expect(response.status).toBe(422)
  const failure = (await response.json()) as Failure
  expect(failure.code).toBe('validation.failed')
  // Nothing was stored.
  expect((await read()).revision).toBe(0)
  return failure.errors
}

const verification = { type: 'email_verification', code: '482913', ttlMinutes: 10 } as const

describe('saving templates', () => {
  test('an environment that saved nothing has none, and sends the built-in copy', async () => {
    expect((await read()).settings.emails).toEqual({ templates: {} })
    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().subject).toBe('482913 is your Tula verification code')
  })

  test('a template is saved, read back as written, and used for the next email', async () => {
    const saved = {
      email_verification: {
        subject: 'Your {{appName}} code is {{code}}',
        body: `${CANARY}\n\n{{code}}\n\nGood for {{expiresInMinutes}} minutes.`,
      },
      password_changed: { body: 'Your {{appName}} password changed at {{time}}.' },
    }
    const response = await put(templates(saved), 0)
    expect(response.status).toBe(200)
    expect(((await response.json()) as State).settings.emails).toEqual({ templates: saved })
    expect((await read()).settings.emails).toEqual({ templates: saved })

    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().subject).toBe('Your Tula code is 482913')
    expect(deps.mailer.last().text).toStartWith(`${CANARY}\n\n482913\n\nGood for 10 minutes.`)
  })

  test('one environment’s templates are its own', async () => {
    await put(templates({ email_verification: { body: `${CANARY} {{code}}` } }), 0)
    expect((await read(PROD_SK)).settings.emails).toEqual({ templates: {} })
    await Email.send(deps, prod, 'maya@northline.app', verification)
    expect(deps.mailer.last().text).not.toContain(CANARY)
  })

  test('a kind left out of a replace goes back to the built-in copy: the document is replaced whole', async () => {
    await put(templates({ email_verification: { body: `${CANARY} {{code}}` } }), 0)
    const response = await put({ app: { name: 'Acme' } }, 1)
    expect(((await response.json()) as State).settings.emails).toEqual({ templates: {} })
    await Email.send(deps, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().subject).toBe('482913 is your Acme verification code')
    expect(deps.mailer.last().text).not.toContain(CANARY)
  })

  test('the public client config says nothing of them', async () => {
    await put(templates({ email_verification: { body: `${CANARY} {{code}}` } }), 0)
    const config = await app.request('/v1/client/config', {
      headers: { 'x-tula-publishable-key': PK },
    })
    const text = await config.text()
    expect(text).not.toContain(CANARY)
    expect(text).not.toContain('emails')
  })
})

describe('a template that could not do its job is refused when saved', () => {
  test('a code message without the code, naming the field and the placeholder', async () => {
    expect(await refused({ password_reset: { body: 'Reset your password.' } })).toEqual([
      {
        field: 'emails.templates.password_reset.body',
        code: 'validation.failed',
        message: 'the body must contain {{code}}',
      },
    ])
  })

  test('a sign-in message without the link', async () => {
    expect(await refused({ sign_in: { body: 'Code: {{code}}' } })).toEqual([
      {
        field: 'emails.templates.sign_in.body',
        code: 'validation.failed',
        message: 'the body must contain {{link}}',
      },
    ])
  })

  test('an unknown placeholder, by name', async () => {
    const errors = await refused({ step_up: { subject: 'Hi {{firstName}}', body: '{{code}}' } })
    expect(errors).toEqual([
      {
        field: 'emails.templates.step_up.subject',
        code: 'validation.failed',
        message: '{{firstName}} is not a placeholder of this subject',
      },
    ])
  })

  test.each([
    ['a code', { body: 'Your code is {{code}}.' }],
    ['a link placeholder', { body: 'Open {{link}}.' }],
    ['a token', { body: 'Token {{token}}.' }],
    ['an address', { body: 'Go to https://evil.test/reset now.' }],
    ['www', { subject: 'See www.evil.test' }],
    ['a bare domain', { body: 'Confirm at evil.test today.' }],
    ['an email address', { body: 'Write to help@evil.test today.' }],
    ['a subject that starts with a digit', { subject: '482913 is your code' }],
  ])('a security notice cannot be given %s', async (_, template) => {
    for (const kind of ['password_changed', 'new_sign_in', 'mfa_reset_by_admin'] as const) {
      const errors = await refused({ [kind]: template })
      expect(errors?.length).toBeGreaterThan(0)
      for (const error of errors ?? []) {
        expect(error.field).toStartWith(`emails.templates.${kind}.`)
      }
    }
  })

  test('malformed braces, a line break in a subject, an unknown kind and an empty template', async () => {
    expect((await refused({ step_up: { body: '{{code}} {oops}' } }))?.[0]?.field).toBe(
      'emails.templates.step_up.body'
    )
    expect((await refused({ step_up: { subject: 'Hi\r\nBcc: eve@evil.test' } }))?.[0]?.field).toBe(
      'emails.templates.step_up.subject'
    )
    expect((await refused({ sms_code: { body: 'x' } }))?.[0]?.field).toBe('emails.templates')
    expect((await refused({ step_up: {} }))?.[0]?.field).toBe('emails.templates.step_up')
    expect((await refused({ step_up: { body: '{{code}}', html: '<b>x</b>' } }))?.length).toBe(1)
  })

  test('the caps, one over', async () => {
    const subject = 's'.repeat(MAX_EMAIL_SUBJECT_LENGTH)
    const body = `{{code}}${'b'.repeat(MAX_EMAIL_BODY_LENGTH - 8)}`
    expect((await refused({ step_up: { subject: `${subject}s` } }))?.[0]?.field).toBe(
      'emails.templates.step_up.subject'
    )
    expect((await refused({ step_up: { body: `${body}b` } }))?.[0]?.field).toBe(
      'emails.templates.step_up.body'
    )
    expect((await put(templates({ step_up: { subject, body } }), 0)).status).toBe(200)
  })

  test('a refusal never repeats the template’s text', async () => {
    const response = await put(
      templates({
        password_changed: { subject: `1 ${CANARY} https://x.test`, body: `${CANARY} {{code}} {x` },
        sign_in: { body: CANARY },
      }),
      0
    )
    expect(response.status).toBe(422)
    expect(await response.text()).not.toContain(CANARY)
  })
})

describe('the record of a change', () => {
  const saved: EmailTemplates = {
    email_verification: { subject: `${CANARY} {{code}}`, body: `${CANARY} body {{code}}` },
    new_sign_in: { body: `${CANARY} notice` },
  }

  test('names the kind and the field that changed, never the text', async () => {
    await put(templates(saved), 0)
    const [entry] = deps.activityLog.ofType('environment.settings_updated')
    expect(entry?.data).toEqual({
      revision: 1,
      changed: [
        'emails.templates.email_verification.body',
        'emails.templates.email_verification.subject',
        'emails.templates.new_sign_in.body',
      ],
    })
    // The audit log as the admin API answers it, and the event as a webhook would carry it.
    const audit = await app.request('/v1/admin/audit-logs?action=environment.settings_updated', {
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(await audit.text()).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain(CANARY)
    expect(JSON.stringify(deps.activityLog.events)).not.toContain(CANARY)
  })

  test('changing one field of one kind is one key', async () => {
    await put(templates(saved), 0)
    await put(
      templates({
        ...saved,
        email_verification: { ...saved.email_verification, body: 'Reworded {{code}}' },
      }),
      1
    )
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 2,
      changed: ['emails.templates.email_verification.body'],
    })
    // Removing a template is its keys too.
    await put(templates({}), 2)
    expect(deps.activityLog.ofType('environment.settings_updated').at(-1)?.data).toEqual({
      revision: 3,
      changed: [
        'emails.templates.email_verification.body',
        'emails.templates.email_verification.subject',
        'emails.templates.new_sign_in.body',
      ],
    })
  })

  test('is not a weakening, for a code message or for a security notice', async () => {
    await put(templates(saved), 0)
    expect(deps.activityLog.ofType('environment.settings_updated')[0]?.data).not.toHaveProperty(
      'weakened'
    )
    const before = structuredClone(DEFAULT_ENVIRONMENT_SETTINGS)
    const every = Object.fromEntries(
      EMAIL_TEMPLATE_KINDS.map((kind) => [kind, { subject: 'Reworded', body: bodyOf(kind) }])
    )
    const after = EnvironmentSettingsSchema.parse({ emails: { templates: every } })
    expect(settingsWeakenings(before, after)).toEqual([])
    expect(settingsWeakenings(after, before)).toEqual([])
    expect(Settings.weakened(before, after)).toBe(false)
  })

  test('every template of every kind still fits the event’s list of changed settings', () => {
    const every = Object.fromEntries(
      EMAIL_TEMPLATE_KINDS.map((kind) => [kind, { subject: 'Reworded', body: bodyOf(kind) }])
    )
    const after = EnvironmentSettingsSchema.parse({ emails: { templates: every } })
    const keys = Settings.changedKeys(DEFAULT_ENVIRONMENT_SETTINGS, after)
    expect(keys).toHaveLength(EMAIL_TEMPLATE_KINDS.length * 2)
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(MAX_SETTING_NAME_LENGTH)
    const { changed } = EVENT_DATA_SCHEMAS['environment.settings_updated'].shape
    expect(changed.parse(keys)).toEqual(keys)
    // With the rest of the largest document (see `service.test.ts`) there is still room.
    expect(keys.length).toBeLessThan(MAX_CHANGED_SETTINGS / 2)
  })
})

function bodyOf(kind: (typeof EMAIL_TEMPLATE_KINDS)[number]): string {
  const { required } = EMAIL_TEMPLATE_RULES[kind]
  return ['Reworded.', ...required.map((name) => `{{${name}}}`)].join('\n\n')
}

describe('a stale settings cache on another instance', () => {
  let warn: ReturnType<typeof spyOn<typeof logger, 'warn'>>

  beforeEach(() => {
    warn = spyOn(logger, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  test('sends the wording it last read until its cache expires: wording may lag, nothing else', async () => {
    // Two instances over one store with no shared marker, so B's copy is good for 30 seconds.
    const shared = deps.environmentSettings
    const a = { ...deps, environmentSettings: cacheEnvironmentSettings(shared, deps.clock, 30_000) }
    const b = { ...deps, environmentSettings: cacheEnvironmentSettings(shared, deps.clock, 30_000) }
    await Email.send(b, tenant, 'maya@northline.app', verification)
    const builtIn = deps.mailer.last()

    await Settings.replace(
      a,
      tenant,
      {
        expectedRevision: 0,
        settings: EnvironmentSettingsSchema.parse(
          templates({ email_verification: { body: `${CANARY} {{code}}` } })
        ),
      },
      TEST_ACTOR
    )
    // The writer uses the new wording at once.
    await Email.send(a, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().text).toStartWith(`${CANARY} 482913`)
    // The other instance still sends the old wording: a whole, valid email with the code.
    await Email.send(b, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last()).toEqual(builtIn)
    expect(deps.mailer.last().text).toContain('482913')
    // And the new one once its copy has expired.
    deps.clock.advance(30_001)
    await Email.send(b, tenant, 'maya@northline.app', verification)
    expect(deps.mailer.last().text).toStartWith(`${CANARY} 482913`)
    expect(warn).not.toHaveBeenCalled()
  })
})
