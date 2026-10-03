import { describe, expect, test } from 'bun:test'
import { fill } from './template'

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
