import { afterEach, describe, expect, test } from 'bun:test'
import { CreatedHookSchema, HookListSchema, HookSchema } from '@tula/contract'
import { type FakeApi, fakeHook, IDS, installFakeApi } from './fake-api'

// The fake's hook routes answer as the API does where the screen can tell the difference
// (`apps/api/src/modules/hook`: `schema.ts` and the contract for what is refused,
// `service.ts` for what a change does). These tests hold the fake to what was read there.

let api: FakeApi | undefined

afterEach(() => {
  api?.restore()
  api = undefined
})

/** The fake, with a dashboard session: every admin route is behind one. */
function signedIn(): FakeApi {
  api = installFakeApi()
  api.state.signedIn = true
  return api
}

const ROOT = '/v1/admin/hooks'
const NO_SUCH = '00000000-0000-7000-8000-ffffffffffff'
const ASK = 'https://api.example.com/hooks/tula'

async function call(
  method: string,
  path: string,
  body?: unknown,
  environment: string = IDS.development
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`http://localhost${path}`, {
    method,
    headers: {
      'x-tula-dashboard': '1',
      'x-tula-environment': environment,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text === '' ? {} : JSON.parse(text),
    headers: response.headers,
  }
}

function fields(body: Record<string, unknown>): string[] {
  return (body.errors as { field: string }[] | undefined)?.map((entry) => entry.field) ?? []
}

describe('what the API refuses before it looks, the fake refuses the same way', () => {
  test.each([
    ['GET', '/not-an-id', undefined],
    ['PATCH', '/not-an-id', { enabled: false }],
    ['DELETE', '/not-an-id', undefined],
  ])('%s %s: an id that is no UUID is 422 validation.failed', async (method, path, body) => {
    signedIn()
    const answer = await call(method, `${ROOT}${path}`, body)
    expect([answer.status, answer.body.code, fields(answer.body)]).toEqual([
      422,
      'validation.failed',
      ['id'],
    ])
  })

  test.each([
    ['no point', { url: ASK }, ['point']],
    ['a point that does not exist', { point: 'before_refresh', url: ASK }, ['point']],
    ['a secret of the caller’s own', { point: 'before_token', url: ASK, secret: 'x' }, ['(root)']],
    [
      'a deadline over the cap',
      { point: 'before_token', url: ASK, deadlineMs: 5001 },
      ['deadlineMs'],
    ],
    [
      'a deadline under the floor',
      { point: 'before_token', url: ASK, deadlineMs: 99 },
      ['deadlineMs'],
    ],
    ['an unknown mode', { point: 'before_token', url: ASK, failureMode: 'retry' }, ['failureMode']],
    ['a space in the address', { point: 'before_token', url: 'https://a b' }, ['url']],
  ])(
    'a registration with %s is 422 on that field, and nothing is stored',
    async (_name, body, at) => {
      const fake = signedIn()
      const answer = await call('POST', ROOT, body)
      expect([answer.status, answer.body.code, fields(answer.body)]).toEqual([
        422,
        'validation.failed',
        at,
      ])
      expect(fake.state.hooks).toHaveLength(0)
    }
  )

  test.each([
    ['nothing to change', {}, ['(root)']],
    // An unknown key, and then nothing left to change: the schema says both.
    ['the point', { point: 'before_token' }, ['(root)', '(root)']],
    ['a secret', { secret: 'whsec_x' }, ['(root)', '(root)']],
  ])('an update that names %s is 422, before the hook is looked up', async (_name, body, at) => {
    signedIn()
    const answer = await call('PATCH', `${ROOT}/${NO_SUCH}`, body)
    expect([answer.status, fields(answer.body)]).toEqual([422, at])
  })

  test('an id that is one but names nothing here is 404', async () => {
    signedIn()
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { enabled: false }],
      ['DELETE', undefined],
    ] as const) {
      const answer = await call(method, `${ROOT}/${NO_SUCH}`, body)
      expect([answer.status, answer.body.code]).toEqual([404, 'resource.not_found'])
    }
  })
})

describe('a registration', () => {
  test('fills the contract’s defaults, answers 201 with the secret, uncacheable, and lists without it', async () => {
    const fake = signedIn()
    const created = await call('POST', ROOT, { point: 'before_session', url: ASK })
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const hook = CreatedHookSchema.parse(created.body)
    expect(hook).toMatchObject({
      point: 'before_session',
      url: ASK,
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
      lastFailedAt: null,
      lastFailureReason: null,
    })
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{20,}$/)

    const listed = await call('GET', ROOT)
    expect(HookListSchema.parse(listed.body).data.map((entry) => entry.id)).toEqual([hook.id])
    const read = await call('GET', `${ROOT}/${hook.id}`)
    expect(HookSchema.parse(read.body).id).toBe(hook.id)
    for (const answer of [listed, read]) {
      expect(JSON.stringify(answer.body)).not.toContain('whsec_')
      expect(JSON.stringify(answer.body)).not.toContain('secret')
    }
    expect(fake.state.hooks).toHaveLength(1)
  })

  test('a point has one hook per environment: a second is 409, and another environment’s is its own', async () => {
    const fake = signedIn()
    expect((await call('POST', ROOT, { point: 'before_token', url: ASK })).status).toBe(201)
    const second = await call('POST', ROOT, { point: 'before_token', url: `${ASK}/2` })
    expect([second.status, second.body.code]).toEqual([409, 'resource.conflict'])
    const production = await call('POST', ROOT, { point: 'before_token', url: ASK }, IDS.production)
    expect(production.status).toBe(201)
    expect(fake.state.hooks.map((hook) => hook.environmentId)).toEqual([
      IDS.development,
      IDS.production,
    ])
    // One environment does not see, change or remove another's.
    const other = fake.state.hooks[1]?.id ?? ''
    expect((await call('GET', ROOT)).body.data).toHaveLength(1)
    expect((await call('GET', `${ROOT}/${other}`)).status).toBe(404)
    expect((await call('PATCH', `${ROOT}/${other}`, { enabled: false })).status).toBe(404)
    expect((await call('DELETE', `${ROOT}/${other}`)).status).toBe(404)
    expect(fake.state.hooks[1]?.enabled).toBe(true)
  })

  test.each([
    ['http://api.example.com/hooks', 'scheme_not_allowed'],
    ['https://127.0.0.1/hooks', 'address_not_allowed'],
    ['https://nowhere.invalid/hooks', 'resolve_failed'],
    ['https://user:pw@api.example.com/hooks', 'invalid_url'],
  ])(
    'the guard refuses %s with its fixed word, before the point is looked at',
    async (url, reason) => {
      const fake = signedIn()
      fake.state.hooks.push(fakeHook({ point: 'before_sign_up' }))
      const answer = await call('POST', ROOT, { point: 'before_sign_up', url })
      expect([answer.status, answer.body.code, answer.body.params]).toEqual([
        422,
        'hook.url_not_allowed',
        { reason },
      ])
      expect(fake.state.hooks).toHaveLength(1)
    }
  )
})

describe('a change', () => {
  test('only what differs moves, and only then does `updatedAt`', async () => {
    const fake = signedIn()
    const hook = fakeHook({ url: ASK })
    fake.state.hooks.push(hook)
    fake.state.hookNow = '2026-10-05T12:00:00.000Z'
    const same = await call('PATCH', `${ROOT}/${hook.id}`, {
      url: ASK,
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
    })
    expect(same.status).toBe(200)
    expect(same.body.updatedAt).toBe('2026-10-04T12:00:00.000Z')

    const changed = await call('PATCH', `${ROOT}/${hook.id}`, {
      failureMode: 'allow',
      enabled: true,
    })
    expect(HookSchema.parse(changed.body)).toMatchObject({
      failureMode: 'allow',
      enabled: true,
      url: ASK,
      updatedAt: '2026-10-05T12:00:00.000Z',
    })
    expect(JSON.stringify(changed.body)).not.toContain('secret')
  })

  test('an address is judged only when it changes', async () => {
    const fake = signedIn()
    // Stored before the guard would refuse it (a name that no longer resolves).
    const hook = fakeHook({ url: 'https://nowhere.invalid/hooks' })
    fake.state.hooks.push(hook)
    const kept = await call('PATCH', `${ROOT}/${hook.id}`, {
      url: 'https://nowhere.invalid/hooks',
      deadlineMs: 900,
    })
    expect([kept.status, kept.body.deadlineMs]).toEqual([200, 900])
    const moved = await call('PATCH', `${ROOT}/${hook.id}`, { url: 'https://localhost/hooks' })
    expect([moved.status, moved.body.code, moved.body.params]).toEqual([
      422,
      'hook.url_not_allowed',
      { reason: 'address_not_allowed' },
    ])
    expect(fake.state.hooks[0]?.url).toBe('https://nowhere.invalid/hooks')
  })

  test('a removal answers 204 with no body, and the point can have a hook again', async () => {
    const fake = signedIn()
    const hook = fakeHook({ point: 'before_token' })
    fake.state.hooks.push(hook)
    const removed = await call('DELETE', `${ROOT}/${hook.id}`)
    expect([removed.status, removed.body]).toEqual([204, {}])
    expect(fake.state.hooks).toHaveLength(0)
    expect((await call('POST', ROOT, { point: 'before_token', url: ASK })).status).toBe(201)
  })
})
