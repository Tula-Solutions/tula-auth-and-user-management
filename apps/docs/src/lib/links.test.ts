import { describe, expect, test } from 'bun:test'
import { fakeEnvironment } from '../testing/environment'
import { isExternal, LinkError, resolveLink } from './links'

const environment = fakeEnvironment(
  {
    'docs/quickstart.md': new Set(['build-the-api-image']),
    'docs/methods/password.md': new Set(['switch-it-on', 'troubleshooting']),
    'docs/adr/0006-passwords.md': new Set(['decision']),
    'docs/plans/phase-1.md': new Set(),
    'docs/assets/shot.png': null,
    'docs/design/Design.pdf': null,
    'docs/reference/README.md': new Set(['sdk-reference']),
    'packages/core/README.md': new Set(['install']),
    'apps/api/src/index.ts': null,
  },
  ['docs/adr', 'docs/reference', 'docs/assets', 'packages'],
  {
    'docs/quickstart.md': '/quickstart/',
    'docs/methods/password.md': '/methods/password/',
    'docs/reference/README.md': '/reference/',
  }
)

const REPO = 'https://github.com/Tula-Solutions/tula-auth-and-user-management'

describe('resolveLink', () => {
  test.each([
    ['docs/quickstart.md', 'methods/password.md', '/methods/password/'],
    ['docs/quickstart.md', 'methods/password.md#switch-it-on', '/methods/password/#switch-it-on'],
    [
      'docs/methods/password.md',
      '../quickstart.md#build-the-api-image',
      '/quickstart/#build-the-api-image',
    ],
    [
      'docs/methods/password.md',
      './password.md#troubleshooting',
      '/methods/password/#troubleshooting',
    ],
    // A directory is its README when that is a page.
    ['docs/quickstart.md', 'reference/', '/reference/'],
    ['docs/quickstart.md', 'reference/#sdk-reference', '/reference/#sdk-reference'],
  ])('a link from %s to %s is the page %s', (from, target, href) => {
    expect(resolveLink(from, target, environment)).toMatchObject({ kind: 'page', href })
  })

  test('a fragment alone points into the same file', () => {
    expect(resolveLink('docs/quickstart.md', '#build-the-api-image', environment)).toMatchObject({
      kind: 'page',
      href: '/quickstart/#build-the-api-image',
    })
  })

  test('the base path is part of every page address', () => {
    const under = fakeEnvironment(
      { 'docs/a.md': new Set() },
      [],
      { 'docs/a.md': '/a/' },
      '/docs-site/'
    )
    expect(resolveLink('docs/a.md', 'a.md', under)).toMatchObject({
      kind: 'page',
      href: '/docs-site/a/',
    })
  })

  test.each([
    [
      'docs/quickstart.md',
      '../packages/core/README.md',
      `${REPO}/blob/develop/packages/core/README.md`,
    ],
    [
      'docs/quickstart.md',
      '../packages/core/README.md#install',
      `${REPO}/blob/develop/packages/core/README.md#install`,
    ],
    // An ADR is a file the site does not render.
    [
      'docs/methods/password.md',
      '../adr/0006-passwords.md#decision',
      `${REPO}/blob/develop/docs/adr/0006-passwords.md#decision`,
    ],
    ['docs/quickstart.md', 'plans/phase-1.md', `${REPO}/blob/develop/docs/plans/phase-1.md`],
    [
      'docs/quickstart.md',
      '../apps/api/src/index.ts#L10',
      `${REPO}/blob/develop/apps/api/src/index.ts#L10`,
    ],
    ['docs/quickstart.md', 'design/Design.pdf', `${REPO}/blob/develop/docs/design/Design.pdf`],
    // A directory with no page of its own is shown on GitHub.
    ['docs/quickstart.md', 'adr/', `${REPO}/tree/develop/docs/adr`],
  ])('a link from %s to %s leaves for the repository on GitHub', (from, target, href) => {
    expect(resolveLink(from, target, environment)).toMatchObject({ kind: 'repository', href })
  })

  test('an image of the repository is an asset to copy', () => {
    expect(resolveLink('docs/quickstart.md', 'assets/shot.png', environment)).toMatchObject({
      kind: 'asset',
      file: 'docs/assets/shot.png',
    })
  })

  test.each(['https://example.com/a', 'mailto:a@b.test', '//cdn.test/x'])(
    'a URL such as %s is left alone',
    (target) => {
      expect(isExternal(target)).toBe(true)
      expect(resolveLink('docs/quickstart.md', target, environment)).toMatchObject({
        kind: 'external',
        href: target,
      })
    }
  )

  test('a link to a file that does not exist fails, naming the file and the link', () => {
    expect(() => resolveLink('docs/quickstart.md', 'methods/nope.md', environment)).toThrow(
      LinkError
    )
    expect(() => resolveLink('docs/quickstart.md', 'methods/nope.md', environment)).toThrow(
      'docs/quickstart.md: link "methods/nope.md" points at a file that does not exist'
    )
  })

  test('an anchor the target page does not have fails', () => {
    expect(() =>
      resolveLink('docs/quickstart.md', 'methods/password.md#no-such-heading', environment)
    ).toThrow('does not have')
    expect(() => resolveLink('docs/quickstart.md', '#no-such-heading', environment)).toThrow(
      'does not have'
    )
  })

  test('an anchor of a Markdown file the site does not render is checked as well', () => {
    expect(() =>
      resolveLink('docs/quickstart.md', '../packages/core/README.md#gone', environment)
    ).toThrow('does not have')
    expect(() =>
      resolveLink('docs/quickstart.md', 'adr/../adr/0006-passwords.md#gone', environment)
    ).toThrow('does not have')
  })

  test('a link that climbs out of the repository fails', () => {
    expect(() => resolveLink('docs/quickstart.md', '../../outside.md', environment)).toThrow(
      'leaves the repository'
    )
    expect(() => resolveLink('docs/quickstart.md', '/etc/passwd', environment)).toThrow(LinkError)
  })

  test('a malformed escape fails instead of being passed on', () => {
    expect(() => resolveLink('docs/quickstart.md', 'methods/%E0%A4%A.md', environment)).toThrow(
      'not a valid URL'
    )
  })

  test('a query string is dropped before the file is looked up', () => {
    expect(
      resolveLink('docs/quickstart.md', 'methods/password.md?plain=1', environment)
    ).toMatchObject({
      kind: 'page',
      href: '/methods/password/',
    })
  })
})
