import { describe, expect, test } from 'bun:test'
import { ERROR_DEFINITIONS } from './error-codes'
import { EVENT_FIXTURES } from './event-fixtures'
import { ACTIVITY_TYPES, EVENT_TARGET_TYPES } from './event-types'
import { EVENT_DATA_SCHEMAS, TulaEventSchema } from './events'
import {
  CreatedHookSchema,
  CreateHookRequestSchema,
  HOOK_ANSWER_KINDS,
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
  HookClaimsAnswerSchema,
  HookQuestionSchema,
  HookSchema,
  hookWeakenings,
  readHookClaimsAnswer,
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
    ['a point that does not exist', { point: 'before_refresh', url }],
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
    expect(HOOK_POINTS).toEqual(['before_sign_up', 'before_session', 'before_token'])
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

  test.each([
    ['password'],
    ['passwordless'],
    ['oauth_google'],
    ['oauth_github'],
    ['oauth_apple'],
    ['oauth_microsoft'],
    ['oauth_discord'],
    ['oauth_linkedin'],
  ])('a sign-up made by %s can be asked about', (method) => {
    const fixture = HOOK_QUESTION_FIXTURES.before_sign_up
    expect(
      HOOK_QUESTION_SCHEMAS.before_sign_up.safeParse({
        ...fixture,
        data: { ...fixture.data, method },
      }).success
    ).toBe(true)
  })

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

  test('before a session it holds the user, the client, the profile, what was proven, whether it is a sign-up and the IP address', () => {
    const { data } = HOOK_QUESTION_FIXTURES.before_session
    expect(Object.keys(data).sort()).toEqual([
      'amr',
      'client',
      'ipAddress',
      'profile',
      'signUp',
      'userId',
    ])
  })

  test('before a token it holds the user, the session, the client, the profile and what was proven', () => {
    const { data } = HOOK_QUESTION_FIXTURES.before_token
    expect(Object.keys(data).sort()).toEqual(['amr', 'client', 'profile', 'sessionId', 'userId'])
  })

  // The address is in `before_sign_up` because no account exists yet to name. Once there is
  // one, its id names it, and nothing a request said about itself goes along.
  test.each(
    (['before_session', 'before_token'] as const).flatMap((point) =>
      [
        'email',
        'password',
        'passwordHash',
        'code',
        'token',
        'accessToken',
        'refreshToken',
        'attemptId',
        'attemptSecret',
        'secret',
        'userAgent',
        'firstName',
        'lastName',
        'emailVerified',
        'claims',
      ].map((key) => [point, key] as const)
    )
  )('a %s question never holds %s: the schema is strict', (point, key) => {
    const fixture = HOOK_QUESTION_FIXTURES[point]
    const question = { ...fixture, data: { ...fixture.data, [key]: 'x' } }
    expect(HOOK_QUESTION_SCHEMAS[point].safeParse(question).success).toBe(false)
    expect(HookQuestionSchema.safeParse(question).success).toBe(false)
  })

  test('a token question has no IP address and a session question no session: neither exists there', () => {
    const session = HOOK_QUESTION_FIXTURES.before_session
    const token = HOOK_QUESTION_FIXTURES.before_token
    expect(
      HOOK_QUESTION_SCHEMAS.before_session.safeParse({
        ...session,
        data: { ...session.data, sessionId: token.data.sessionId },
      }).success
    ).toBe(false)
    expect(
      HOOK_QUESTION_SCHEMAS.before_token.safeParse({
        ...token,
        data: { ...token.data, ipAddress: '203.0.113.7' },
      }).success
    ).toBe(false)
  })

  test.each([
    ['a method in upper case', ['PWD']],
    ['a method with a space', ['pwd otp']],
    ['a method that is a sentence', ['x'.repeat(33)]],
    ['more methods than there could be', Array.from({ length: 17 }, (_, n) => `m${n}`)],
    ['something that is not a list', 'pwd'],
  ])('what was proven is a short list of bounded names: %s is refused', (_name, amr) => {
    for (const point of ['before_session', 'before_token'] as const) {
      const fixture = HOOK_QUESTION_FIXTURES[point]
      expect(
        HOOK_QUESTION_SCHEMAS[point].safeParse({ ...fixture, data: { ...fixture.data, amr } })
          .success
      ).toBe(false)
    }
  })

  test('one point’s data is not another’s question', () => {
    const {
      before_sign_up: signUp,
      before_session: session,
      before_token: token,
    } = HOOK_QUESTION_FIXTURES
    expect(HookQuestionSchema.safeParse({ ...signUp, data: session.data }).success).toBe(false)
    expect(HookQuestionSchema.safeParse({ ...session, data: token.data }).success).toBe(false)
    expect(HookQuestionSchema.safeParse({ ...token, data: signUp.data }).success).toBe(false)
  })
})

describe('what each point takes for an answer', () => {
  test('a sign-up and a session are decided; a token is given claims', () => {
    expect(HOOK_ANSWER_KINDS).toEqual({
      before_sign_up: 'decision',
      before_session: 'decision',
      before_token: 'claims',
    })
  })
})

describe('the answer of a claims hook', () => {
  const read = (body: unknown) => readHookClaimsAnswer(body)

  test('claims under one key, and nothing else', () => {
    expect(read({ claims: { role: 'admin', seats: 3, staff: false } })).toEqual({
      claims: { role: 'admin', seats: 3, staff: false },
    })
    expect(HookClaimsAnswerSchema.safeParse({ claims: { role: 'admin' } }).success).toBe(true)
  })

  test('no claims is an answer: the token is issued without any of the hook’s', () => {
    expect(read({ claims: {} })).toEqual({ claims: {} })
    expect(HookClaimsAnswerSchema.safeParse({ claims: {} }).success).toBe(true)
  })

  // Not an answer at all: the shape is wrong. Never read as "no claims".
  test.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'claims'],
    ['a list', [{ claims: {} }]],
    ['an empty object', {}],
    ['a decision', { decision: 'allow' }],
    ['claims beside a decision', { decision: 'allow', claims: { role: 'admin' } }],
    ['a subject beside the claims', { claims: { role: 'admin' }, sub: 'someone-else' }],
    ['methods beside the claims', { claims: {}, amr: ['mfa'] }],
    ['a verified address beside the claims', { claims: {}, emailVerified: true }],
    ['a user beside the claims', { claims: {}, userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01' }],
    ['a `__proto__` key beside the claims', JSON.parse('{"claims":{},"__proto__":{"a":1}}')],
    ['claims that are a list', { claims: ['admin'] }],
    ['claims that are a string', { claims: 'role=admin' }],
    ['claims that are null', { claims: null }],
  ])('%s is not an answer', (_name, body) => {
    expect(read(body)).toEqual({ problem: 'answer_invalid' })
    expect(HookClaimsAnswerSchema.safeParse(body).success).toBe(false)
  })

  // The shape is right and a claim breaks a rule: the whole answer fails, nothing is applied.
  test.each([
    ['a reserved name', { claims: { role: 'admin', sub: 'someone-else' } }],
    ['the methods', { claims: { amr: 'mfa' } }],
    ['the namespace itself', { claims: { ext: 'x' } }],
    ['a key outside the grammar', { claims: { 'my-claim': 1 } }],
    ['a nested object', { claims: { role: { name: 'admin' } } }],
    ['a list value', { claims: { roles: ['admin'] } }],
    ['a null value', { claims: { role: null } }],
  ])('%s among the claims fails the whole answer', (_name, body) => {
    expect(read(body)).toEqual({ problem: 'claims_invalid' })
    expect(HookClaimsAnswerSchema.safeParse(body).success).toBe(false)
  })

  test('a `__proto__` claim fails the answer; it is not silently dropped', () => {
    const body: unknown = JSON.parse('{"claims":{"role":"admin","__proto__":{"admin":true}}}')
    expect(read(body)).toEqual({ problem: 'claims_invalid' })
  })

  test('claims over the cap fail the whole answer', () => {
    const at = { claims: { a: 'x'.repeat(1016) } }
    expect(read(at)).toEqual(at)
    expect(read({ claims: { a: 'x'.repeat(1017) } })).toEqual({ problem: 'claims_too_large' })
    expect(HookClaimsAnswerSchema.safeParse({ claims: { a: 'x'.repeat(1017) } }).success).toBe(
      false
    )
  })

  test('every problem is a failure reason an operator can be shown', () => {
    for (const problem of ['answer_invalid', 'claims_invalid', 'claims_too_large'] as const) {
      expect(HOOK_FAILURE_REASONS).toContain(problem)
    }
  })

  test('a decision is not a claims answer and claims are not a decision', () => {
    expect(HookAnswerSchema.safeParse({ claims: {} }).success).toBe(false)
    expect(HookClaimsAnswerSchema.safeParse({ decision: 'allow' }).success).toBe(false)
  })
})

describe('what is recorded about a session and its hooks', () => {
  test('a session let through because its hook failed says so, and so does one without the claims hook’s claims', () => {
    const schema = EVENT_DATA_SCHEMAS['session.created']
    const created = { userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01', client: 'web' as const }
    expect(schema.parse(created)).toEqual(created)
    expect(schema.parse({ ...created, hookBypassed: true }).hookBypassed).toBe(true)
    expect(schema.parse({ ...created, claimsHookBypassed: true }).claimsHookBypassed).toBe(true)
  })

  test('a step-up made without the claims hook’s claims says so', () => {
    const schema = EVENT_DATA_SCHEMAS['session.stepped_up']
    const stepped = {
      userId: '0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01',
      methods: ['otp' as const, 'mfa' as const],
    }
    expect(schema.parse({ ...stepped, claimsHookBypassed: true }).claimsHookBypassed).toBe(true)
    expect(schema.parse(stepped)).toEqual(stepped)
  })

  test.each([['session.created'], ['session.stepped_up']] as const)(
    '%s has no field for a claim, a denial code or an address: booleans only',
    (type) => {
      const { shape } = EVENT_DATA_SCHEMAS[type]
      for (const key of ['claims', 'code', 'url', 'email', 'ipAddress', 'reason']) {
        expect(Object.keys(shape)).not.toContain(key)
      }
      for (const flag of Object.keys(shape).filter((key) => key.endsWith('Bypassed'))) {
        expect(
          EVENT_DATA_SCHEMAS[type].safeParse({ ...EVENT_FIXTURES[type].data, [flag]: 'yes' })
            .success
        ).toBe(false)
      }
    }
  )
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
