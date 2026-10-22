import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import { DOCS_DIR } from './config'
import { collectPages, inScope, routeOf } from './pages'

describe('routeOf', () => {
  test.each([
    ['docs/quickstart.md', '/quickstart/'],
    ['docs/methods/password.md', '/methods/password/'],
    ['docs/providers/x.md', '/providers/x/'],
    ['docs/reference/README.md', '/reference/'],
    ['docs/reference/core.md', '/reference/core/'],
    // The index of docs/ is not `/`: the landing page owns it.
    ['docs/README.md', '/docs/'],
  ])('%s is %s', (file, route) => {
    expect(routeOf(file)).toBe(route)
  })
})

describe('inScope', () => {
  test.each([
    ['docs/quickstart.md', true],
    ['docs/reference/core.md', true],
    ['docs/plans/phase-1.md', false],
    ['docs/adr/0001-architecture.md', false],
    ['docs/codebase-map/README.md', false],
    ['docs/assets/quickstart-sign-in.png', false],
    ['packages/core/README.md', false],
    // A directory that only starts like an excluded one is in scope.
    ['docs/planning/notes.md', true],
  ])('%s: %s', (file, expected) => {
    expect(inScope(file)).toBe(expected)
  })
})

describe('collectPages', () => {
  const pages = collectPages()

  test('every Markdown file under docs/ except plans, adr and the codebase map has a page', () => {
    const expected = [...new Glob('**/*.md').scanSync({ cwd: DOCS_DIR })]
      .map((file) => `docs/${file}`)
      .filter((file) => !/^docs\/(plans|adr|codebase-map)\//.test(file))
      .sort()
    expect(pages.map((page) => page.file)).toEqual(expected)
    expect(pages.length).toBeGreaterThan(40)
  })

  test('no two files share a route, and no page takes the landing page’s', () => {
    const routes = pages.map((page) => page.route)
    expect(new Set(routes).size).toBe(routes.length)
    expect(routes).not.toContain('/')
  })

  test('what the site leaves out is not among the pages', () => {
    expect(pages.some((page) => /\/(plans|adr|codebase-map)\//.test(page.file))).toBe(false)
  })
})
