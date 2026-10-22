import { describe, expect, test } from 'bun:test'
import { buildErrorCodesPage, errorCodeEntries } from './error-codes'
import { buildIndex, MAX_TEXT, score, search } from './search'

const errors = buildErrorCodesPage(errorCodeEntries())
const pages = [
  {
    title: 'Password',
    route: '/methods/password/',
    sections: [
      { id: null, title: 'Password', text: 'An email address and a password. Reset by email.' },
      { id: 'switch-it-on', title: 'Switch it on', text: 'The dashboard, or the config file.' },
      {
        id: 'troubleshooting',
        title: 'Troubleshooting',
        text: 'password.too_short means the policy.',
      },
    ],
  },
  { title: 'Error codes', route: '/reference/error-codes/', sections: errors.sections },
]
const index = buildIndex(pages, '/')

describe('buildIndex', () => {
  test('one entry per section, with the anchor in the address', () => {
    expect(index.find((entry) => entry.t === 'Switch it on')).toEqual({
      t: 'Switch it on',
      p: 'Password',
      u: '/methods/password/#switch-it-on',
      x: 'The dashboard, or the config file.',
    })
    expect(index.find((entry) => entry.u === '/methods/password/')?.t).toBe('Password')
  })

  test('the base path prefixes every address', () => {
    expect(buildIndex(pages, '/docs-site/')[0]?.u).toBe('/docs-site/methods/password/')
  })

  test('prose is capped', () => {
    const [entry] = buildIndex(
      [
        {
          title: 'T',
          route: '/t/',
          sections: [{ id: null, title: 'T', text: 'x'.repeat(MAX_TEXT * 2) }],
        },
      ],
      '/'
    )
    expect(entry?.x.length).toBe(MAX_TEXT)
  })
})

describe('search', () => {
  test('an error code typed in full finds its anchor first, before prose that mentions it', () => {
    const [first] = search(index, 'password.too_short')
    expect(first?.u).toBe('/reference/error-codes/#password.too_short')
  })

  test.each(['PASSWORD.TOO_SHORT', 'too_short', 'too short', 'password too_short'])(
    'a code is found as %s',
    (query) => {
      expect(search(index, query).map((entry) => entry.u)).toContain(
        '/reference/error-codes/#password.too_short'
      )
    }
  )

  test('every error code of the contract is found by its own name', () => {
    const full = buildIndex(
      [{ title: 'Error codes', route: '/reference/error-codes/', sections: errors.sections }],
      '/'
    )
    for (const { code } of errorCodeEntries()) {
      expect(search(full, code)[0]?.u).toBe(`/reference/error-codes/#${code}`)
    }
  })

  test('a title outranks a page title, which outranks prose', () => {
    const results = search(index, 'dashboard')
    expect(results[0]?.t).toBe('Switch it on')
    expect(search(index, 'switch')[0]?.t).toBe('Switch it on')
  })

  test('every word must match somewhere', () => {
    expect(search(index, 'password dashboard').map((entry) => entry.t)).toContain('Switch it on')
    expect(search(index, 'password zebra')).toEqual([])
  })

  test('nothing matches an empty query', () => {
    expect(search(index, '')).toEqual([])
    expect(search(index, '   ')).toEqual([])
    expect(score({ t: 'a', p: 'b', u: '/', x: '' }, '')).toBe(0)
  })

  test('the number of results is limited', () => {
    expect(search(index, 'a', 3).length).toBeLessThanOrEqual(3)
  })
})
