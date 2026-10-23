import { beforeAll, describe, expect, test } from 'bun:test'
import { ERROR_CODES_ROUTE } from './error-codes'
import { buildSite, LANDING_ROUTE, type Site } from './site'

// The site as GitHub Pages serves it: under the repository's name, not at a domain's root. An
// address written from the host's root (`href="/quickstart/"`) works on a local server and is a
// 404 there, so every address the build writes is held to the base here, read from the HTML as
// text and not through `checkPage`, which the build itself runs. A sample of pages, as in
// `site.test.ts`: every page is rendered under a sub-path by `generate:check`.

const BASE = '/tula-auth-and-user-management/'
const SAMPLE = [LANDING_ROUTE, '/docs/', '/quickstart/', '/methods/password/', ERROR_CODES_ROUTE]

let site: Site
beforeAll(async () => {
  site = await buildSite(
    { css: [`${BASE}assets/main.css`], js: `${BASE}assets/main.js` },
    BASE,
    SAMPLE
  )
})

/** Every address in a document's `href`, `src`, `srcset` and `action` attributes. */
function addresses(html: string): string[] {
  const found: string[] = []
  for (const match of html.matchAll(/\s(href|src|srcset|action)="([^"]*)"/g)) {
    const [, attribute, value] = match as unknown as [string, string, string]
    if (attribute === 'srcset') {
      found.push(...value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? ''))
    } else {
      found.push(value)
    }
  }
  return found
}

/** The addresses that leave the base: from the host's root but not under it, or `//host`. */
function outside(html: string): string[] {
  return addresses(html).filter(
    (address) => address.startsWith('//') || (address.startsWith('/') && !address.startsWith(BASE))
  )
}

describe('the site built under a sub-path', () => {
  test('the sample is rendered', () => {
    expect([...site.documents.keys()].sort()).toEqual([...SAMPLE].sort())
  })

  test('no page holds an address from the host root outside the base', () => {
    for (const [route, html] of site.documents) {
      expect(outside(html), route).toEqual([])
      // The scan reads something: every page links to its own site.
      expect(
        addresses(html).filter((address) => address.startsWith(BASE)).length,
        route
      ).toBeGreaterThan(5)
    }
  })

  test('the 404 page, which a host serves at any depth, holds none either', () => {
    expect(outside(site.notFound)).toEqual([])
    expect(site.notFound).toContain(`href="${BASE}"`)
    expect(site.notFound).toContain(`src="${BASE}assets/main.js"`)
  })

  test('the script is told the base, so the search index is fetched from under it', () => {
    for (const [route, html] of site.documents) {
      expect(html, route).toContain(`<meta name="docs-base" content="${BASE}"/>`)
    }
  })

  test('the sidebar, the header, the landing page and an image are under the base', () => {
    const quickstart = site.documents.get('/quickstart/') as string
    expect(quickstart).toContain(`href="${BASE}docs/"`)
    expect(quickstart).toContain(`href="${BASE}methods/password/"`)
    expect(quickstart).toMatch(new RegExp(`src="${BASE}files/docs/assets/[^"]+\\.png"`))
    expect(site.documents.get(LANDING_ROUTE)).toContain(`href="${BASE}quickstart/"`)
  })

  test('every search result leads under the base', () => {
    expect(site.index.length).toBeGreaterThan(0)
    for (const entry of site.index) {
      expect(entry.u.startsWith(BASE), entry.u).toBe(true)
    }
  })
})
