import { beforeAll, describe, expect, test } from 'bun:test'
import { ERROR_CODES_ROUTE } from './error-codes'
import { buildSite, type Site } from './site'

// The anatomy of a page (breadcrumb, actions, footer) as the build writes it, under a base, for
// a method page and the error codes. What the script does with it is the Playwright project's.

const ORIGIN = 'https://tula-solutions.github.io'
const PASSWORD = '/methods/password/'

let dated: Site
let undated: Site
beforeAll(async () => {
  dated = await buildSite({ css: [], js: '' }, '/docs-site/', [PASSWORD, ERROR_CODES_ROUTE], {
    updated: () => '2026-10-20',
  })
  undated = await buildSite({ css: [], js: '' }, '/docs-site/', [PASSWORD])
})

const password = () => dated.documents.get(PASSWORD) as string

describe('the page anatomy', () => {
  test('a page has a breadcrumb that ends at the page, its tab linked under the base', () => {
    const crumb = password().match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)?.[0] as string
    expect(crumb).toContain('aria-label="Breadcrumb"')
    expect(crumb).toContain('<a href="/docs-site/methods/password/">Guides</a>')
    expect(crumb).toContain('<span>Sign-in methods</span>')
    expect(crumb).toContain('<span aria-current="page">Password</span>')
  })

  test('the actions are plain links without a script, and the deeplinks carry the encoded prompt', () => {
    const html = password()
    const twin = `${ORIGIN}/docs-site/methods/password.md`
    const prompt = encodeURIComponent(`Read ${twin} and help me with it`)
    expect(html).toContain(`href="https://claude.ai/new?q=${prompt}"`)
    expect(html).toContain(`href="https://chatgpt.com/?q=${prompt}"`)
    expect(html).toContain(`href="https://cursor.com/link/prompt?text=${prompt}"`)
    expect(html).toContain('data-twin="/docs-site/methods/password.md"')
    expect(html).toContain('<a class="split-main" href="/docs-site/methods/password.md">')
    expect(html).toContain('href="/docs-site/mcp/"')
  })

  test('an external action opens in a new tab without handing over the opener', () => {
    for (const link of password().match(
      /<a [^>]*href="https:\/\/(?:claude|chatgpt|cursor)[^>]*>/g
    ) ?? []) {
      expect(link).toContain('target="_blank"')
      expect(link).toContain('rel="noopener noreferrer"')
    }
  })

  test('the menu is a menu button for the script: roles, a collapsed state and the control', () => {
    const html = password()
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="page-menu"')
    expect(html).toContain('role="menu"')
    expect(html).toContain('role="status" aria-live="polite"')
  })

  test('the footer says where the source is and when it changed, and links the pages around', () => {
    const html = password()
    expect(html).toContain(
      'href="https://github.com/Tula-Solutions/tula-auth-and-user-management/edit/develop/docs/methods/password.md"'
    )
    expect(html).toContain('<time dateTime="2026-10-20">20 Oct 2026</time>')
    expect(html).toContain('aria-label="Previous and next pages"')
    expect(html).toContain('rel="prev"')
    expect(html).toContain('rel="next"')
  })

  test('the date is left out where the build was not given one', () => {
    expect(undated.documents.get(PASSWORD) as string).not.toContain('Last updated')
  })

  test('the feedback sends nothing: only a link to a prefilled issue', () => {
    const html = password()
    expect(html).toContain('Was this page helpful?')
    expect(html).toContain('/issues/new?title=Docs%3A+Password')
    expect(html).not.toContain('<form')
  })

  test('the error codes page shows its source and offers no edit', () => {
    const html = dated.documents.get(ERROR_CODES_ROUTE) as string
    expect(html).toContain('blob/develop/packages/contract/src/error-codes.ts')
    expect(html).toContain('View the source on GitHub')
    expect(html).not.toContain('Edit this page on GitHub')
  })

  test('the table of contents has a place for the current heading’s name', () => {
    expect(password()).toContain('data-toc-current')
  })
})
