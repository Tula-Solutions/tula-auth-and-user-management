import { describe, expect, test } from 'bun:test'
import { fingerprintOf, newProgress, readProgress, serializeProgress, targetOf } from './progress'

describe('the progress file', () => {
  test('a new one is read back as it was written', () => {
    const progress = newProgress('clerk', 'a'.repeat(64), 'b'.repeat(16))
    expect(readProgress(serializeProgress(progress))).toEqual(progress)
  })

  test('it holds no key of an address or a hash by design: every field is a count, a code or an id', () => {
    const progress = newProgress(
      'supabase',
      fingerprintOf([['export', 'maya@northline.app $2b$10$x']]),
      targetOf('https://auth.example.com', 'tula_sk_dev_secret')
    )
    const text = serializeProgress(progress)
    expect(text).not.toContain('maya')
    expect(text).not.toContain('$2b$')
    expect(text).not.toContain('tula_sk')
    expect(text).not.toContain('auth.example.com')
  })

  test('the fingerprint depends on every file and its place, and the target on the origin and the key', () => {
    const base = fingerprintOf([['export', 'abc']])
    expect(fingerprintOf([['export', 'abd']])).not.toBe(base)
    expect(
      fingerprintOf([
        ['export', 'abc'],
        ['accounts', 'x'],
      ])
    ).not.toBe(base)
    expect(fingerprintOf([['accounts', 'abc']])).not.toBe(base)
    expect(fingerprintOf([['export', 'abc']])).toBe(base)
    const target = targetOf('https://auth.example.com/', 'key-one')
    expect(targetOf('https://auth.example.com/v1', 'key-one')).toBe(target)
    expect(targetOf('https://auth.example.com', 'key-two')).not.toBe(target)
    expect(targetOf('https://other.example.com', 'key-one')).not.toBe(target)
    expect(target).toMatch(/^[0-9a-f]{16}$/)
  })

  const good = () =>
    JSON.parse(serializeProgress(newProgress('auth0', 'f', 't'))) as Record<string, unknown>

  test.each([
    ['not JSON', 'nope'],
    ['not an object', '3'],
    ['null', 'null'],
    ['a version that is not 1', JSON.stringify({ ...good(), version: 2 })],
    ['a provider that is not one', JSON.stringify({ ...good(), provider: 'okta' })],
    ['a fingerprint that is not text', JSON.stringify({ ...good(), fingerprint: 4 })],
    ['a negative offset', JSON.stringify({ ...good(), doneThrough: -1 })],
    ['a fractional count', JSON.stringify({ ...good(), batches: 1.5 })],
    ['counts missing', JSON.stringify({ ...good(), counts: undefined })],
    ['a refused item without a code', JSON.stringify({ ...good(), refused: [{ row: 1 }] })],
    [
      'a code that is far too long',
      JSON.stringify({ ...good(), refused: [{ row: 1, code: 'x'.repeat(200) }] }),
    ],
    ['ids that are not text', JSON.stringify({ ...good(), userIds: { a: 1 } })],
    ['organizations missing', JSON.stringify({ ...good(), organizations: undefined })],
    ['memberships that are not a record', JSON.stringify({ ...good(), memberships: 'x' })],
  ])('%s is refused', (_name, text) => {
    expect(() => readProgress(text)).toThrow('not one this version of `tula import` wrote')
  })
})
