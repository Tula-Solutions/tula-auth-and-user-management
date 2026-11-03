import { describe, expect, test } from 'bun:test'
import { parseCodeMeta, withoutTitle } from './code-meta'

describe('parseCodeMeta', () => {
  test('nothing after the language is no title and no lines', () => {
    expect(parseCodeMeta(undefined)).toEqual({ highlight: [] })
    expect(parseCodeMeta('')).toEqual({ highlight: [] })
    expect(parseCodeMeta(null)).toEqual({ highlight: [] })
  })

  test('a title in either kind of quote', () => {
    expect(parseCodeMeta('title="app/layout.tsx"').title).toBe('app/layout.tsx')
    expect(parseCodeMeta("title='a b.ts'").title).toBe('a b.ts')
  })

  test('line ranges are expanded, ordered and without repeats', () => {
    expect(parseCodeMeta('{5,1-3, 2}').highlight).toEqual([1, 2, 3, 5])
  })

  test('a title and lines together, in either order', () => {
    expect(parseCodeMeta('{2} title="x.ts"')).toEqual({ title: 'x.ts', highlight: [2] })
    expect(parseCodeMeta('title="x.ts" {2-3}')).toEqual({ title: 'x.ts', highlight: [2, 3] })
  })

  test.each([
    ['title=""', 'empty title'],
    ['{0}', 'is not N or N-M'],
    ['{3-1}', 'is not N or N-M'],
    ['{a}', 'is not N or N-M'],
    ['{1,}', 'is not N or N-M'],
    ['titel="x"', 'is not a title'],
    ['title="x" copy', '"copy" is not'],
  ])('%s is refused (%s)', (meta, reason) => {
    expect(() => parseCodeMeta(meta)).toThrow(reason)
  })
})

describe('withoutTitle', () => {
  test('keeps the rest of the info string', () => {
    expect(withoutTitle('title="a" {1}')).toBe('{1}')
    expect(withoutTitle('title="a"')).toBeNull()
    expect(withoutTitle(null)).toBeNull()
  })
})
