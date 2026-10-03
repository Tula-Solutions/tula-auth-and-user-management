import { describe, expect, test } from 'bun:test'
import { match, pick } from './match'

const body = {
  id: 'a1',
  kind: 'sign_up',
  step: { status: 'complete', userId: 'u1' },
  session: { refreshToken: 'tula_rt_abc', expiresIn: 60 },
  data: [{ id: 'x' }, { id: 'y' }],
  bannedAt: null,
}

describe('match', () => {
  test.each([
    ['a subset of keys', { kind: 'sign_up' }],
    ['nested subsets', { step: { status: 'complete' } }],
    ['literals of every type', { session: { expiresIn: 60 }, bannedAt: null }],
    ['$any for a present value', { id: '$any', session: '$any' }],
    ['$absent for a missing or null value', { missing: '$absent', bannedAt: '$absent' }],
    ['$not', { id: { $not: 'a2' } }],
    ['$matches', { session: { refreshToken: { $matches: '^tula_rt_' } } }],
    ['arrays item by item, each as a subset', { data: [{ id: 'x' }, {}] }],
    ['no expectation at all', undefined],
  ])('accepts %s', (_name, expected) => {
    expect(match(expected, expected === undefined ? undefined : body)).toEqual([])
  })

  test.each([
    ['a different literal', { kind: 'sign_in' }, 'expected kind to be "sign_in", got "sign_up"'],
    ['a missing key', { nope: 1 }, 'expected nope to be 1, got nothing'],
    [
      'a nested difference, with its path',
      { step: { status: 'needs_password' } },
      'expected step.status to be "needs_password", got "complete"',
    ],
    ['$any on a null', { bannedAt: '$any' }, 'expected bannedAt to be present'],
    ['$any on a missing key', { missing: '$any' }, 'expected missing to be present'],
    ['$absent on a present value', { id: '$absent' }, 'expected id to be absent, got "a1"'],
    ['$not on an equal value', { id: { $not: 'a1' } }, 'expected id not to be "a1"'],
    [
      '$matches on a non-matching string',
      { id: { $matches: '^b' } },
      'expected id to match /^b/, got "a1"',
    ],
    [
      '$matches on a non-string',
      { session: { expiresIn: { $matches: '6' } } },
      'expected session.expiresIn to match /6/, got 60',
    ],
    [
      'an array of another length',
      { data: [{ id: 'x' }] },
      'expected data to be an array of 1, got an array of 2',
    ],
    [
      'an array item',
      { data: [{ id: 'x' }, { id: 'z' }] },
      'expected data[1].id to be "z", got "y"',
    ],
    ['an object where a string is', { id: { a: 1 } }, 'expected id to be an object, got "a1"'],
    [
      'an array where an object is',
      { step: [1] },
      'expected step to be an array of 1, got an object',
    ],
  ])('reports %s', (_name, expected, message) => {
    expect(match(expected, body).map((mismatch) => mismatch.message)).toEqual([message])
  })

  test('reports every difference, not just the first', () => {
    expect(match({ kind: 'x', step: { status: 'y' } }, body)).toHaveLength(2)
  })

  test('a whole body that is not what was expected names the body', () => {
    expect(match({ code: 'x' }, 'Internal Server Error')[0]?.message).toBe(
      'expected body to be an object, got "Internal Server Error"'
    )
  })
})

describe('pick', () => {
  test.each([
    ['id', 'a1'],
    ['step.userId', 'u1'],
    ['data[1].id', 'y'],
    ['data.0.id', 'x'],
    ['step.missing', undefined],
    ['id.deeper', undefined],
    ['data[5].id', undefined],
  ])('%s', (path, expected) => {
    expect(pick(body, path)).toBe(expected as never)
  })
})

describe('secrets never reach a message', () => {
  const REFRESH = 'tula_rt_Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6'
  const OTHER = 'tula_rt_YmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9v'
  const JWT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl'
  const SECRET_KEY = 'tula_sk_dev_short'
  const leaky = {
    session: { refreshToken: REFRESH, accessToken: JWT },
    refreshToken: REFRESH,
    key: SECRET_KEY,
    list: [REFRESH, JWT],
  }

  test.each([
    ['$absent on a session', { session: '$absent' }],
    ['$absent on a token', { refreshToken: '$absent' }],
    ['a literal captured token that differs', { refreshToken: OTHER }],
    ['$not on the same token', { refreshToken: { $not: REFRESH } }],
    ['$matches that fails', { refreshToken: { $matches: '^nope' } }],
    ['an object expected where a token is', { refreshToken: { a: 1 } }],
    ['an array of another length', { list: [REFRESH] }],
    ['an array expected where an object is', { session: [1] }],
    ['a short key with a secret prefix', { key: 'something else' }],
    ['a number expected where a token is', { refreshToken: 5 }],
  ])('%s', (_name, expected) => {
    const messages = match(expected, leaky).map((mismatch) => mismatch.message)
    expect(messages.length).toBeGreaterThan(0)
    const text = messages.join('\n')
    for (const secret of [REFRESH, OTHER, JWT, SECRET_KEY, 'Zm9v', 'eyJ']) {
      expect(text).not.toContain(secret)
    }
  })

  test('short, plain values are still shown, because they are what explains a failure', () => {
    expect(match({ code: 'ok', count: 2 }, { code: 'session.revoked', count: 3 })).toEqual([
      { path: 'code', message: 'expected code to be "ok", got "session.revoked"' },
      { path: 'count', message: 'expected count to be 2, got 3' },
    ])
  })

  test('two long values that differ are said to differ, without either', () => {
    expect(match({ refreshToken: OTHER }, leaky)[0]?.message).toBe(
      'expected refreshToken to be a string of 52 characters, got a different string of 52 characters'
    )
  })
})

describe('$not and matcher objects', () => {
  test('$not needs a value to compare: a missing field does not pass', () => {
    expect(match({ refreshToken: { $not: 'old' } }, {}).map((m) => m.message)).toEqual([
      'expected refreshToken to be present',
    ])
    expect(match({ refreshToken: { $not: 'old' } }, { refreshToken: null })).toHaveLength(1)
  })

  test.each([[{ id: { $not: 'a2', extra: 1 } }], [{ id: { $matches: '^a', $not: 'b' } }]])(
    'a matcher object with other keys is an authoring error: %j',
    (expected) => {
      expect(match(expected, body).map((m) => m.message)).toEqual([
        'id: a matcher object takes exactly one key',
      ])
    }
  )
})
