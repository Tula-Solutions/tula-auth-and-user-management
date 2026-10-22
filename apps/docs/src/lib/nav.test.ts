import { describe, expect, test } from 'bun:test'
import { fakeEnvironment } from '../testing/environment'
import { buildNav, navRoutes } from './nav'

const routes = {
  'docs/README.md': '/docs/',
  'docs/one.md': '/one/',
  'docs/two.md': '/two/',
  'docs/methods/oauth.md': '/methods/oauth/',
  'docs/providers/google.md': '/providers/google/',
  'docs/reference/core.md': '/reference/core/',
  'docs/reference/README.md': '/reference/',
  'docs/orphan.md': '/orphan/',
}
const environment = fakeEnvironment(
  Object.fromEntries(
    [...Object.keys(routes), 'docs/adr/0001.md'].map((file) => [file, new Set<string>()])
  ),
  [],
  routes
)
const titles = new Map([
  ['/reference/', 'SDK reference'],
  ['/methods/oauth/', 'OAuth sign-in with a long title'],
  ['/orphan/', 'An orphan'],
])

const README = `# Docs

Intro with a [link](one.md) that is not in a section.

## Start here

| | |
| --- | --- |
| [One](one.md) | The first. |
| [Two](two.md) | The second, see [One again](one.md). |

## Sign-in

| Method | |
| --- | --- |
| [Google, GitHub, Apple, Microsoft and more](methods/oauth.md) | [Google](providers/google.md) |

## SDK reference

Generated ([how](reference/README.md)): [\`@tula-tech/core\`](reference/core.md), and
[an ADR](adr/0001.md) that the site does not render.

## Empty

Nothing here but [a GitHub link](https://example.com).
`

describe('buildNav', () => {
  const nav = buildNav(README, 'docs/README.md', environment, titles)

  test('each ## section is a group, and a section with no page of the site is dropped', () => {
    expect(nav.map((group) => group.title)).toEqual([
      'Start here',
      'Sign-in',
      'SDK reference',
      'More',
    ])
  })

  test('a table row is an item, its other links are its children, and a page is listed once', () => {
    const [start, signIn] = nav
    expect(start?.items.map((item) => item.label)).toEqual(['One', 'Two'])
    expect(signIn?.items).toEqual([
      {
        label: 'OAuth providers',
        route: '/methods/oauth/',
        children: [{ label: 'Google', route: '/providers/google/', children: [] }],
      },
    ])
  })

  test('in a sentence a link is labelled with the page’s title, and a file the site lacks is skipped', () => {
    const reference = nav.find((group) => group.title === 'SDK reference')
    expect(reference?.items.map((item) => item.label)).toEqual(
      ['SDK reference', 'core'].map((label, index) =>
        index === 0 ? label : (reference?.items[1]?.label ?? label)
      )
    )
    expect(reference?.items.map((item) => item.route)).toEqual(['/reference/', '/reference/core/'])
  })

  test('a page the README never mentions is collected in a last group', () => {
    expect(nav.at(-1)).toEqual({
      title: 'More',
      items: [{ label: 'An orphan', route: '/orphan/', children: [] }],
    })
  })

  test('every page but the README itself is in the sidebar once', () => {
    const listed = navRoutes(nav)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(
      Object.values(routes)
        .filter((route) => route !== '/docs/')
        .sort()
    )
  })
})
