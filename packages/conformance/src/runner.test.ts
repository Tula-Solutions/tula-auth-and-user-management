import { describe, expect, test } from 'bun:test'
import {
  exitCode,
  formatResult,
  nextOrigin,
  PUBLISHABLE_KEY_HEADER,
  runScenario,
  type Target,
} from './runner'
import { type Scenario, ScenarioSchema } from './scenario'
import { totp } from './totp'

interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

/** A target whose server is a function, recording every request it receives. */
function fakeTarget(
  respond: (
    seen: Seen,
    index: number
  ) => { status: number; body?: unknown; text?: string; headers?: Record<string, string> },
  overrides: Partial<Target> = {}
) {
  const requests: Seen[] = []
  const waits: number[] = []
  const target: Target = {
    baseUrl: 'http://tula.test',
    publishableKey: 'tula_pk_test',
    secretKey: 'tula_sk_test',
    fetch: async (request) => {
      const text = await request.text()
      const seen: Seen = {
        method: request.method,
        path: request.url.replace('http://tula.test', ''),
        headers: Object.fromEntries(request.headers),
        body: text ? JSON.parse(text) : undefined,
      }
      requests.push(seen)
      const { status, body, text: raw, headers } = respond(seen, requests.length - 1)
      return new Response(raw ?? (body === undefined ? null : JSON.stringify(body)), {
        status,
        headers,
      })
    },
    emailCode: async () => '123459',
    wait: async (ms) => {
      waits.push(ms)
    },
    ...overrides,
  }
  return { target, requests, waits }
}

const scenario = (steps: unknown[], extra: object = {}): Scenario =>
  ScenarioSchema.parse({ name: 'test', description: 'A test scenario.', steps, ...extra })

const get = (path: string, extra: object = {}) => ({ method: 'GET', path, ...extra })

describe('runScenario', () => {
  test('sends requests in order, capturing values for later steps', async () => {
    const { target, requests } = fakeTarget((_seen, index) =>
      index === 0
        ? { status: 200, body: { id: 'a1', session: { accessToken: 'jwt' } } }
        : { status: 204 }
    )
    const result = await runScenario(
      scenario(
        [
          {
            name: 'start',
            request: {
              method: 'POST',
              path: '/v1/client/sign-ups',
              client: 'ios',
              body: { email: '{{email}}', password: '{{password}}', note: '{{literal}}' },
            },
            expect: { status: 200, body: { id: '$any' } },
            capture: { attemptId: 'id', token: 'session.accessToken' },
          },
          {
            name: 'continue',
            request: get('/v1/client/attempts/{{attemptId}}', { accessToken: '{{token}}' }),
            expect: { status: 204 },
          },
        ],
        {
          variables: {
            email: { generate: 'email' },
            password: { generate: 'password' },
            literal: 'as written',
          },
        }
      ),
      target
    )
    expect(result).toEqual({
      name: 'test',
      status: 'passed',
      steps: [
        { name: 'start', ok: true, problems: [] },
        { name: 'continue', ok: true, problems: [] },
      ],
    })
    const [first, second] = requests
    expect(first).toMatchObject({
      method: 'POST',
      path: '/v1/client/sign-ups',
      headers: {
        [PUBLISHABLE_KEY_HEADER]: 'tula_pk_test',
        'x-tula-client': 'ios',
        'content-type': 'application/json',
        'user-agent': 'tula-conformance/1',
      },
      body: { note: 'as written' },
    })
    const sent = first?.body as { email: string; password: string }
    expect(sent.email).toMatch(/^conformance-[0-9a-f]{20}@example\.com$/)
    expect(sent.password).toMatch(/^Tu-[0-9a-f]{24}-Zq7!$/)
    expect(second).toMatchObject({
      path: '/v1/client/attempts/a1',
      headers: { authorization: 'Bearer jwt', [PUBLISHABLE_KEY_HEADER]: 'tula_pk_test' },
    })
    expect(second?.headers['content-type']).toBeUndefined()
  })

  test('attempt sends the captured secret as x-tula-attempt, and nothing when it is left out', async () => {
    const { target, requests } = fakeTarget((_seen, index) =>
      index === 0
        ? { status: 200, body: { id: 'a1', attemptSecret: 'tula_at_s3cret' } }
        : { status: 404 }
    )
    const result = await runScenario(
      scenario([
        {
          name: 'start',
          request: { method: 'POST', path: '/v1/client/sign-ins', body: {} },
          expect: { status: 200 },
          capture: { id: 'id', secret: 'attemptSecret' },
        },
        {
          name: 'with the secret',
          request: {
            method: 'POST',
            path: '/v1/client/sign-ins/{{id}}/password',
            attempt: '{{secret}}',
            body: {},
          },
          expect: { status: 404 },
        },
        {
          name: 'with a wrong one',
          request: {
            method: 'POST',
            path: '/v1/client/sign-ins/{{id}}/password',
            attempt: '{{secret}}x',
            body: {},
          },
          expect: { status: 404 },
        },
        {
          name: 'without',
          request: { method: 'POST', path: '/v1/client/sign-ins/{{id}}/password', body: {} },
          expect: { status: 404 },
        },
      ]),
      target
    )
    expect(result.status).toBe('passed')
    expect(requests.map((request) => request.headers['x-tula-attempt'])).toEqual([
      undefined,
      'tula_at_s3cret',
      'tula_at_s3cretx',
      undefined,
    ])
  })

  test('a captured attempt secret is never printed in a failure', async () => {
    const { target } = fakeTarget((_seen, index) =>
      index === 0
        ? { status: 200, body: { id: 'a1', attemptSecret: 'tula_at_s3cret-value' } }
        : { status: 200, body: { echoed: 'tula_at_s3cret-value' } }
    )
    const result = await runScenario(
      scenario([
        {
          name: 'start',
          request: { method: 'POST', path: '/v1/client/sign-ins', body: {} },
          expect: { status: 200 },
          capture: { secret: 'attemptSecret' },
        },
        {
          name: 'echo',
          request: get('/v1/x'),
          expect: { status: 200, body: { echoed: 'something else' } },
        },
      ]),
      target
    )
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('tula_at_s3cret-value')
  })

  test('auth decides which key is sent', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 200 }))
    await runScenario(
      scenario(
        [
          { name: 'admin', request: get('/a', { auth: 'secret' }), expect: { status: 200 } },
          { name: 'anonymous', request: get('/b', { auth: 'none' }), expect: { status: 200 } },
        ],
        { needsSecretKey: true }
      ),
      target
    )
    expect(requests[0]?.headers.authorization).toBe('Bearer tula_sk_test')
    expect(requests[0]?.headers[PUBLISHABLE_KEY_HEADER]).toBeUndefined()
    expect(requests[1]?.headers.authorization).toBeUndefined()
    expect(requests[1]?.headers[PUBLISHABLE_KEY_HEADER]).toBeUndefined()
  })

  test('a step marked for the second instance goes there; the rest go to the first', async () => {
    const hosts: string[] = []
    const { target, requests } = fakeTarget(() => ({ status: 204 }))
    const steps = scenario([
      { name: 'first by default', request: get('/a'), expect: { status: 204 } },
      { name: 'second', request: get('/b', { instance: 'second' }), expect: { status: 204 } },
      { name: 'first', request: get('/c', { instance: 'first' }), expect: { status: 204 } },
    ])
    const result = await runScenario(steps, {
      ...target,
      second: {
        baseUrl: 'http://second.test',
        fetch: async (request) => {
          hosts.push(request.url)
          // The same credentials and client address reach whichever instance is asked.
          expect(request.headers.get(PUBLISHABLE_KEY_HEADER)).toBe('tula_pk_test')
          expect(request.headers.get('x-forwarded-for')).toMatch(/^198\.18\./)
          return new Response(null, { status: 204 })
        },
      },
    })
    expect(result.status).toBe('passed')
    expect(hosts).toEqual(['http://second.test/b'])
    expect(requests.map((seen) => seen.path)).toEqual(['/a', '/c'])
  })

  test('with only one instance, a step for the second goes to the first', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 204 }))
    const result = await runScenario(
      scenario([
        { name: 'second', request: get('/b', { instance: 'second' }), expect: { status: 204 } },
      ]),
      target
    )
    expect(result.status).toBe('passed')
    expect(requests.map((seen) => seen.path)).toEqual(['/b'])
  })

  test('every request of a scenario comes from one address, and each run from another', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 200 }))
    const two = scenario([
      { name: 'one', request: get('/a'), expect: { status: 200 } },
      { name: 'two', request: get('/b'), expect: { status: 200 } },
    ])
    await runScenario(two, target)
    await runScenario(two, target)
    const origins = requests.map((request) => request.headers['x-forwarded-for'])
    expect(origins[0]).toMatch(/^198\.18\.\d+\.\d+$/)
    expect(origins[0]).toBe(origins[1] as string)
    expect(origins[2]).toBe(origins[3] as string)
    expect(origins[0]).not.toBe(origins[2])
  })

  test('stops at the first failing step and says what differed, without the body', async () => {
    const { target, requests } = fakeTarget(() => ({
      status: 401,
      body: { code: 'session.revoked', accessToken: 'secret-token-value' },
    }))
    const result = await runScenario(
      scenario([
        {
          name: 'refresh',
          request: get('/refresh'),
          expect: { status: 200, body: { code: 'ok', sessionId: '$any' } },
        },
        { name: 'never runs', request: get('/next'), expect: { status: 200 } },
      ]),
      target
    )
    expect(requests).toHaveLength(1)
    expect(result.status).toBe('failed')
    expect(result.steps).toEqual([
      {
        name: 'refresh',
        ok: false,
        problems: [
          'expected status 200, got 401 (session.revoked)',
          'expected code to be "ok", got "session.revoked"',
          'expected sessionId to be present',
        ],
      },
    ])
    expect(formatResult(result)).not.toContain('secret-token-value')
    expect(formatResult(result)).toBe(
      [
        'FAILED test',
        '  FAIL refresh',
        '         expected status 200, got 401 (session.revoked)',
        '         expected code to be "ok", got "session.revoked"',
        '         expected sessionId to be present',
      ].join('\n')
    )
  })

  test('a repeated step sends the request each time and names the one that failed', async () => {
    const { target, requests } = fakeTarget((_seen, index) => ({ status: index < 2 ? 401 : 429 }))
    const result = await runScenario(
      scenario([{ name: 'guess', request: get('/guess'), expect: { status: 401 }, times: 5 }]),
      target
    )
    expect(requests).toHaveLength(3)
    expect(result.steps[0]?.problems).toEqual(['request 3: expected status 401, got 429'])
  })

  test('reads the emailed code, and derives one that is certainly wrong', async () => {
    const asked: string[] = []
    const { target, requests } = fakeTarget(() => ({ status: 200 }), {
      emailCode: async (to) => {
        asked.push(to)
        return '123459'
      },
    })
    await runScenario(
      scenario(
        [
          {
            name: 'read',
            emailCode: { to: '{{email}}', capture: 'code', captureWrong: 'wrong' },
          },
          {
            name: 'send',
            request: {
              method: 'POST',
              path: '/verify',
              body: { code: '{{code}}', bad: '{{wrong}}' },
            },
            expect: { status: 200 },
          },
          { name: 'read again', emailCode: { to: '{{email}}', capture: 'again' } },
        ],
        { variables: { email: 'maya@example.com' } }
      ),
      target
    )
    expect(asked).toEqual(['maya@example.com', 'maya@example.com'])
    expect(requests[0]?.body).toEqual({ code: '123459', bad: '123450' })
  })

  test('reads the emailed link and takes it apart: token and attempt from the fragment', async () => {
    const asked: string[] = []
    const link = 'https://app.example.com/auth/link#tula_link=l1nk-t0k3n_x&tula_attempt=attempt-9'
    const { target, requests } = fakeTarget(() => ({ status: 200 }), {
      emailLink: async (to) => {
        asked.push(to)
        return link
      },
    })
    const result = await runScenario(
      scenario(
        [
          {
            name: 'read',
            emailLink: {
              to: '{{email}}',
              captureToken: 'token',
              captureAttempt: 'attempt',
              url: '{{redirect}}',
            },
          },
          {
            name: 'open',
            request: {
              method: 'POST',
              path: '/v1/client/sign-ins/link',
              body: { token: '{{token}}', attemptId: '{{attempt}}' },
            },
            expect: { status: 200 },
          },
          { name: 'token only', emailLink: { to: '{{email}}', captureToken: 'again' } },
        ],
        {
          variables: {
            email: 'maya@example.com',
            redirect: 'https://app.example.com/auth/link',
          },
        }
      ),
      target
    )
    expect(result.status).toBe('passed')
    expect(asked).toEqual(['maya@example.com', 'maya@example.com'])
    expect(requests[0]?.body).toEqual({ token: 'l1nk-t0k3n_x', attemptId: 'attempt-9' })
  })

  test.each<[string, string, object, string]>([
    [
      'a link that leads somewhere else',
      'https://evil.example/auth/link#tula_link=t0k3n-value&tula_attempt=a1',
      { url: 'https://app.example.com/auth/link' },
      'the link, without its fragment, is not the expected URL',
    ],
    [
      'a link with something in its query',
      'https://app.example.com/auth/link?tula_link=t0k3n-value#tula_link=t0k3n-value&tula_attempt=a1',
      { url: 'https://app.example.com/auth/link' },
      'the link, without its fragment, is not the expected URL',
    ],
    [
      'a link with the token in the query instead of the fragment',
      'https://app.example.com/auth/link?tula_link=t0k3n-value&tula_attempt=a1',
      {},
      'the link carries no token and attempt id in its fragment',
    ],
    [
      'a link with no attempt id',
      'https://app.example.com/auth/link#tula_link=t0k3n-value',
      {},
      'the link carries no token and attempt id in its fragment',
    ],
  ])('%s fails the step without printing the link', async (_, link, extra, problem) => {
    const { target } = fakeTarget(() => ({ status: 200 }), { emailLink: async () => link })
    const result = await runScenario(
      scenario([
        { name: 'read', emailLink: { to: 'maya@example.com', captureToken: 'token', ...extra } },
      ]),
      target
    )
    expect(result.status).toBe('failed')
    expect(result.steps[0]?.problems).toEqual([problem])
    expect(formatResult(result)).not.toContain('t0k3n-value')
  })

  test('a target that cannot read links fails the link step and says why', async () => {
    const { target } = fakeTarget(() => ({ status: 200 }))
    const result = await runScenario(
      scenario([{ name: 'read', emailLink: { to: 'maya@example.com', captureToken: 'token' } }]),
      target
    )
    expect(result.steps).toEqual([
      { name: 'read', ok: false, problems: ['this target cannot read links from emails'] },
    ])
  })

  test('cleanup steps run after the steps, when they all pass', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 200 }))
    const result = await runScenario(
      scenario([{ name: 'change', request: get('/change'), expect: { status: 200 } }], {
        cleanup: [{ name: 'restore', request: get('/restore'), expect: { status: 200 } }],
      }),
      target
    )
    expect(result.status).toBe('passed')
    expect(requests.map((seen) => seen.path)).toEqual(['/change', '/restore'])
    expect(result.steps.map((step) => step.name)).toEqual(['change', 'restore'])
  })

  test('cleanup steps run even when a step failed, with what was captured before it', async () => {
    const { target, requests } = fakeTarget((seen) =>
      seen.path === '/read'
        ? { status: 200, body: { id: 'original-1' } }
        : { status: seen.path === '/break' ? 500 : 200 }
    )
    const result = await runScenario(
      scenario(
        [
          {
            name: 'read',
            request: get('/read'),
            expect: { status: 200 },
            capture: { original: 'id' },
          },
          { name: 'break', request: get('/break'), expect: { status: 200 } },
          { name: 'never runs', request: get('/next'), expect: { status: 200 } },
        ],
        {
          cleanup: [
            { name: 'restore', request: get('/restore/{{original}}'), expect: { status: 200 } },
          ],
        }
      ),
      target
    )
    expect(requests.map((seen) => seen.path)).toEqual(['/read', '/break', '/restore/original-1'])
    expect(result.status).toBe('failed')
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ['read', true],
      ['break', false],
      ['restore', true],
    ])
    expect(formatResult(result)).toBe(
      [
        'FAILED test',
        '  ok   read',
        '  FAIL break',
        '         expected status 200, got 500',
        '  ok   restore',
      ].join('\n')
    )
  })

  test('a cleanup that fails fails a scenario whose steps passed, and stops the cleanup', async () => {
    const { target, requests } = fakeTarget((seen) => ({
      status: seen.path === '/restore' ? 412 : 200,
    }))
    const result = await runScenario(
      scenario([{ name: 'change', request: get('/change'), expect: { status: 200 } }], {
        cleanup: [
          { name: 'restore', request: get('/restore'), expect: { status: 200 } },
          { name: 'check', request: get('/check'), expect: { status: 200 } },
        ],
      }),
      target
    )
    expect(result.status).toBe('failed')
    expect(requests.map((seen) => seen.path)).toEqual(['/change', '/restore'])
    expect(result.steps.at(-1)).toEqual({
      name: 'restore',
      ok: false,
      problems: ['expected status 200, got 412'],
    })
  })

  test('a cleanup step that needs a value no step captured fails without sending anything', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 500 }))
    const result = await runScenario(
      scenario([{ name: 'read', request: get('/read'), expect: { status: 200 } }], {
        cleanup: [
          { name: 'restore', request: get('/restore/{{original}}'), expect: { status: 200 } },
        ],
      }),
      target
    )
    expect(requests.map((seen) => seen.path)).toEqual(['/read'])
    expect(result.steps.at(-1)?.problems).toEqual(['no value for {{original}}'])
  })

  test('a skipped scenario runs no cleanup', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 200 }), { secretKey: undefined })
    const result = await runScenario(
      scenario([{ name: 'read', request: get('/read'), expect: { status: 200 } }], {
        needsSecretKey: true,
        cleanup: [
          {
            name: 'restore',
            request: get('/restore', { auth: 'secret' }),
            expect: { status: 200 },
          },
        ],
      }),
      target
    )
    expect(result.status).toBe('skipped')
    expect(requests).toEqual([])
  })

  test('a wait step passes the duration to the target', async () => {
    const { target, waits } = fakeTarget(() => ({ status: 200 }))
    await runScenario(scenario([{ name: 'pause', wait: '11s' }]), target)
    expect(waits).toEqual([11_000])
  })

  test.each([
    [
      'a missing email',
      [{ name: 'read', emailCode: { to: 'x@example.com', capture: 'code' } }],
      'no mail',
    ],
    [
      'an unknown placeholder',
      [{ name: 'read', request: get('/{{nope}}'), expect: { status: 200 } }],
      'no value for {{nope}}',
    ],
    [
      'a capture that finds nothing',
      [{ name: 'read', request: get('/a'), expect: { status: 200 }, capture: { id: 'id' } }],
      'cannot capture id: no string at id',
    ],
  ])('%s fails the step instead of throwing', async (_name, steps, problem) => {
    const { target } = fakeTarget(() => ({ status: 200, body: {} }), {
      emailCode: async () => {
        throw new Error('no mail')
      },
    })
    const result = await runScenario(scenario(steps), target)
    expect(result).toMatchObject({ status: 'failed', steps: [{ ok: false, problems: [problem] }] })
  })

  test('a non-JSON response is compared as text, and a thrown non-Error is reported', async () => {
    const { target } = fakeTarget(() => ({ status: 502, text: '<html>Bad Gateway</html>' }))
    const result = await runScenario(
      scenario([{ name: 'call', request: get('/a'), expect: { status: 200, body: { id: 1 } } }]),
      target
    )
    expect(result.steps[0]?.problems).toEqual([
      'expected status 200, got 502',
      'expected body to be an object, got "<html>Bad Gateway</html>"',
    ])
    const broken = await runScenario(scenario([{ name: 'call', wait: '1s' }]), {
      ...target,
      wait: () => Promise.reject('offline'),
    })
    expect(broken.steps[0]?.problems).toEqual(['offline'])
  })

  test('a scenario that needs a secret key is skipped without one', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 200 }))
    const result = await runScenario(
      scenario(
        [{ name: 'admin', request: get('/a', { auth: 'secret' }), expect: { status: 200 } }],
        {
          needsSecretKey: true,
        }
      ),
      { ...target, secretKey: undefined }
    )
    expect(result).toEqual({
      name: 'test',
      status: 'skipped',
      steps: [],
      reason: 'needs a secret key',
    })
    expect(formatResult(result)).toBe('SKIPPED test\n  (needs a secret key)')
    expect(requests).toEqual([])
  })
})

describe('what a failure may print', () => {
  const REFRESH = 'tula_rt_Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6'
  const NEXT = 'tula_rt_YmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9v'
  const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl'

  test('a server that returns tokens where none are expected does not get them printed', async () => {
    const { target } = fakeTarget((_seen, index) => ({
      status: 200,
      body:
        index === 0
          ? { refreshToken: REFRESH }
          : { session: { refreshToken: NEXT, accessToken: JWT }, refreshToken: NEXT },
    }))
    const result = await runScenario(
      scenario(
        [
          {
            name: 'sign in',
            request: get('/a'),
            expect: { status: 200 },
            capture: { token: 'refreshToken' },
          },
          {
            name: 'retry',
            request: { method: 'POST', path: '/b', body: { password: '{{password}}' } },
            expect: {
              status: 200,
              body: { session: '$absent', refreshToken: '{{token}}' },
            },
          },
        ],
        { variables: { password: { generate: 'password' } } }
      ),
      target
    )
    expect(result.status).toBe('failed')
    const printed = formatResult(result)
    for (const secret of [REFRESH, NEXT, JWT, 'Zm9v', 'YmF6', 'eyJ', 'Tu-']) {
      expect(printed).not.toContain(secret)
    }
    expect(result.steps.at(-1)?.problems).toEqual([
      'expected session to be absent, got an object',
      'expected refreshToken to be a string of 52 characters, got a different string of 52 characters',
    ])
  })

  test('bodyExcludes fails a response that contains a value, without printing the value', async () => {
    const { target } = fakeTarget(() => ({
      status: 200,
      body: { data: [{ metadata: { note: 'for maya@example.com' } }] },
    }))
    const steps = (excludes: string[]) => [
      {
        name: 'audit',
        request: get('/audit'),
        expect: { status: 200, bodyExcludes: excludes },
      },
    ]
    const variables = { email: 'maya@example.com' }
    const leaked = await runScenario(
      scenario(steps(['absent', '{{email}}']), { variables }),
      target
    )
    expect(leaked.steps[0]?.problems).toEqual([
      'the response contains a value it must not (bodyExcludes[1])',
    ])
    expect(formatResult(leaked)).not.toContain('maya@')
    const clean = await runScenario(scenario(steps(['someone-else@example.com'])), target)
    expect(clean.status).toBe('passed')
  })
})

describe('values the runner knows are never printed', () => {
  test('an echoed password or emailed code is named by its variable, not quoted', async () => {
    let password = ''
    const { target } = fakeTarget((seen, index) => {
      if (index === 0) {
        password = (seen.body as { password: string }).password
        return { status: 200, body: { id: 'attempt-1234' } }
      }
      // A broken server that echoes what it was sent.
      return { status: 200, body: { echoed: password, code: '482913', attempt: 'attempt-1234' } }
    })
    const result = await runScenario(
      scenario(
        [
          {
            name: 'start',
            request: { method: 'POST', path: '/a', body: { password: '{{password}}' } },
            expect: { status: 200 },
            capture: { attemptId: 'id' },
          },
          { name: 'read', emailCode: { to: 'maya@example.com', capture: 'code' } },
          {
            name: 'verify',
            request: { method: 'POST', path: '/b', body: { code: '{{code}}' } },
            expect: { status: 200, body: { echoed: '$absent', code: 'ok', attempt: 'other' } },
          },
        ],
        { variables: { password: { generate: 'password' } } }
      ),
      { ...target, emailCode: async () => '482913' }
    )
    const printed = formatResult(result)
    expect(password).toHaveLength(32)
    expect(printed).not.toContain(password)
    expect(printed).not.toContain('482913')
    expect(result.steps.at(-1)?.problems).toEqual([
      'expected echoed to be absent, got "{{password}}"',
      'expected code to be "ok", got "{{code}}"',
      'expected attempt to be "other", got "{{attemptId}}"',
    ])
  })

  test('the status line only shows a code that looks like an error code', async () => {
    const { target } = fakeTarget((_seen, index) => ({
      status: 500,
      body: { code: index === 0 ? 'Tu-0123456789abcdef-Zq7!' : 'session.revoked' },
    }))
    const call = { name: 'call', request: get('/a'), expect: { status: 200 } }
    const leaky = await runScenario(scenario([call]), target)
    expect(leaky.steps[0]?.problems).toEqual(['expected status 200, got 500'])
    const plain = await runScenario(scenario([call]), target)
    expect(plain.steps[0]?.problems).toEqual(['expected status 200, got 500 (session.revoked)'])
  })
})

describe('nextOrigin', () => {
  test('every address is a valid IPv4 in the benchmarking range, with no repeats in a long run', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 62_500; index++) {
      const origin = nextOrigin()
      const octets = origin.split('.').map(Number)
      expect(octets).toHaveLength(4)
      expect(octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)).toBe(
        true
      )
      expect(origin.startsWith('198.18.')).toBe(true)
      seen.add(origin)
    }
    expect(seen.size).toBe(62_500)
  })
})

describe('exitCode', () => {
  test.each([
    [{ passed: 7, failed: 0, skipped: 0 }, 0],
    [{ passed: 6, failed: 0, skipped: 1 }, 0],
    [{ passed: 6, failed: 1, skipped: 0 }, 1],
    // Nothing ran: a run that checked nothing must not look green.
    [{ passed: 0, failed: 0, skipped: 7 }, 1],
    [{ passed: 0, failed: 0, skipped: 0 }, 1],
  ] as [Parameters<typeof exitCode>[0], 0 | 1][])('%j exits %i', (counts, expected) => {
    expect(exitCode(counts)).toBe(expected)
  })
})

describe('headers and whole values', () => {
  const read = {
    name: 'read',
    request: get('/v1/admin/settings', { auth: 'secret' }),
    expect: { status: 200 },
    captureHeaders: { etag: 'ETag' },
    captureJson: { original: 'settings', revision: 'revision' },
  }

  test('a response header and a whole JSON value can be captured and sent back', async () => {
    const settings = { app: { name: 'Acme "Inc"' }, urls: { allowedOrigins: ['https://a.test'] } }
    const { target, requests } = fakeTarget((_seen, index) =>
      index === 0
        ? { status: 200, body: { revision: 3, settings }, headers: { etag: '"3"' } }
        : { status: 200 }
    )
    const result = await runScenario(
      scenario(
        [
          read,
          {
            name: 'write it back',
            request: {
              method: 'PUT',
              path: '/v1/admin/settings?was={{revision}}',
              auth: 'secret',
              headers: { 'If-Match': '{{etag}}', Origin: 'https://app.test' },
              body: { $json: '{{original}}' },
            },
            expect: { status: 200 },
          },
          {
            name: 'nested',
            request: {
              method: 'POST',
              path: '/x',
              body: { wrapped: [{ $json: '{{original}}' }], plain: { $json: 'x', other: 1 } },
            },
            expect: { status: 200 },
          },
        ],
        { needsSecretKey: true }
      ),
      target
    )
    expect(result.status).toBe('passed')
    expect(requests[1]).toMatchObject({
      path: '/v1/admin/settings?was=3',
      headers: {
        'if-match': '"3"',
        origin: 'https://app.test',
        authorization: 'Bearer tula_sk_test',
        'content-type': 'application/json',
      },
    })
    expect(requests[1]?.body).toEqual(settings)
    // Only an object that is exactly `{ $json }` is replaced.
    expect(requests[2]?.body).toEqual({ wrapped: [settings], plain: { $json: 'x', other: 1 } })
  })

  test('a missing header or value fails the step, naming what was missing', async () => {
    const { target } = fakeTarget(() => ({ status: 200, body: { revision: 1 } }))
    const noHeader = await runScenario(
      scenario([{ ...read, captureJson: undefined }], { needsSecretKey: true }),
      target
    )
    expect(noHeader.steps.at(-1)?.problems).toEqual(['cannot capture etag: no ETag header'])
    const noValue = await runScenario(
      scenario([{ ...read, captureHeaders: undefined }], { needsSecretKey: true }),
      target
    )
    expect(noValue.steps.at(-1)?.problems).toEqual(['cannot capture original: nothing at settings'])
  })

  test('a captured value is never printed in a failure', async () => {
    const { target } = fakeTarget((_seen, index) =>
      index === 0
        ? {
            status: 200,
            body: { settings: { secretish: 'value-one-two' } },
            headers: { etag: '"1"' },
          }
        : { status: 409, body: { echoed: '{"secretish":"value-one-two"}' } }
    )
    const result = await runScenario(
      scenario(
        [
          { ...read, captureJson: { original: 'settings' } },
          {
            name: 'echo',
            request: get('/x'),
            expect: { status: 200, body: { echoed: 'something else' } },
          },
        ],
        { needsSecretKey: true }
      ),
      target
    )
    expect(formatResult(result)).not.toContain('value-one-two')
  })

  test('text that is not JSON cannot be sent as $json', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 200 }))
    const result = await runScenario(
      scenario(
        [
          {
            name: 'bad',
            request: { method: 'POST', path: '/x', body: { $json: '{{broken}}' } },
            expect: { status: 200 },
          },
        ],
        { variables: { broken: '{not json' } }
      ),
      target
    )
    expect(result.steps.at(-1)?.problems).toEqual(['$json does not hold valid JSON'])
    expect(requests).toEqual([])
  })

  test('a totp step computes the code for the target clock, and one that is wrong', async () => {
    // The RFC 6238 test secret ("12345678901234567890") and its SHA-1 vector at T=59.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    let now = 59_000
    const { target, requests } = fakeTarget(() => ({ status: 200 }), {
      now: () => now,
      wait: async (ms) => {
        now += ms
      },
    })
    const submit = (name: string) => ({
      name,
      request: {
        method: 'POST',
        path: '/v1/client/sign-ins/a1/second-factor',
        body: { code: '{{code}}', bad: '{{wrongCode}}' },
      },
      expect: { status: 200 },
    })
    const compute = (name: string) => ({
      name,
      totp: { secret: '{{secret}}', capture: 'code', captureWrong: 'wrongCode' },
    })
    const result = await runScenario(
      scenario(
        [
          compute('now'),
          submit('first'),
          { name: 'next step', wait: '30s' },
          { name: 'code only', totp: { secret: '{{secret}}', capture: 'code' } },
          submit('second'),
        ],
        { variables: { secret } }
      ),
      target
    )
    expect(result.status).toBe('passed')
    const sent = requests.map((seen) => seen.body as { code: string; bad: string })
    expect(sent.map((body) => body.code)).toEqual(['287082', '359152'])
    const wrong = sent[0]?.bad
    expect(wrong).toMatch(/^\d{6}$/)
    expect(['755224', '287082', '359152', '969429']).not.toContain(wrong)
    // Without `captureWrong` the earlier wrong code is left as it was.
    expect(sent[1]?.bad).toBe(wrong)
  })

  test('a totp step uses the wall clock when the target has no clock of its own', async () => {
    const { target, requests } = fakeTarget(() => ({ status: 200 }))
    const before = Date.now()
    const result = await runScenario(
      scenario(
        [
          { name: 'compute', totp: { secret: '{{secret}}', capture: 'code' } },
          {
            name: 'submit',
            request: { method: 'POST', path: '/x', body: { code: '{{code}}' } },
            expect: { status: 200 },
          },
        ],
        { variables: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } }
      ),
      target
    )
    expect(result.status).toBe('passed')
    const bytes = new TextEncoder().encode('12345678901234567890')
    // The step can roll over while the test runs.
    expect([
      { code: await totp(bytes, before) },
      { code: await totp(bytes, Date.now()) },
    ]).toContainEqual(requests[0]?.body as { code: string })
  })

  test('a totp secret that is not Base32 fails the step without being printed', async () => {
    const { target } = fakeTarget(() => ({ status: 200 }))
    const result = await runScenario(
      scenario([{ name: 'compute', totp: { secret: '{{secret}}', capture: 'code' } }], {
        variables: { secret: 'not-base32-0189!' },
      }),
      target
    )
    expect(result.status).toBe('failed')
    expect(result.steps.at(-1)?.problems).toEqual(['not a Base32 secret'])
  })

  test('claims of a JWT in the body are matched as a subset of its payload', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const accessToken = [
      encode({ alg: 'EdDSA' }),
      encode({ sub: 'u1', amr: ['pwd', 'otp', 'mfa'], auth_time: 1_700_000_000 }),
      'c2ln',
    ].join('.')
    const { target } = fakeTarget(() => ({
      status: 200,
      body: { session: { accessToken, refreshToken: 'tula_rt_opaque' } },
    }))
    const step = (claims: unknown) => ({
      name: 'sign in',
      request: { method: 'POST', path: '/x' },
      expect: { status: 200, claims },
    })
    const passed = await runScenario(
      scenario(
        [
          step({
            'session.accessToken': {
              sub: '{{user}}',
              amr: ['pwd', 'otp', 'mfa'],
              auth_time: '$any',
            },
          }),
        ],
        { variables: { user: 'u1' } }
      ),
      target
    )
    expect(passed.status).toBe('passed')

    const failed = await runScenario(
      scenario([step({ 'session.accessToken': { amr: ['pwd'], azp: '$any' } })]),
      target
    )
    expect(failed.steps.at(-1)?.problems).toEqual([
      'expected claims(session.accessToken).amr to be an array of 1, got an array of 3',
      'expected claims(session.accessToken).azp to be present',
    ])

    const notAJwt = await runScenario(
      scenario([step({ 'session.refreshToken': { sub: '$any' }, 'session.none': {} })]),
      target
    )
    const problems = notAJwt.steps.at(-1)?.problems ?? []
    expect(problems).toEqual([
      'expected a JWT at session.refreshToken',
      'expected a JWT at session.none',
    ])
    expect(problems.join(' ')).not.toContain('tula_rt_opaque')
  })
})
