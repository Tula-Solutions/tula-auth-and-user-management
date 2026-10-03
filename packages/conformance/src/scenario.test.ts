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
