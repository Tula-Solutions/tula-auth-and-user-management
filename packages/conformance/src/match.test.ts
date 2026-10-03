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
      'expected data to be [{"id":"x"}], got [{"id":"x"},{"id":"y"}]',
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
      'expected step to be [1], got {"status":"complete","userId":"u1"}',
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
