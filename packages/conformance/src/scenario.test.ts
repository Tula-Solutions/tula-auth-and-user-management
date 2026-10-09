import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod'
import { ScenarioSchema } from './scenario'

test('the committed JSON Schema is what the Zod schema generates', async () => {
  const committed = await Bun.file(
    join(import.meta.dir, '../../../conformance/scenario.schema.json')
  ).json()
  expect(committed).toEqual(
    JSON.parse(JSON.stringify(z.toJSONSchema(ScenarioSchema, { io: 'input' })))
  )
})

test('requests default to the publishable key', () => {
  const scenario = ScenarioSchema.parse({
    name: 'x',
    description: 'y',
    steps: [{ name: 's', request: { method: 'GET', path: '/v1/status' }, expect: { status: 200 } }],
  })
  const [step] = scenario.steps
  expect(step && 'request' in step && step.request.auth).toBe('publishable')
})

test.each([
  ['a relative path', { method: 'GET', path: 'v1/status' }],
  ['an unknown method', { method: 'TRACE', path: '/v1/status' }],
  ['an unknown client', { method: 'GET', path: '/v1/status', client: 'fridge' }],
  ['an unknown instance', { method: 'GET', path: '/v1/status', instance: 'third' }],
])('rejects a request with %s', (_name, request) => {
  expect(
    ScenarioSchema.safeParse({
      name: 'x',
      description: 'y',
      steps: [{ name: 's', request, expect: { status: 200 } }],
    }).success
  ).toBe(false)
})

const secretStep = (request: object = {}) => ({
  name: 'admin',
  request: { method: 'GET', path: '/v1/admin/users', auth: 'secret', ...request },
  expect: { status: 200 },
})

test('a scenario that uses the secret key must say so, so it is skipped rather than sent without one', () => {
  const base = { name: 'x', description: 'y', steps: [secretStep()] }
  expect(ScenarioSchema.safeParse(base).success).toBe(false)
  expect(ScenarioSchema.safeParse({ ...base, needsSecretKey: false }).success).toBe(false)
  expect(ScenarioSchema.safeParse({ ...base, needsSecretKey: true }).success).toBe(true)
})

test('a secret-key step in the cleanup needs the flag as well', () => {
  const step = { name: 's', request: { method: 'GET', path: '/x' }, expect: { status: 200 } }
  const cleanup = [
    { name: 'c', request: { method: 'GET', path: '/y', auth: 'secret' }, expect: { status: 200 } },
  ]
  const base = { name: 'n', description: 'd', steps: [step], cleanup }
  expect(ScenarioSchema.safeParse(base).success).toBe(false)
  expect(ScenarioSchema.safeParse({ ...base, needsSecretKey: true }).success).toBe(true)
  // A cleanup, when given, has at least one step.
  expect(ScenarioSchema.safeParse({ ...base, needsSecretKey: true, cleanup: [] }).success).toBe(
    false
  )
})

test('an email-link step names the address and where the token goes, and nothing unknown', () => {
  const scenario = (emailLink: object) => ({
    name: 'n',
    description: 'd',
    steps: [{ name: 'read', emailLink }],
  })
  expect(
    ScenarioSchema.safeParse(scenario({ to: '{{email}}', captureToken: 'token' })).success
  ).toBe(true)
  expect(
    ScenarioSchema.safeParse(
      scenario({
        to: '{{email}}',
        captureToken: 'token',
        captureAttempt: 'attempt',
        url: '{{redirect}}',
      })
    ).success
  ).toBe(true)
  expect(ScenarioSchema.safeParse(scenario({ to: '{{email}}' })).success).toBe(false)
  expect(
    ScenarioSchema.safeParse({
      name: 'n',
      description: 'd',
      steps: [{ name: 'read', emailLink: { to: 'a', captureToken: 't' }, wait: '1s' }],
    }).success
  ).toBe(false)
})

test('a request cannot carry both the secret key and an access token', () => {
  expect(
    ScenarioSchema.safeParse({
      name: 'x',
      description: 'y',
      needsSecretKey: true,
      steps: [secretStep({ accessToken: '{{token}}' })],
    }).success
  ).toBe(false)
})

const withRequest = (request: object, step: object = {}) => ({
  name: 'x',
  description: 'y',
  steps: [{ name: 's', request, expect: { status: 200 }, ...step }],
})

test('a request can carry extra headers, and a step can capture headers and whole values', () => {
  const parsed = ScenarioSchema.safeParse(
    withRequest(
      {
        method: 'PUT',
        path: '/v1/x',
        headers: { 'If-Match': '{{etag}}', Origin: 'https://a.test' },
      },
      { captureHeaders: { etag: 'ETag' }, captureJson: { original: 'settings' } }
    )
  )
  expect(parsed.success).toBe(true)
})

test.each([
  ['Authorization'],
  ['authorization'],
  ['X-Tula-Publishable-Key'],
  ['x-tula-client'],
  ['X-Tula-Attempt'],
  ['x-tula-attempt'],
  ['X-Forwarded-For'],
  ['Content-Type'],
  ['User-Agent'],
])('a request cannot override the %s header the runner sets', (name) => {
  expect(
    ScenarioSchema.safeParse(
      withRequest({ method: 'GET', path: '/v1/x', headers: { [name]: 'x' } })
    ).success
  ).toBe(false)
})

test.each([
  ['a space', 'If Match'],
  ['a colon', 'If-Match:'],
  ['a line break', 'X-A\r\nX-B'],
  ['nothing', ''],
])('a header name with %s is refused', (_name, header) => {
  expect(
    ScenarioSchema.safeParse(
      withRequest({ method: 'GET', path: '/v1/x', headers: { [header]: 'x' } })
    ).success
  ).toBe(false)
  expect(
    ScenarioSchema.safeParse(
      withRequest({ method: 'GET', path: '/v1/x' }, { captureHeaders: { v: header } })
    ).success
  ).toBe(false)
})

test('a totp step names the secret and where the code goes, and nothing unknown', () => {
  const scenario = (totp: object, extra: object = {}) => ({
    name: 'n',
    description: 'd',
    steps: [{ name: 'compute', totp, ...extra }],
  })
  expect(
    ScenarioSchema.safeParse(scenario({ secret: '{{secret}}', capture: 'code' })).success
  ).toBe(true)
  expect(
    ScenarioSchema.safeParse(
      scenario({ secret: '{{secret}}', capture: 'code', captureWrong: 'wrongCode' })
    ).success
  ).toBe(true)
  expect(ScenarioSchema.safeParse(scenario({ secret: '{{secret}}' })).success).toBe(false)
  expect(ScenarioSchema.safeParse(scenario({ capture: 'code' })).success).toBe(false)
  expect(
    ScenarioSchema.safeParse(scenario({ secret: 's', capture: 'code' }, { wait: '30s' })).success
  ).toBe(false)
})

test('expected claims are keyed by the path of the token in the body', () => {
  const scenario = (claims: unknown) => ({
    name: 'n',
    description: 'd',
    steps: [
      {
        name: 'sign in',
        request: { method: 'POST', path: '/x' },
        expect: { status: 200, claims },
      },
    ],
  })
  expect(
    ScenarioSchema.safeParse(scenario({ 'session.accessToken': { amr: ['pwd', 'otp', 'mfa'] } }))
      .success
  ).toBe(true)
  expect(ScenarioSchema.safeParse(scenario(['session.accessToken'])).success).toBe(false)
})

test('a scenario that reads a text message must say so, so it is skipped where there is no inbox', () => {
  const read = { name: 'read', smsCode: { to: '{{phone}}', capture: 'code' } }
  const base = { name: 'n', description: 'd', steps: [read] }
  expect(ScenarioSchema.safeParse(base).success).toBe(false)
  expect(ScenarioSchema.safeParse({ ...base, needsSmsInbox: false }).success).toBe(false)
  expect(ScenarioSchema.safeParse({ ...base, needsSmsInbox: true }).success).toBe(true)
  // In the cleanup too.
  const step = { name: 's', request: { method: 'GET', path: '/x' }, expect: { status: 200 } }
  expect(
    ScenarioSchema.safeParse({ name: 'n', description: 'd', steps: [step], cleanup: [read] })
      .success
  ).toBe(false)
  // Nothing unknown in the step.
  expect(
    ScenarioSchema.safeParse({
      ...base,
      needsSmsInbox: true,
      steps: [{ name: 'read', smsCode: { to: 'x', capture: 'code', body: true } }],
    }).success
  ).toBe(false)
})

test('a variable is generated only as a kind the runner knows', () => {
  const scenario = (generate: string) => ({
    name: 'n',
    description: 'd',
    variables: { value: { generate } },
    steps: [{ name: 's', request: { method: 'GET', path: '/x' }, expect: { status: 200 } }],
  })
  for (const kind of ['email', 'password', 'phone', 'phone_fr']) {
    expect(ScenarioSchema.safeParse(scenario(kind)).success).toBe(true)
  }
  expect(ScenarioSchema.safeParse(scenario('address')).success).toBe(false)
})
