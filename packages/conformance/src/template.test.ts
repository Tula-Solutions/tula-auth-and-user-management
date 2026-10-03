import { describe, expect, test } from 'bun:test'
import { expandJson, fill } from './template'

const variables = { attemptId: 'a1', email: 'maya@example.com' }

describe('fill', () => {
  test('replaces placeholders in strings, anywhere in a structure', () => {
    expect(
      fill(
        {
          path: '/sign-ups/{{attemptId}}/verify-email',
          body: { email: '{{ email }}', list: ['{{attemptId}}', 3, null, true] },
        },
        variables
      )
    ).toEqual({
      path: '/sign-ups/a1/verify-email',
      body: { email: 'maya@example.com', list: ['a1', 3, null, true] },
    })
  })

  test('leaves the input untouched', () => {
    const input = { path: '{{attemptId}}' }
    fill(input, variables)
    expect(input.path).toBe('{{attemptId}}')
  })

  test('a placeholder with no value fails, naming it', () => {
    expect(() => fill({ body: { code: '{{code}}' } }, variables)).toThrow('no value for {{code}}')
  })

  test('text that only looks like a placeholder is left alone', () => {
    expect(fill('{{ 1bad }} {single} {{}}', variables)).toBe('{{ 1bad }} {single} {{}}')
  })
})

describe('expandJson', () => {
  test('replaces a $json object by the value its text encodes, at any depth', () => {
    expect(
      expandJson({
        a: { $json: '{"x":[1,2],"y":null}' },
        b: [{ $json: '"text"' }, { $json: '7' }],
        c: 'plain',
        d: null,
        e: 3,
      })
    ).toEqual({ a: { x: [1, 2], y: null }, b: ['text', 7], c: 'plain', d: null, e: 3 })
    expect(expandJson({ $json: '{"whole":true}' })).toEqual({ whole: true })
  })

  test('leaves an object alone unless $json is its only key', () => {
    const value = { $json: '1', and: 'more' }
    expect(expandJson(value)).toEqual(value)
    expect(expandJson({})).toEqual({})
  })

  test('does not expand inside the value it produced', () => {
    expect(expandJson({ $json: '{"$json":"1"}' })).toEqual({ $json: '1' })
  })

  test('refuses a $json that is not a string of JSON, without quoting it', () => {
    expect(() => expandJson({ $json: 5 })).toThrow('$json takes a string holding JSON')
    expect(() => expandJson({ $json: 'tula_sk_dev_secret{' })).toThrow(
      /^\$json does not hold valid JSON$/
    )
  })
})
