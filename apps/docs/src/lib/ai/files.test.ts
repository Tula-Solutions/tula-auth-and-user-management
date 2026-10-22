import { describe, expect, test } from 'bun:test'
import type { ErrorCodeEntry } from '../error-codes'
import type { LinkEnvironment } from '../links'
import type { NavGroup } from '../nav'
import { buildRobots, buildSitemap } from './discovery'
import { buildAiFiles, withAlternate } from './index'
import { buildLlmsFull, buildLlmsTxt, firstSentence, inFullText } from './llms'
import { buildSkill } from './skill'
import type { Urls } from './urls'

const urls: Urls = { origin: 'https://docs.example', base: '/sub/' }
const environment: LinkEnvironment = {
  routes: new Map([
    ['docs/README.md', '/docs/'],
    ['docs/quickstart.md', '/quickstart/'],
    ['docs/reference/core.md', '/reference/core/'],
  ]),
  base: '/sub/',
  kind: () => 'file',
  anchorsOf: () => new Set(),
}
const nav: NavGroup[] = [
  { title: 'Start here', items: [{ label: 'Quickstart', route: '/quickstart/', children: [] }] },
  {
    title: 'SDK reference',
    items: [
      { label: 'core', route: '/reference/core/', children: [] },
      { label: 'Error codes', route: '/reference/error-codes/', children: [] },
    ],
  },
]
const sources: Record<string, string> = {
  'docs/README.md': '# Docs\n\nStart with the [quickstart](quickstart.md).\n',
  'docs/quickstart.md': '# Quickstart\n\nInstall it.\n',
  'docs/reference/core.md': '# Core\n\nGenerated.\n',
}
const entries: ErrorCodeEntry[] = [
  { code: 'password.too_short', status: 422, message: 'Too short.', area: 'password' },
]

function build(skillSource: string | null = null) {
  return buildAiFiles({
    urls,
    environment,
    summary: 'A summary.',
    nav,
    pages: [
      {
        route: '/docs/',
        title: 'Docs',
        description: 'The docs.',
        source: 'docs/README.md',
        ids: new Set(),
      },
      {
        route: '/quickstart/',
        title: 'Quickstart',
        description: 'Install it.',
        source: 'docs/quickstart.md',
        ids: new Set(),
      },
      {
        route: '/reference/core/',
        title: 'Core',
        description: 'Generated.',
        source: 'docs/reference/core.md',
        ids: new Set(),
      },
      {
        route: '/reference/error-codes/',
        title: 'Error codes',
        description: 'Every code.',
        source: null,
        ids: new Set(['password.too_short']),
      },
    ],
    landing: { route: '/', title: 'Tula Auth', description: 'Landing.' },
    read: (file) => sources[file] as string,
    errorCodes: { route: '/reference/error-codes/', entries },
    skillSource,
    updated: (file) => (file === 'docs/quickstart.md' ? '2026-10-20' : undefined),
    repositoryUrl: (file) => `https://github.example/${file}`,
    copied: [],
  })
}

describe('buildAiFiles', () => {
  test('writes a twin for every page, the landing page and the error codes included', () => {
    const files = build()
    expect([...files.keys()].filter((path) => path.endsWith('.md')).sort()).toEqual([
      'docs.md',
      'index.md',
      'quickstart.md',
      'reference/core.md',
      'reference/error-codes.md',
    ])
    expect(files.get('reference/error-codes.md')).toContain('### `password.too_short`')
    expect(files.get('docs.md')).toContain('[quickstart](https://docs.example/sub/quickstart.md)')
  })

  test('llms.txt is the convention: an H1, a blockquote, sections of absolute .md links with a description', () => {
    const text = build().get('llms.txt') as string
    expect(text.startsWith('# Tula Auth\n\n> A summary.\n')).toBe(true)
    expect(text).toContain(
      '## Start here\n- [Quickstart](https://docs.example/sub/quickstart.md): Install it.'
    )
    expect(text).toContain('## SDK reference')
    expect(text).toContain('- [Core](https://docs.example/sub/reference/core.md): Generated.')
    expect(text).toContain('- [Docs](https://docs.example/sub/docs.md): The docs.')
    expect(text).toContain('## Optional')
    expect(text).not.toContain('skill.md')
  })

  test('llms-full.txt holds the hand-written pages and leaves the generated reference out', () => {
    const files = build()
    const text = files.get('llms-full.txt') as string
    expect(text).toContain('title: "Quickstart"')
    expect(text).toContain('title: "Docs"')
    expect(text).not.toContain('title: "Core"')
    expect(text).not.toContain('password.too_short')
    expect(inFullText('/reference/core/')).toBe(false)
    expect(inFullText('/quickstart/')).toBe(true)
  })

  test('has a skill only when its source exists, and the skill is listed in llms.txt', () => {
    expect(build().has('skill.md')).toBe(false)
    const files = build(
      '---\nname: x\n---\nRead {{page:docs/quickstart.md}} and {{file:llms.txt}}.\n'
    )
    expect(files.get('skill.md')).toContain(
      'Read https://docs.example/sub/quickstart.md and https://docs.example/sub/llms.txt.'
    )
    expect(files.get('llms.txt')).toContain('(https://docs.example/sub/skill.md)')
  })

  test('the sitemap lists every page under the base, with a date only where it is known', () => {
    const sitemap = build().get('sitemap.xml') as string
    expect(sitemap).toContain('<loc>https://docs.example/sub/</loc>')
    expect(sitemap).toContain(
      '<loc>https://docs.example/sub/quickstart/</loc><lastmod>2026-10-20</lastmod>'
    )
    expect(sitemap).toContain('<loc>https://docs.example/sub/reference/error-codes/</loc></url>')
  })

  test('every address follows the base', () => {
    const rooted = buildAiFiles({
      ...baseInput(),
      urls: { origin: 'https://docs.example', base: '/' },
    })
    expect(rooted.get('llms.txt')).toContain('(https://docs.example/quickstart.md)')
    expect(rooted.get('robots.txt')).toContain('Sitemap: https://docs.example/sitemap.xml')
  })
})

function baseInput() {
  return {
    urls,
    environment: { ...environment, base: '/' },
    summary: 'A summary.',
    nav,
    pages: [
      {
        route: '/docs/',
        title: 'Docs',
        description: 'The docs.',
        source: 'docs/README.md',
        ids: new Set<string>(),
      },
      {
        route: '/quickstart/',
        title: 'Quickstart',
        description: 'Install it.',
        source: 'docs/quickstart.md',
        ids: new Set<string>(),
      },
      {
        route: '/reference/core/',
        title: 'Core',
        description: 'Generated.',
        source: 'docs/reference/core.md',
        ids: new Set<string>(),
      },
      {
        route: '/reference/error-codes/',
        title: 'Error codes',
        description: 'Every code.',
        source: null,
        ids: new Set(['password.too_short']),
      },
    ],
    landing: { route: '/', title: 'Tula Auth', description: 'Landing.' },
    read: (file: string) => sources[file] as string,
    errorCodes: { route: '/reference/error-codes/', entries },
    skillSource: null,
    repositoryUrl: (file: string) => `https://github.example/${file}`,
    copied: [],
  }
}

describe('generators', () => {
  test('firstSentence cuts at the first full stop that ends a sentence, and leaves a text without one', () => {
    expect(firstSentence('Use v1.2 now. Then more.')).toBe('Use v1.2 now.')
    expect(firstSentence('No stop here…')).toBe('No stop here…')
    expect(firstSentence('  one\n two.  ')).toBe('one two.')
  })

  test('llms.txt throws for a sidebar route with no page', () => {
    expect(() =>
      buildLlmsTxt({ urls, summary: 's', nav, pages: new Map(), hasSkill: false })
    ).toThrow('has no page')
  })

  test('llms-full.txt throws for a route with no twin', () => {
    expect(() => buildLlmsFull({ urls, summary: 's', routes: ['/x/'], twins: new Map() })).toThrow(
      'no Markdown twin'
    )
  })

  test('a link text with brackets is escaped so that it stays one link', () => {
    const text = buildLlmsTxt({
      urls,
      summary: 's',
      nav: [{ title: 'G', items: [{ label: 'x', route: '/a/', children: [] }] }],
      pages: new Map([
        ['/', { route: '/', title: 'Home', description: '' }],
        ['/docs/', { route: '/docs/', title: 'Docs', description: '' }],
        ['/a/', { route: '/a/', title: 'Use [x]', description: 'multi\nline' }],
      ]),
      hasSkill: false,
    })
    expect(text).toContain('- [Use \\[x\\]](https://docs.example/sub/a.md): multi line')
  })

  test('robots allows everything and names the sitemap; the sitemap escapes its text', () => {
    expect(buildRobots(urls)).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://docs.example/sub/sitemap.xml\n'
    )
    expect(buildSitemap(urls, ['/a&b/'])).toContain('<loc>https://docs.example/sub/a&amp;b/</loc>')
  })

  test('a skill placeholder that names no page or file stops the build', () => {
    const routes = new Map([['docs/quickstart.md', '/quickstart/']])
    expect(() => buildSkill('{{page:docs/none.md}}', routes, new Set(), urls)).toThrow(
      'docs/none.md'
    )
    expect(() => buildSkill('{{file:none.txt}}', routes, new Set(), urls)).toThrow('none.txt')
    expect(buildSkill('{{page:docs/quickstart.md#a}}', routes, new Set(), urls)).toBe(
      'https://docs.example/sub/quickstart.md#a'
    )
  })

  test('withAlternate puts the link at the end of the head, and needs a head', () => {
    expect(
      withAlternate('<html><head><title>x</title></head><body></body></html>', '/sub/a.md')
    ).toBe(
      '<html><head><title>x</title><link rel="alternate" type="text/markdown" href="/sub/a.md"/></head><body></body></html>'
    )
    expect(() => withAlternate('<p>no head</p>', '/a.md')).toThrow('no </head>')
  })
})
