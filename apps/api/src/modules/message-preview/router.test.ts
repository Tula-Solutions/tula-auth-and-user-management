import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EMAIL_TEMPLATE_KINDS,
  EMAIL_TEMPLATE_RULES,
  type EnvironmentSettings,
  SMS_TEMPLATE_KINDS,
} from '@tula/contract'
import { ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import * as Email from '~/modules/email/service'
import { templateKind } from '~/modules/email/templates'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import { MESSAGE_PREVIEW_RATE_LIMIT } from './router'
import { SAMPLE_EMAILS } from './service'

// The preview of a wording (ADR 0042): the sending code's own rendering with sample values,
// answered as text. It sends, stores and records nothing.

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const PROD_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000000000'
const PATH = '/v1/admin/message-preview'
const CANARY = 'Draft-canary-91bf'
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps
let app: ReturnType<typeof createApp>

interface Preview {
  channel: string
  kind: string
  subject: string | null
  text: string
  unused: { part: string; reason: string }[]
  segments: { encoding: string; units: number; segments: number } | null
}

function seed(environmentId: string, more: Partial<EnvironmentSettings>) {
  deps.environmentSettings.seed(environmentId, {
    revision: 1,
    settings: { ...DEFAULT_ENVIRONMENT_SETTINGS, ...more },
  })
}

beforeEach(async () => {
  deps = createTestDeps()
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, PROD_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  seed(TEST_TENANT.environmentId, {
    app: { name: 'Northline', supportEmail: 'help@northline.app' },
    urls: { allowedOrigins: ['https://app.northline.app'], allowedRedirectUrls: [] },
  })
  app = createApp(deps)
})

function post(body: unknown, key: string | null = SK) {
  return app.request(PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key !== null && { authorization: `Bearer ${key}` }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function preview(body: unknown, key = SK): Promise<Preview> {
  const response = await post(body, key)
  expect(response.status).toBe(200)
  return (await response.json()) as Preview
}

describe('a text message', () => {
  test('without a draft is the built-in text, with the server’s line and its segments', async () => {
    for (const kind of SMS_TEMPLATE_KINDS) {
      expect(await preview({ channel: 'sms', kind })).toEqual({
        channel: 'sms',
        kind,
        subject: null,
        text: 'Your Northline verification code is 123456.\n\n@app.northline.app #123456',
        unused: [],
        segments: { encoding: 'gsm7', units: 71, segments: 1 },
      })
    }
  })

  test('with a draft is the draft’s sentence and the same last line', async () => {
    const answer = await preview({
      channel: 'sms',
      kind: 'sign_in',
      template: { text: 'Für {{appName}}: dein Code ist {{code}}. Schöne Grüße aus Łódź' },
    })
    expect(answer.text).toBe(
      'Für Northline: dein Code ist 123456. Schöne Grüße aus Łódź\n\n@app.northline.app #123456'
    )
    // One letter outside the GSM alphabet: the whole message is UCS-2, and two segments.
    expect(answer.segments).toEqual({ encoding: 'ucs2', units: 86, segments: 2 })
  })

  test('a draft the server would not use for this environment says so and shows what is sent', async () => {
    seed(TEST_TENANT.environmentId, { app: { name: 'Acme 654321', supportEmail: null } })
    const answer = await preview({
      channel: 'sms',
      kind: 'sign_in',
      template: { text: 'Use {{code}} for {{appName}}.' },
    })
    expect(answer.unused).toEqual([{ part: 'text', reason: 'code_not_last' }])
    expect(answer.text).toBe('Your Acme 654321 verification code is 123456.')
  })

  test('also when the name’s six digits happen to be the sample code', async () => {
    seed(TEST_TENANT.environmentId, { app: { name: 'Acme 123456', supportEmail: null } })
    const answer = await preview({
      channel: 'sms',
      kind: 'sign_in',
      template: { text: 'Use {{code}} for {{appName}}.' },
    })
    expect(answer.unused).toEqual([{ part: 'text', reason: 'code_not_last' }])
    expect(answer.text).toBe('Your Acme 123456 verification code is 123456.')
  })

  test.each([
    ['no code', 'Your code is on its way.'],
    ['a second code line', 'Code {{code}} @evil.example #x'],
    ['a link', 'Code {{code}}. https://x.test'],
    ['a line break', 'Code {{code}}.\nBye'],
  ])('a draft with %s is refused as a save would be, under template.text', async (_name, text) => {
    const response = await post({ channel: 'sms', kind: 'sign_in', template: { text } })
    expect(response.status).toBe(422)
    const failure = (await response.json()) as { code: string; errors: { field: string }[] }
    expect(failure.code).toBe('validation.failed')
    expect(new Set(failure.errors.map((error) => error.field))).toEqual(new Set(['template.text']))
  })
})

describe('an email', () => {
  test('every kind has a sample that is of that kind', () => {
    expect(Object.keys(SAMPLE_EMAILS).sort()).toEqual([...EMAIL_TEMPLATE_KINDS].sort())
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      expect(templateKind(SAMPLE_EMAILS[kind])).toBe(kind)
    }
  })

  test('without a draft every kind is what Email.send would send for the sample, as text', async () => {
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      const answer = await preview({ channel: 'email', kind })
      await Email.send(deps, tenant, 'maya@northline.app', SAMPLE_EMAILS[kind])
      const sent = deps.mailer.last()
      expect(answer).toEqual({
        channel: 'email',
        kind,
        subject: sent.subject,
        text: sent.text,
        unused: [],
        segments: null,
      })
      expect(answer.text).toContain('Northline')
    }
  })

  test('a draft of every kind is rendered, and no answer holds markup', async () => {
    for (const kind of EMAIL_TEMPLATE_KINDS) {
      const { required } = EMAIL_TEMPLATE_RULES[kind]
      const body = [
        '<b>Reworded</b> & <script>alert(1)</script> for {{appName}}.',
        ...required.map((name) => `{{${name}}}`),
      ].join('\n\n')
      const answer = await preview({
        channel: 'email',
        kind,
        template: { subject: 'Reworded <i>subject</i>', body },
      })
      expect(answer.unused).toEqual([])
      expect(answer.subject).toBe('Reworded <i>subject</i>')
      // The operator's characters as they typed them: text, never an escaped or built page.
      expect(answer.text).toContain('<b>Reworded</b> & <script>alert(1)</script> for Northline.')
      expect(answer.text).not.toContain('<!doctype')
      expect(answer.text).not.toContain('<p>')
      expect(Object.keys(answer)).not.toContain('html')
    }
  })

  test('a subject alone is a draft: the body is the built-in one', async () => {
    const builtIn = await preview({ channel: 'email', kind: 'password_changed' })
    const answer = await preview({
      channel: 'email',
      kind: 'password_changed',
      template: { subject: 'Your {{appName}} password is new' },
    })
    expect(answer.subject).toBe('Your Northline password is new')
    expect(answer.text).toBe(builtIn.text)
  })

  test('a notice keeps the server’s facts, last sentence and support line under a draft body', async () => {
    const answer = await preview({
      channel: 'email',
      kind: 'new_sign_in',
      template: { body: 'Somebody signed in.' },
    })
    expect(answer.text).toContain('Somebody signed in.')
    expect(answer.text).toContain('Device: Chrome on Windows')
    expect(answer.text).toContain('When: 2026-01-15 14:05 UTC')
    expect(answer.text).toContain('help@northline.app')
  })

  test('a part the server would replace for this environment is named, and drawn built-in', async () => {
    seed(TEST_TENANT.environmentId, { app: { name: '1Password', supportEmail: null } })
    const answer = await preview({
      channel: 'email',
      kind: 'password_changed',
      template: { subject: '{{appName}} password changed' },
    })
    expect(answer.unused).toEqual([{ part: 'subject', reason: 'leading_digit' }])
    expect(answer.subject).toBe('Your 1Password password was changed')
  })

  test.each([
    ['a code message without its code', 'step_up', { body: 'No code.' }, 'template.body'],
    ['a notice with a code', 'new_sign_in', { body: 'Code {{code}}' }, 'template.body'],
    ['a link in a subject', 'sign_in', { subject: 'See https://x.test' }, 'template.subject'],
    ['a line break in a subject', 'sign_in', { subject: 'A\nB' }, 'template.subject'],
  ])('a draft with %s is refused under its field', async (_name, kind, template, field) => {
    const response = await post({ channel: 'email', kind, template })
    expect(response.status).toBe(422)
    const failure = (await response.json()) as { errors: { field: string }[] }
    expect(failure.errors.map((error) => error.field)).toContain(field)
  })
})

describe('what a preview is not', () => {
  test.each([
    ['a kind of the other channel', { channel: 'sms', kind: 'email_verification' }],
    ['a kind nobody knows', { channel: 'email', kind: 'welcome' }],
    ['an inherited key as a kind', { channel: 'email', kind: 'constructor' }],
    ['no channel', { kind: 'sign_in' }],
    ['a channel nobody knows', { channel: 'push', kind: 'sign_in' }],
    ['a key beside the three', { channel: 'sms', kind: 'sign_in', appName: 'Evil' }],
    ['an html part asked for', { channel: 'email', kind: 'sign_in', template: { html: '<p>' } }],
    [
      'a subject for a text message',
      { channel: 'sms', kind: 'sign_in', template: { text: 'Code {{code}}', subject: 'x' } },
    ],
    ['a draft that is a string', { channel: 'sms', kind: 'sign_in', template: 'Code {{code}}' }],
  ])('%s is refused', async (_name, body) => {
    expect((await post(body)).status).toBe(422)
  })

  test('a body that is not JSON is refused as malformed', async () => {
    expect((await post('{nope')).status).toBe(400)
  })

  test('needs a secret key: none, a publishable one and a wrong one are refused', async () => {
    const body = { channel: 'sms', kind: 'sign_in' }
    expect((await post(body, null)).status).toBe(401)
    expect((await post(body, PK)).status).toBe(401)
    expect((await post(body, 'tula_sk_dev_wrong00000000000000000000000000000')).status).toBe(401)
  })

  test('is drawn with the key’s own environment, never another’s', async () => {
    seed(TEST_TENANT.productionEnvironmentId, {
      app: { name: 'Elsewhere', supportEmail: null },
      urls: { allowedOrigins: ['https://elsewhere.test'], allowedRedirectUrls: [] },
    })
    const here = await preview({ channel: 'sms', kind: 'sign_in' })
    const there = await preview({ channel: 'sms', kind: 'sign_in' }, PROD_SK)
    expect(here.text).not.toContain('Elsewhere')
    expect(there.text).toBe(
      'Your Elsewhere verification code is 123456.\n\n@elsewhere.test #123456'
    )
  })

  test('sends nothing, saves nothing, records nothing, and logs no draft', async () => {
    const before = await deps.environmentSettings.get(TEST_TENANT.environmentId)
    const lines: unknown[] = []
    const note = (...args: unknown[]) => void lines.push(args)
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
      spyOn(logger, level).mockImplementation(note)
    )
    try {
      const response = await post({
        channel: 'sms',
        kind: 'sign_in',
        template: { text: `${CANARY} {{code}}` },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await post({ channel: 'email', kind: 'sign_in', template: { subject: `${CANARY} {{code}}` } })
      // A refused draft is not repeated either.
      const refused = await post({
        channel: 'sms',
        kind: 'sign_in',
        template: { text: `${CANARY} https://x.test` },
      })
      expect(await refused.text()).not.toContain(CANARY)
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
    expect(JSON.stringify(lines)).not.toContain(CANARY)
    expect(deps.sms.outbox).toHaveLength(0)
    expect(deps.mailer.outbox).toHaveLength(0)
    expect(deps.activityLog.entries).toHaveLength(0)
    expect(deps.activityLog.events).toHaveLength(0)
    expect(await deps.environmentSettings.get(TEST_TENANT.environmentId)).toEqual(before)
    expect(await deps.smsUsage.sentOn(TEST_TENANT.environmentId, '2026-10-08')).toBe(0)
  })

  test('works with text messages switched off and with no sender: it sends none', async () => {
    expect(DEFAULT_ENVIRONMENT_SETTINGS.sms.enabled).toBe(false)
    expect((await post({ channel: 'sms', kind: 'phone_verification' })).status).toBe(200)
  })
})

describe('the limit', () => {
  test('is per environment: one over is refused, and another environment is not', async () => {
    const body = { channel: 'sms', kind: 'sign_in' }
    for (let i = 0; i < MESSAGE_PREVIEW_RATE_LIMIT; i += 1) {
      expect((await post(body)).status).toBe(200)
    }
    expect((await post(body)).status).toBe(429)
    expect((await post(body, PROD_SK)).status).toBe(200)
  })

  test('a request without a key spends none of it', async () => {
    const hit = spyOn(deps.rateLimiter, 'hit')
    await post({ channel: 'sms', kind: 'sign_in' }, null)
    expect(
      hit.mock.calls.map(([key]) => key).filter((key) => key.includes('message_preview'))
    ).toEqual([])
  })

  test('a limiter that cannot count the preview lets it through: nothing is sent by one', async () => {
    const real = deps.rateLimiter.hit.bind(deps.rateLimiter)
    spyOn(deps.rateLimiter, 'hit').mockImplementation((key, ...rest) => {
      if (key.includes('message_preview')) {
        throw new ServiceUnavailableError()
      }
      return real(key, ...rest)
    })
    expect((await post({ channel: 'sms', kind: 'sign_in' })).status).toBe(200)
  })
})
