import { beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LANDING_LINKS } from '../components/landing'
import { ERROR_CODES_ROUTE, errorCodeEntries } from './error-codes'
import { SECTION_ATTRIBUTE, SECTION_CAP } from './markdown'
import { navRoutes } from './nav'
import { collectPages } from './pages'
import { search } from './search'
import {
  buildSite,
  fileOfRoute,
  LANDING_ROUTE,
  pageStats,
  repositoryEnvironment,
  type Site,
  writeSite,
} from './site'
import { tokensCss } from './tokens'

// A few pages stand for the shape of the site (a guide, a method page, the index, one reference
// page and the error codes): rendering every page is `generate:check`'s job (`build --check`,
// part of `verify`), and the list of pages against the files of docs/ is `pages.test.ts`'s.
const SAMPLE = [
  LANDING_ROUTE,
  '/docs/',
  '/quickstart/',
  '/methods/password/',
  '/reference/expo-screens/',
  ERROR_CODES_ROUTE,
]

let site: Site
beforeAll(async () => {
  site = await buildSite({ css: ['/assets/main.css'], js: '/assets/main.js' }, '/', SAMPLE)
})

describe('the site built from docs/', () => {
  test('the sample is rendered, and nothing else', () => {
    expect([...site.documents.keys()].sort()).toEqual([...SAMPLE].sort())
    expect(site.pages.map((page) => page.route).sort()).toEqual(
      SAMPLE.filter((route) => route !== LANDING_ROUTE).sort()
    )
  })

  test('every page is a whole document with the site’s script and stylesheet', () => {
    for (const [route, html] of site.documents) {
      expect(html.startsWith('<!doctype html>'), route).toBe(true)
      expect(html, route).toContain('<link rel="stylesheet" href="/assets/main.css"/>')
      expect(html, route).toContain('src="/assets/main.js"')
      expect(html, route).toContain('<h1')
      expect(html, route).not.toContain('<!-- snippet')
    }
  })

  test('the sidebar lists every page once, the error codes among them', () => {
    const listed = navRoutes(site.nav)
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed).toContain(ERROR_CODES_ROUTE)
    const pages = collectPages()
      .map((page) => page.route)
      .filter((route) => route !== '/docs/')
    for (const route of pages) {
      expect(listed, route).toContain(route)
    }
  })

  test('the sidebar is derived from the README’s sections', () => {
    expect(site.nav.map((group) => group.title)).toEqual(
      expect.arrayContaining(['Start here', 'Sign-in methods', 'SDK reference'])
    )
    expect(site.nav[0]?.items[0]).toEqual({
      label: 'Quickstart',
      route: '/quickstart/',
      children: [],
    })
  })

  test('the landing page links only to pages that exist', () => {
    const routes = new Set(collectPages().map((page) => page.route))
    routes.add(ERROR_CODES_ROUTE)
    for (const link of LANDING_LINKS) {
      expect(routes.has(link.route), link.route).toBe(true)
    }
    expect(site.documents.get(LANDING_ROUTE)).toContain('href="/quickstart/"')
  })

  test('a code block of a method page is highlighted, and its snippet markers are gone', () => {
    const html = site.documents.get('/methods/password/') as string
    expect(html).toContain('class="shiki')
    expect(html).not.toContain('snippet:')
  })

  test('links between pages are routes, with their anchors', () => {
    const html = site.documents.get('/methods/password/') as string
    expect(html).toContain('href="/dashboard/#screens"')
    expect(html).not.toMatch(/href="[^"#:]*\.md/)
  })

  test('a link to an ADR leaves for GitHub', () => {
    const html = site.documents.get('/methods/password/') as string
    expect(html).toContain(
      'href="https://github.com/Tula-Solutions/tula-auth-and-user-management/blob/develop/docs/adr/0006-passwords.md"'
    )
  })

  test('the quickstart’s screenshot is copied and shown from the site', () => {
    expect(site.assets).toContain('docs/assets/quickstart-sign-in.png')
    expect(site.documents.get('/quickstart/')).toContain(
      'src="/files/docs/assets/quickstart-sign-in.png"'
    )
  })

  test('every error code of the contract is findable in the search index', () => {
    for (const { code } of errorCodeEntries()) {
      expect(search(site.index, code, 1)[0]?.u).toBe(`${ERROR_CODES_ROUTE}#${code}`)
    }
  })

  test('searching password.too_short finds its anchor', () => {
    expect(search(site.index, 'password.too_short')[0]).toMatchObject({
      t: 'password.too_short',
      u: '/reference/error-codes/#password.too_short',
    })
  })

  test('the pages carry a title, a description and a table of contents source', () => {
    for (const page of site.pages) {
      expect(page.title, page.route).not.toBe('')
      expect(page.description, page.route).not.toBe('')
      expect(page.headings.length, page.route).toBeGreaterThan(0)
    }
  })

  test('the unknown-address page exists', () => {
    expect(site.notFound).toContain('Page not found')
  })
})

describe('pageStats', () => {
  test('measures the document and each of its sections', () => {
    const html =
      '<main><article><div data-docs-section="0">aa</div><div data-docs-section="1">bbbb</div></article></main>'
    const stats = pageStats(html)
    expect(stats.bytes).toBe(html.length)
    expect(stats.sections).toHaveLength(2)
    expect(stats.sections[1]).toBeGreaterThan(stats.sections[0] as number)
  })

  test('counts the lines of highlighted code of each section', () => {
    const html =
      '<div data-docs-section="0">x</div><div data-docs-section="1"><pre><code><span class="line">a</span>\n<span class="line">b</span></code></pre></div>'
    expect(pageStats(html).lines).toEqual([0, 2])
  })

  test('a page of the sample is cut into sections', () => {
    const html = site.documents.get('/methods/password/') as string
    const stats = pageStats(html)
    expect(stats.sections.length).toBeGreaterThan(1)
    expect(html.match(/data-docs-section="/g)).toHaveLength(stats.sections.length)
  })

  test('the article holds nothing but sections', () => {
    for (const route of ['/quickstart/', '/methods/password/', '/reference/expo-screens/']) {
      const html = site.documents.get(route) as string
      const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'))
      const inner = article.slice(article.indexOf('>') + 1)
      expect(inner.startsWith('<div data-docs-section="0">'), route).toBe(true)
      expect(inner.endsWith('</div>'), route).toBe(true)
    }
  })
})

describe('the size of the sections of the built pages', () => {
  test('no section is over the cap unless it is a single block', () => {
    for (const route of site.documents.keys()) {
      const html = site.documents.get(route) as string
      const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'))
      const sections = article.split(`<div ${SECTION_ATTRIBUTE}="`).slice(1)
      for (const [index, section] of sections.entries()) {
        if (section.length > SECTION_CAP + 1000) {
          // One block: the section's own tag opens and closes around a single top-level element.
          const body = section.slice(section.indexOf('>') + 1, section.lastIndexOf('</div>'))
          const top = body.trim().match(/^<([a-z0-9]+)[\s>]/)?.[1] as string
          expect(body.trim().startsWith(`<${top}`), `${route} section ${index}`).toBe(true)
          expect(body.trim().endsWith(`</${top}>`), `${route} section ${index}`).toBe(true)
        }
      }
    }
  })
})

describe('writeSite', () => {
  test('writes one index.html per route, the search index and the copied images', async () => {
    const out = mkdtempSync(join(tmpdir(), 'docs-site-'))
    try {
      await writeSite(site, out)
      expect(existsSync(join(out, 'index.html'))).toBe(true)
      expect(existsSync(fileOfRoute(out, '/methods/password/'))).toBe(true)
      expect(existsSync(join(out, '404.html'))).toBe(true)
      expect(existsSync(join(out, 'files/docs/assets/quickstart-sign-in.png'))).toBe(true)
      const index = JSON.parse(readFileSync(join(out, 'search-index.json'), 'utf8')) as unknown[]
      expect(index.length).toBe(site.index.length)
      const listed = JSON.parse(readFileSync(join(out, 'pages.json'), 'utf8')) as string[]
      const stats = JSON.parse(readFileSync(join(out, 'page-stats.json'), 'utf8')) as object
      expect(Object.keys(stats).sort()).toEqual(listed)
      expect(listed).toContain('/reference/error-codes/')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  test('fileOfRoute puts a route in its own directory', () => {
    expect(fileOfRoute('/out', '/')).toBe('/out/index.html')
    expect(fileOfRoute('/out', '/a/b/')).toBe('/out/a/b/index.html')
  })
})

describe('the site under a base path', () => {
  test('every address it writes carries the base', async () => {
    const under = await buildSite({ css: [], js: '' }, '/docs-site/', ['/quickstart/'])
    expect(under.documents.get('/quickstart/')).toContain('href="/docs-site/methods/password/"')
    expect(under.index.every((entry) => entry.u.startsWith('/docs-site/'))).toBe(true)
  })

  test('the icons, the manifest and the social card are named under the base, and the font is preloaded', async () => {
    const under = await buildSite(
      { css: [], js: '', fonts: ['/docs-site/assets/geist.woff2'] },
      '/docs-site/',
      ['/quickstart/']
    )
    const html = under.documents.get('/quickstart/') as string
    expect(html).toContain('href="/docs-site/favicon.ico"')
    expect(html).toContain('href="/docs-site/favicon.svg"')
    expect(html).toContain('href="/docs-site/apple-touch-icon.png"')
    expect(html).toContain('href="/docs-site/site.webmanifest"')
    expect(html).toContain('content="https://tula-solutions.github.io/docs-site/og.png"')
    expect(html).toContain(
      '<link rel="preload" as="font" type="font/woff2" href="/docs-site/assets/geist.woff2" crossorigin=""/>'
    )
  })

  test('the header leaves a slot for the version marker and one for the page’s actions', () => {
    const html = site.documents.get('/quickstart/') as string
    expect(html).toContain('data-slot="version"')
    expect(html).toContain('data-slot="banner"')
    expect(html).toContain('data-slot="page-actions"')
  })

  test('the header has a tab for each section that has pages, the page’s own marked current', () => {
    const html = site.documents.get('/quickstart/') as string
    expect(html).toMatch(/<a class="tab" href="\/quickstart\/" aria-current="true"/)
    expect(html).toContain('>Reference</a>')
  })
})

describe('repositoryEnvironment', () => {
  test('reads the repository: files, directories, anchors of Markdown the site does not render', () => {
    const environment = repositoryEnvironment(collectPages(), new Map(), '/')
    expect(environment.kind('docs')).toBe('directory')
    expect(environment.kind('docs/quickstart.md')).toBe('file')
    expect(environment.kind('docs/not-there.md')).toBeNull()
    expect(environment.anchorsOf('docs/adr/0006-passwords.md')?.size).toBeGreaterThan(0)
    expect(environment.anchorsOf('docs/assets/quickstart-sign-in.png')).toBeNull()
  })
})

describe('tokensCss', () => {
  test('writes the site’s palette for light, for a dark system, and for a page set to dark', () => {
    const css = tokensCss()
    expect(css).toContain('--bg: #FAF9F5;')
    expect(css).toContain('--bg: #141412;')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain(":root:not([data-theme='light'])")
    expect(css).toContain(":root[data-theme='dark']")
  })
})
