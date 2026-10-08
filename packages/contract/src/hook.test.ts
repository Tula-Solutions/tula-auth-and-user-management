import { describe, expect, test } from 'bun:test'
import { ERROR_DEFINITIONS } from './error-codes'
import { EVENT_FIXTURES } from './event-fixtures'
import { ACTIVITY_TYPES, EVENT_TARGET_TYPES } from './event-types'
import { EVENT_DATA_SCHEMAS, TulaEventSchema } from './events'
import {
  CreatedHookSchema,
  CreateHookRequestSchema,
  HOOK_DEFAULT_DEADLINE_MS,
  HOOK_FAILURE_REASONS,
  HOOK_FIELDS,
  HOOK_MAX_DEADLINE_MS,
  HOOK_MAX_DENIAL_CODE_LENGTH,
  HOOK_MIN_DEADLINE_MS,
  HOOK_POINTS,
  HOOK_QUESTION_FIXTURES,
  HOOK_QUESTION_SCHEMAS,
  HOOK_QUESTION_TYPES,
  HookAnswerSchema,
  HookQuestionSchema,
  HookSchema,
  hookWeakenings,
  UpdateHookRequestSchema,
} from './hook'

const url = 'https://app.example.com/tula/before-sign-up'

const hook = {
  id: '0199c2f4-7a19-7bcc-8adb-de8f9c5b6a10',
  point: 'before_sign_up',
  url,
  enabled: true,
  deadlineMs: 2000,
  failureMode: 'deny',
  lastFailedAt: null,
  lastFailureReason: null,
  createdAt: '2026-10-08T09:30:00.000Z',
  updatedAt: '2026-10-08T09:30:00.000Z',
}

describe('the deadline', () => {
  test('is two seconds unless the operator says otherwise, and never above five', () => {
    expect(HOOK_DEFAULT_DEADLINE_MS).toBe(2000)
    expect(HOOK_MAX_DEADLINE_MS).toBe(5000)
    expect(CreateHookRequestSchema.parse({ point: 'before_sign_up', url }).deadlineMs).toBe(2000)
  })

  test.each([
    [HOOK_MIN_DEADLINE_MS, true],
    [HOOK_MAX_DEADLINE_MS, true],
    [HOOK_MIN_DEADLINE_MS - 1, false],
    [HOOK_MAX_DEADLINE_MS + 1, false],
    [60_000, false],
    [0, false],
    [-1, false],
    [2000.5, false],
    ['2000', false],
    [null, false],
  ])('a deadline of %p: accepted %p, at creation and by an update', (deadlineMs, accepted) => {
    expect(
      CreateHookRequestSchema.safeParse({ point: 'before_sign_up', url, deadlineMs }).success
    ).toBe(accepted)
    expect(UpdateHookRequestSchema.safeParse({ deadlineMs }).success).toBe(accepted)
  })
})

describe('CreateHookRequestSchema', () => {
  const accepts = (body: unknown) => CreateHookRequestSchema.safeParse(body).success

  test('a hook is on and refuses on failure unless it says otherwise', () => {
    expect(CreateHookRequestSchema.parse({ point: 'before_sign_up', url })).toEqual({
      point: 'before_sign_up',
      url,
      enabled: true,
      deadlineMs: 2000,
      failureMode: 'deny',
    })
  })

  test.each([
    ['no point', { url }],
    ['a point that does not exist', { point: 'before_session', url }],
    ['no address', { point: 'before_sign_up' }],
    ['an empty address', { point: 'before_sign_up', url: '' }],
    ['an address with a space', { point: 'before_sign_up', url: 'https://a.example/x y' }],
    ['an address with a line break', { point: 'before_sign_up', url: 'https://a.example/x\ny' }],
    [
      'an address that is too long',
      { point: 'before_sign_up', url: `https://a.example/${'a'.repeat(2048)}` },
    ],
    ['a failure mode that does not exist', { point: 'before_sign_up', url, failureMode: 'ignore' }],
    ['a secret of the caller’s own', { point: 'before_sign_up', url, secret: 'whsec_abc' }],
    ['an unknown key', { point: 'before_sign_up', url, claims: {} }],
  ])('refuses %s', (_name, body) => {
    expect(accepts(body)).toBe(false)
  })
})

describe('UpdateHookRequestSchema', () => {
  const accepts = (body: unknown) => UpdateHookRequestSchema.safeParse(body).success

  test.each([
    [{ url }],
    [{ enabled: false }],
    [{ deadlineMs: 100 }],
    [{ failureMode: 'allow' }],
    [{ url, enabled: true, deadlineMs: 5000, failureMode: 'deny' }],
  ])('accepts %p', (body) => {
    expect(accepts(body)).toBe(true)
  })

  test.each([
    ['nothing', {}],
    ['the point: a hook stays at the point it was registered for', { point: 'before_sign_up' }],
    ['a secret', { secret: 'whsec_abc' }],
    ['an unknown key', { url, name: 'x' }],
  ])('refuses %s', (_name, body) => {
    expect(accepts(body)).toBe(false)
  })
})

describe('a hook as it is read', () => {
  test('has no secret, and the response that creates it has one', () => {
    expect(Object.keys(HookSchema.parse({ ...hook, secret: 'whsec_x' }))).not.toContain('secret')
    expect(CreatedHookSchema.parse({ ...hook, secret: 'whsec_x' }).secret).toBe('whsec_x')
    expect(CreatedHookSchema.safeParse(hook).success).toBe(false)
  })

  test('says when it last failed and why, in a fixed word', () => {
    const failed = HookSchema.parse({
      ...hook,
      lastFailedAt: '2026-10-08T10:00:00.000Z',
      lastFailureReason: 'timeout',
    })
    expect(failed.lastFailureReason).toBe('timeout')
    expect(HOOK_FAILURE_REASONS).toContain('timeout')
    expect(HOOK_FAILURE_REASONS).toContain('answer_invalid')
    expect(HOOK_FAILURE_REASONS).toContain('status_not_ok')
    expect(HOOK_FAILURE_REASONS).toContain('secret_unreadable')
    for (const reason of HOOK_FAILURE_REASONS) {
      expect(reason).toMatch(/^[a-z_]+$/)
    }
  })
})

describe('the answer of a hook', () => {
  const accepts = (body: unknown) => HookAnswerSchema.safeParse(body).success

  test.each([
    [{ decision: 'allow' }],
    [{ decision: 'deny' }],
    [{ decision: 'deny', code: 'disposable_email' }],
    [{ decision: 'deny', code: 'a' }],
    [{ decision: 'deny', code: 'a'.repeat(HOOK_MAX_DENIAL_CODE_LENGTH) }],
    [{ decision: 'deny', code: 'region_42_blocked' }],
  ])('%p is an answer', (body) => {
    expect(accepts(body)).toBe(true)
  })

  // Each of these is a failure, handled by the hook's failure mode: never read as an allow
  // with something extra, and never as a denial.
  test.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'allow'],
    ['a list', [{ decision: 'allow' }]],
    ['an empty object', {}],
    ['another decision', { decision: 'maybe' }],
    ['a decision in another case', { decision: 'ALLOW' }],
    ['a boolean decision', { decision: true }],
    ['an allow with a code', { decision: 'allow', code: 'fine' }],
    ['an unknown key beside an allow', { decision: 'allow', emailVerified: true }],
    ['a user to sign up as', { decision: 'allow', userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01' }],
    ['a second factor to skip', { decision: 'allow', skipSecondFactor: true }],
    ['claims', { decision: 'allow', claims: { role: 'admin' } }],
    ['an unknown key beside a denial', { decision: 'deny', code: 'x', message: 'Go away' }],
    ['an empty code', { decision: 'deny', code: '' }],
    [
      'a code that is too long',
      { decision: 'deny', code: 'a'.repeat(HOOK_MAX_DENIAL_CODE_LENGTH + 1) },
    ],
    ['a code in upper case', { decision: 'deny', code: 'Disposable' }],
    ['a code with a space', { decision: 'deny', code: 'not allowed' }],
    ['a code with a dot', { decision: 'deny', code: 'hook.denied' }],
    ['a code with markup', { decision: 'deny', code: '<b>no</b>' }],
    ['a code with a line break', { decision: 'deny', code: 'no\n' }],
    ['a code that is not a string', { decision: 'deny', code: 7 }],
    ['a null code', { decision: 'deny', code: null }],
  ])('%s is not an answer', (_name, body) => {
    expect(accepts(body)).toBe(false)
  })
})

describe('the question of a hook', () => {
  test('every point has a type, a schema and an example that its schema accepts', () => {
    expect(HOOK_POINTS).toEqual(['before_sign_up'])
    for (const point of HOOK_POINTS) {
      expect(HOOK_QUESTION_TYPES[point]).toBe(`hook.${point}`)
      const fixture = HOOK_QUESTION_FIXTURES[point]
      expect(HOOK_QUESTION_SCHEMAS[point].parse(fixture)).toEqual(fixture)
      expect(HookQuestionSchema.parse(fixture)).toEqual(fixture)
    }
  })

  test('before a sign-up it holds the address, how the sign-up is made, the client and the IP address', () => {
    const { data } = HOOK_QUESTION_FIXTURES.before_sign_up
    expect(Object.keys(data).sort()).toEqual(['client', 'email', 'ipAddress', 'method'])
  })

  test.each([
    'password',
    'passwordHash',
    'code',
    'token',
    'attemptId',
    'attemptSecret',
    'secret',
    'userAgent',
    'subject',
    'firstName',
    'lastName',
    'userId',
  ])('a question never holds %s: the schema is strict', (key) => {
    const fixture = HOOK_QUESTION_FIXTURES.before_sign_up
    const question = { ...fixture, data: { ...fixture.data, [key]: 'x' } }
    expect(HOOK_QUESTION_SCHEMAS.before_sign_up.safeParse(question).success).toBe(false)
  })

  test.each([['password'], ['passwordless'], ['oauth_google'], ['oauth_github'], ['oauth_apple']])(
    'a sign-up made by %s can be asked about',
    (method) => {
      const fixture = HOOK_QUESTION_FIXTURES.before_sign_up
      expect(
        HOOK_QUESTION_SCHEMAS.before_sign_up.safeParse({
          ...fixture,
          data: { ...fixture.data, method },
        }).success
      ).toBe(true)
    }
  )

  test('an address that is not known is null, never left out', () => {
    const fixture = HOOK_QUESTION_FIXTURES.before_sign_up
    const schema = HOOK_QUESTION_SCHEMAS.before_sign_up
    expect(
      schema.safeParse({ ...fixture, data: { ...fixture.data, ipAddress: null } }).success
    ).toBe(true)
    const { ipAddress: _ip, ...rest } = fixture.data
    expect(schema.safeParse({ ...fixture, data: rest }).success).toBe(false)
  })

  test('a question is not an event, and an event is not a question', () => {
    for (const point of HOOK_POINTS) {
      expect(TulaEventSchema.safeParse(HOOK_QUESTION_FIXTURES[point]).success).toBe(false)
    }
    for (const type of ACTIVITY_TYPES) {
      expect(HookQuestionSchema.safeParse(EVENT_FIXTURES[type]).success).toBe(false)
    }
  })

  test('no question type is the name of an event', () => {
    for (const type of Object.values(HOOK_QUESTION_TYPES)) {
      expect(ACTIVITY_TYPES as readonly string[]).not.toContain(type)
    }
  })
})

describe('what is recorded about a hook', () => {
  test('its registration, a change and its removal are events about the hook', () => {
    for (const type of ['hook.created', 'hook.updated', 'hook.deleted'] as const) {
      expect(ACTIVITY_TYPES).toContain(type)
      expect(EVENT_TARGET_TYPES[type]).toBe('hook')
    }
  })

  test('a change names fields, never an address or a secret', () => {
    const schema = EVENT_DATA_SCHEMAS['hook.updated']
    expect(HOOK_FIELDS).toEqual(['url', 'enabled', 'deadlineMs', 'failureMode'])
    expect(schema.safeParse({ point: 'before_sign_up', changed: [...HOOK_FIELDS] }).success).toBe(
      true
    )
    expect(schema.safeParse({ point: 'before_sign_up', changed: [] }).success).toBe(false)
    expect(schema.safeParse({ point: 'before_sign_up', changed: ['secret'] }).success).toBe(false)
    expect(schema.safeParse({ point: 'before_sign_up', changed: [url] }).success).toBe(false)
  })

  test('no event about a hook has a field for its address or its secret', () => {
    for (const type of ['hook.created', 'hook.updated', 'hook.deleted'] as const) {
      const keys = Object.keys(EVENT_DATA_SCHEMAS[type].shape)
      expect(keys).not.toContain('url')
      expect(keys).not.toContain('secret')
      expect(Object.keys(EVENT_FIXTURES[type].data).sort()).toEqual([...keys].sort())
    }
  })

  test('an account let through because the hook failed says so', () => {
    const schema = EVENT_DATA_SCHEMAS['user.created']
    const created = { method: 'sign_up', emailVerified: true }
    expect(schema.parse({ ...created, hookBypassed: true }).hookBypassed).toBe(true)
    expect(schema.parse(created).hookBypassed).toBeUndefined()
    expect(EVENT_FIXTURES['user.created'].data.hookBypassed).toBe(true)
  })
})

describe('hookWeakenings', () => {
  const strict = { enabled: true, failureMode: 'deny' } as const

  test.each([
    [
      'letting sign-ups through when the hook fails',
      strict,
      { ...strict, failureMode: 'allow' },
      ['failureMode'],
    ],
    ['switching the hook off', strict, { ...strict, enabled: false }, ['enabled']],
    ['both at once', strict, { enabled: false, failureMode: 'allow' }, ['enabled', 'failureMode']],
    ['removing a hook that is on', strict, null, ['enabled']],
    [
      'a hook that is off going to allow on failure',
      { ...strict, enabled: false },
      { enabled: false, failureMode: 'allow' },
      ['failureMode'],
    ],
    [
      'registering one that allows on failure',
      null,
      { ...strict, failureMode: 'allow' },
      ['failureMode'],
    ],
  ] as const)('%s is a weakening', (_name, was, is, fields) => {
    expect(hookWeakenings(was, is)).toEqual([...fields])
  })

  test.each([
    ['registering one that refuses on failure', null, strict],
    ['registering one switched off', null, { ...strict, enabled: false }],
    ['refusing on failure again', { ...strict, failureMode: 'allow' }, strict],
    ['switching it on', { ...strict, enabled: false }, strict],
    ['changing nothing', strict, strict],
    ['removing a hook that is off', { ...strict, enabled: false }, null],
    ['removing nothing', null, null],
  ] as const)('%s is not', (_name, was, is) => {
    expect(hookWeakenings(was, is)).toEqual([])
  })
})

describe('the error codes of a hook', () => {
  test('a denial is the user’s to read, a failure is "try again", and they are different codes', () => {
    expect(ERROR_DEFINITIONS['hook.denied'].status).toBe(403)
    expect(ERROR_DEFINITIONS['hook.unavailable'].status).toBe(503)
    expect(ERROR_DEFINITIONS['hook.url_not_allowed'].status).toBe(422)
  })
})
