import { describe, expect, test } from 'bun:test'
import {
  bound,
  cleanText,
  MAX_OUTPUT_CHARS,
  MAX_STRING_CHARS,
  project,
  REDACTED,
  redactor,
  S,
} from './sanitize'

describe('cleanText', () => {
  test.each([
    ['control characters become spaces', 'a\u0000b\u001b[2Jc\nd\u0085e', 'a b [2Jc d e'],
    ['bidirectional overrides and zero-width characters are removed', 'a‮b​c⁦d﻿', 'abcd'],
    ['ordinary text is kept', 'Maya Lin — ünïcode', 'Maya Lin — ünïcode'],
  ])('%s', (_name, input, expected) => {
    expect(cleanText(input, 100)).toBe(expected)
  })

  test('a long string is cut at the cap and says so', () => {
    const text = cleanText('x'.repeat(MAX_STRING_CHARS + 50))
    expect(text.length).toBeLessThanOrEqual(MAX_STRING_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
  })

  test.each([
    ['a secret key', `tula_sk_live_${'a'.repeat(32)}`],
    ['a secret key inside text', `key is tula_sk_dev_${'b'.repeat(20)} ok`],
    ['a JWT', 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ'],
    ['an argon2 hash', '$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA'],
    ['an otpauth URI', 'otpauth://totp/App:maya?secret=JBSWY3DPEHPK3PXP'],
    ['a PEM block', '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'],
  ])('%s is replaced, whatever field it arrived in', (_name, input) => {
    const text = cleanText(input, 500)
    expect(text).toContain(REDACTED)
    expect(text).not.toContain('aaaaaaaa')
    expect(text).not.toContain('bbbbbbbb')
    expect(text).not.toContain('JBSWY3DPEHPK3PXP')
    expect(text).not.toContain('MIIB')
    expect(text).not.toContain('c2lnbmF0dXJl')
    expect(text).not.toContain('aGFzaA')
  })
})

describe('project', () => {
  const shape = S.object({
    id: S.string(),
    count: S.number,
    on: S.boolean,
    tags: S.array(S.string(10), 2),
    inner: S.object({ name: S.string() }),
    byName: S.record(S.object({ ttl: S.string() }), 2),
  })

  test('named fields are kept, everything else is dropped', () => {
    expect(
      project(
        {
          id: 'a',
          count: 2,
          on: true,
          tags: ['x', 'y', 'z'],
          inner: { name: 'n', secret: 's' },
          byName: { web: { ttl: '60s', extra: 1 }, mobile: { ttl: '5m' }, third: { ttl: '1h' } },
          passwordHash: 'h',
        },
        shape
      )
    ).toEqual({
      id: 'a',
      count: 2,
      on: true,
      tags: ['x', 'y'],
      inner: { name: 'n' },
      byName: { web: { ttl: '60s' }, mobile: { ttl: '5m' } },
    })
  })

  test('null is kept; a value of the wrong type is dropped, never passed through', () => {
    expect(
      project({ id: null, count: '7', on: 'yes', tags: 'x', inner: ['a'], byName: null }, shape)
    ).toEqual({ id: null, byName: null })
  })

  test('an array drops entries of the wrong type', () => {
    expect(project(['a', { b: 1 }, 3, 'c'], S.array(S.string()))).toEqual(['a', 'c'])
  })

  test('a number that is not finite is dropped', () => {
    expect(project({ count: Number.NaN }, S.object({ count: S.number }))).toEqual({})
  })

  test('a record key is cleaned like any other text and a prototype key is refused', () => {
    const value = JSON.parse('{"__proto__": {"ttl": "x"}, "we\\u0000b": {"ttl": "1"}}')
    const out = project(value, S.record(S.object({ ttl: S.string() }), 5)) as Record<
      string,
      unknown
    >
    expect(Object.keys(out)).toEqual(['we b'])
  })

  test('something that is not an object projects to nothing', () => {
    expect(project('text', shape)).toBeUndefined()
    expect(project(undefined, shape)).toBeUndefined()
  })
})

describe('bound', () => {
  test('a small output is returned as it is', () => {
    const output = { data: [{ id: '1' }] }
    expect(bound(output)).toEqual(output)
  })

  test('a list too large for the cap loses entries from the end and says so', () => {
    const data = Array.from({ length: 400 }, (_, index) => ({
      id: String(index),
      text: 'x'.repeat(400),
    }))
    const out = bound({ meta: { page: 1 }, data })
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS)
    expect(out.truncated).toBe(true)
    const kept = out.data as { id: string }[]
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(400)
    expect(kept[0]?.id).toBe('0')
  })

  test('an output with no list that is still too large is replaced by an error', () => {
    const out = bound({ big: 'x'.repeat(MAX_OUTPUT_CHARS + 10) })
    expect(out).toEqual({
      error: { code: 'output.too_large', message: expect.any(String) },
    })
  })
})

describe('redactor', () => {
  test('a key that holds a configured secret is redacted too', () => {
    const redact = redactor(['hunter2hunter2'])
    const out: Record<string, unknown> = redact({ 'profile-hunter2hunter2': { ttl: '60s' } })
    expect(out).toEqual({ [`profile-${REDACTED}`]: { ttl: '60s' } })
  })

  test('every configured secret is replaced wherever it appears, at any depth', () => {
    const redact = redactor(['hunter2hunter2', '', 'tok'])
    expect(
      redact({ a: 'x hunter2hunter2 y', b: [{ c: 'hunter2hunter2' }], d: 3, e: null, f: 'tok' })
    ).toEqual({ a: `x ${REDACTED} y`, b: [{ c: REDACTED }], d: 3, e: null, f: 'tok' })
  })
})
