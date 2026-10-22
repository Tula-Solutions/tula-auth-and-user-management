import { beforeAll, describe, expect, test } from 'bun:test'
import type { ReleaseInfo } from './release'
import { buildSite, LANDING_ROUTE, type Site } from './site'

// The same pages built as each of the three docs the deployed site holds: the latest release's
// at the root, the development branch's under next/, and, before any release has the site, the
// development branch's at the root. A sample, as in `site.test.ts`.

const ROOT = '/tula-auth-and-user-management/'
const NEXT = `${ROOT}next/`
const ORIGIN = 'https://tula-solutions.github.io'
const SAMPLE = [LANDING_ROUTE, '/quickstart/']

function build(release: ReleaseInfo | null, base: string): Promise<Site> {
  return buildSite(
    { css: [`${base}assets/main.css`], js: `${base}assets/main.js` },
    base,
    SAMPLE,
    {},
    release
  )
}

let released: Site
let next: Site
let unreleased: Site
let plain: Site
beforeAll(async () => {
  released = await build({ channel: 'release', version: '0.1.2', origin: ORIGIN }, ROOT)
  next = await build({ channel: 'next', version: '0.1.2', origin: ORIGIN }, NEXT)
  unreleased = await build({ channel: 'unreleased', version: null, origin: ORIGIN }, ROOT)
  plain = await build(null, ROOT)
})

const page = (site: Site, route: string) => site.documents.get(route) as string

describe('the released docs', () => {
  test('say their version and lead to next, with no banner and no noindex', () => {
    const html = page(released, '/quickstart/')
    expect(html).toContain('>v0.1.2<')
    expect(html).toContain(`data-docs-version="" href="${NEXT}quickstart/"`)
    expect(html).not.toContain('data-docs-banner')
    expect(html).not.toContain('noindex')
  })

  test('are their own canonical address', () => {
    expect(page(released, '/quickstart/')).toContain(
      `<link rel="canonical" href="${ORIGIN}${ROOT}quickstart/"/>`
    )
    expect(page(released, LANDING_ROUTE)).toContain(
      `<link rel="canonical" href="${ORIGIN}${ROOT}"/>`
    )
  })

  test('the 404 page leads to the start page of next, not to a page that may not exist', () => {
    expect(released.notFound).toContain(`href="${NEXT}"`)
    expect(released.notFound).not.toContain('rel="canonical"')
  })
})

describe('the development docs', () => {
  test('say they are unreleased, link to the released docs and are not indexed', () => {
    const html = page(next, '/quickstart/')
    expect(html).toContain('data-docs-banner="next"')
    expect(html).toContain('These are the unreleased docs')
    expect(html).toContain(`data-docs-version="" href="${ROOT}quickstart/"`)
    expect(html).toContain('Read the docs of v0.1.2')
    expect(html).toContain('<meta name="robots" content="noindex"/>')
    expect(html).not.toContain('rel="canonical"')
  })

  test('are addressed under next/', () => {
    expect(page(next, '/quickstart/')).toContain(`<meta name="docs-base" content="${NEXT}"/>`)
    expect(page(next, '/quickstart/')).toContain(`href="${NEXT}docs/"`)
  })

  test('without a release there is no link to released docs, and no claim of one', async () => {
    const site = await build({ channel: 'next', version: null, origin: null }, NEXT)
    expect(page(site, LANDING_ROUTE)).toContain('No release carries them yet.')
    expect(page(site, LANDING_ROUTE)).not.toContain('latest release')
  })
})

describe('the root before any release has the site', () => {
  test('says it is the development version, and has no switch', () => {
    const html = page(unreleased, '/quickstart/')
    expect(html).toContain('data-docs-banner="unreleased"')
    expect(html).toContain('No release carries these docs yet')
    expect(html).toContain('>unreleased<')
    expect(html).not.toContain('data-docs-version')
    expect(html).not.toContain('noindex')
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${ROOT}quickstart/"/>`)
  })
})

describe('a site with one version', () => {
  test('draws no marker, banner, canonical address or noindex', () => {
    const html = page(plain, '/quickstart/')
    for (const text of ['data-docs-version', 'data-docs-banner', 'canonical', 'noindex']) {
      expect(html, text).not.toContain(text)
    }
  })
})
