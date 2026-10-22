import { describe, expect, test } from 'bun:test'
import { breadcrumb, neighbours, pageOrder } from './anatomy'
import type { NavGroup } from './nav'
import { buildSections } from './sections'

const item = (route: string, label: string, children: NavGroup['items'] = []) => ({
  route,
  label,
  children,
})

const nav: NavGroup[] = [
  { title: 'Start', items: [item('/quickstart/', 'Quickstart')] },
  {
    title: 'Sign-in methods',
    items: [
      item('/methods/password/', 'Password'),
      item('/methods/oauth/', 'OAuth providers', [item('/providers/google/', 'Google')]),
    ],
  },
  { title: 'Tools', items: [item('/cli/', 'CLI')] },
  { title: 'SDK reference', items: [item('/reference/core/', 'Core')] },
]
const sections = buildSections(nav)

describe('pageOrder', () => {
  test('follows the tabs, their groups and a page before the pages under it', () => {
    expect(pageOrder(sections).map((page) => page.route)).toEqual([
      '/quickstart/',
      '/methods/password/',
      '/methods/oauth/',
      '/providers/google/',
      '/cli/',
      '/reference/core/',
    ])
  })

  test('says which tab and group each page is listed under', () => {
    const google = pageOrder(sections).find((page) => page.route === '/providers/google/')
    expect(google).toEqual({
      route: '/providers/google/',
      label: 'Google',
      section: 'Guides',
      group: 'Sign-in methods',
    })
  })

  test('lists a page once even if the tree names it twice', () => {
    const twice = buildSections([
      { title: 'Sign-in methods', items: [item('/a/', 'A')] },
      { title: 'More about a user', items: [item('/a/', 'A again')] },
    ])
    expect(pageOrder(twice).map((page) => page.route)).toEqual(['/a/'])
  })
})

describe('neighbours', () => {
  const order = pageOrder(sections)

  test('are the pages either side, across tabs', () => {
    const around = neighbours(order, '/methods/password/')
    expect(around.previous?.route).toBe('/quickstart/')
    expect(around.next?.route).toBe('/methods/oauth/')
    expect(neighbours(order, '/providers/google/').next?.route).toBe('/cli/')
  })

  test('have no previous page at the start and no next page at the end', () => {
    expect(neighbours(order, '/quickstart/').previous).toBeUndefined()
    expect(neighbours(order, '/reference/core/').next).toBeUndefined()
  })

  test('are nothing for a page the sidebar does not list', () => {
    expect(neighbours(order, '/docs/')).toEqual({ previous: undefined, next: undefined })
  })
})

describe('breadcrumb', () => {
  test('is the tab, the group and the page; the tab links to its first page, the page does not link', () => {
    expect(breadcrumb(sections, '/methods/password/')).toEqual([
      { label: 'Guides', route: '/methods/password/' },
      { label: 'Sign-in methods' },
      { label: 'Password' },
    ])
  })

  test('names the page a nested page hangs under, as a link', () => {
    expect(breadcrumb(sections, '/providers/google/')).toEqual([
      { label: 'Guides', route: '/methods/password/' },
      { label: 'Sign-in methods' },
      { label: 'OAuth providers', route: '/methods/oauth/' },
      { label: 'Google' },
    ])
  })

  test('is empty for a page no tab lists', () => {
    expect(breadcrumb(sections, '/docs/')).toEqual([])
  })
})
