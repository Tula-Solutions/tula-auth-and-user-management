import { describe, expect, test } from 'bun:test'
import { addressOf, canonicalOf, resolveRelease, versionBases } from './release'

const BASE = '/tula-auth-and-user-management/'
const NEXT = `${BASE}next/`

describe('resolveRelease', () => {
  test('with no channel the site is not versioned', () => {
    expect(resolveRelease({}, '/')).toBeNull()
    expect(resolveRelease({ DOCS_CHANNEL: '' }, '/')).toBeNull()
  })

  test('a version or an origin without a channel is refused, not ignored', () => {
    expect(() => resolveRelease({ DOCS_VERSION: '0.1.2' }, '/')).toThrow('DOCS_CHANNEL')
    expect(() => resolveRelease({ DOCS_ORIGIN: 'https://a.example' }, '/')).toThrow('DOCS_CHANNEL')
  })

  test('the three channels', () => {
    expect(resolveRelease({ DOCS_CHANNEL: 'release', DOCS_VERSION: '0.1.2' }, BASE)).toEqual({
      channel: 'release',
      version: '0.1.2',
      origin: null,
    })
    expect(resolveRelease({ DOCS_CHANNEL: 'next' }, NEXT)).toEqual({
      channel: 'next',
      version: null,
      origin: null,
    })
    expect(resolveRelease({ DOCS_CHANNEL: 'next', DOCS_VERSION: '0.1.2' }, NEXT)?.version).toBe(
      '0.1.2'
    )
    expect(resolveRelease({ DOCS_CHANNEL: 'unreleased' }, BASE)?.channel).toBe('unreleased')
  })

  test.each([
    ['an unknown channel', { DOCS_CHANNEL: 'latest' }],
    ['the release channel with no version', { DOCS_CHANNEL: 'release' }],
    [
      'a version with a pre-release part',
      { DOCS_CHANNEL: 'release', DOCS_VERSION: '0.1.2-alpha.1' },
    ],
    ['a version with a leading v', { DOCS_CHANNEL: 'release', DOCS_VERSION: 'v0.1.2' }],
    ['a version that is markup', { DOCS_CHANNEL: 'release', DOCS_VERSION: '1.0.0"><b>' }],
    ['a version on the unreleased channel', { DOCS_CHANNEL: 'unreleased', DOCS_VERSION: '0.1.2' }],
    ['an origin with a path', { DOCS_CHANNEL: 'unreleased', DOCS_ORIGIN: 'https://a.example/x' }],
    ['an origin over http', { DOCS_CHANNEL: 'unreleased', DOCS_ORIGIN: 'http://a.example' }],
    [
      'an origin with credentials',
      { DOCS_CHANNEL: 'unreleased', DOCS_ORIGIN: 'https://u:p@a.example' },
    ],
    [
      'an origin that closes an attribute',
      { DOCS_CHANNEL: 'unreleased', DOCS_ORIGIN: 'https://a.example"' },
    ],
  ])('%s is refused', (_name, env) => {
    expect(() => resolveRelease(env, BASE)).toThrow(/DOCS_/)
  })

  test('the next channel is refused at a base that is not below next/', () => {
    expect(() => resolveRelease({ DOCS_CHANNEL: 'next' }, BASE)).toThrow('next/')
    expect(() => resolveRelease({ DOCS_CHANNEL: 'next' }, '/')).toThrow('next/')
  })

  test('an origin is accepted with a port', () => {
    expect(
      resolveRelease({ DOCS_CHANNEL: 'unreleased', DOCS_ORIGIN: 'https://a.example:8443' }, BASE)
        ?.origin
    ).toBe('https://a.example:8443')
  })
})

describe('versionBases', () => {
  test('the released docs and the development docs are each other’s sibling', () => {
    const released = { channel: 'release', version: '0.1.2', origin: null } as const
    expect(versionBases(released, BASE)).toEqual({
      releasedBase: BASE,
      nextBase: NEXT,
      siblingBase: NEXT,
    })
    expect(versionBases({ ...released, channel: 'next' }, NEXT)).toEqual({
      releasedBase: BASE,
      nextBase: NEXT,
      siblingBase: BASE,
    })
    expect(versionBases({ ...released, channel: 'next' }, '/next/').releasedBase).toBe('/')
  })

  test('next at a base that is not below next/ throws', () => {
    expect(() => versionBases({ channel: 'next', version: null, origin: null }, BASE)).toThrow(
      'next/'
    )
  })
})

describe('addressOf and canonicalOf', () => {
  test('an address is the base and the route', () => {
    expect(addressOf(BASE, '/')).toBe(BASE)
    expect(addressOf(BASE, '/quickstart/')).toBe(`${BASE}quickstart/`)
  })

  test('the released docs and the root before a release are their own canonical address', () => {
    const origin = 'https://h.example'
    expect(
      canonicalOf({ channel: 'release', version: '0.1.2', origin }, BASE, '/quickstart/')
    ).toBe(`${origin}${BASE}quickstart/`)
    expect(canonicalOf({ channel: 'unreleased', version: null, origin }, BASE, '/')).toBe(
      `${origin}${BASE}`
    )
  })

  test('the development docs, the 404 page, an unversioned site and a site with no origin have none', () => {
    const origin = 'https://h.example'
    expect(canonicalOf({ channel: 'next', version: null, origin }, NEXT, '/')).toBeNull()
    expect(canonicalOf({ channel: 'release', version: '0.1.2', origin }, BASE, '/404')).toBeNull()
    expect(canonicalOf(null, BASE, '/')).toBeNull()
    expect(
      canonicalOf({ channel: 'release', version: '0.1.2', origin: null }, BASE, '/')
    ).toBeNull()
  })
})
