import { describe, expect, test } from 'bun:test'
import type { NavGroup } from './nav'
import { buildSections, SECTION_RULES, sectionHome, sectionOf } from './sections'

function item(route: string) {
  return { label: route, route, children: [] }
}

const NAV: NavGroup[] = [
  { title: 'Start here', items: [item('/quickstart/'), item('/self-host/')] },
  { title: 'Sign-in methods', items: [item('/methods/password/')] },
  { title: 'Tools', items: [item('/cli/')] },
  { title: 'SDK reference', items: [item('/reference/'), item('/reference/error-codes/')] },
  { title: 'Something new', items: [item('/new/')] },
]

describe('buildSections', () => {
  test('sorts the sidebar’s groups into the header’s tabs, in order', () => {
    const sections = buildSections(NAV)
    expect(sections.map((section) => section.id)).toEqual([
      'start',
      'guides',
      'self-hosting',
      'tools',
      'reference',
    ])
  })

  test('moves a named page out of its README group into its tab', () => {
    const sections = buildSections(NAV)
    const start = sections.find((section) => section.id === 'start')
    expect(start?.groups.flatMap((group) => group.items.map((one) => one.route))).toEqual([
      '/quickstart/',
    ])
    const hosting = sections.find((section) => section.id === 'self-hosting')
    expect(hosting?.groups[0]?.items[0]?.route).toBe('/self-host/')
  })

  test('every page of the sidebar is in exactly one tab, and a group no rule names is not lost', () => {
    const routes = buildSections(NAV).flatMap((section) =>
      section.groups.flatMap((group) => group.items.map((one) => one.route))
    )
    expect(routes.sort()).toEqual(
      NAV.flatMap((group) => group.items.map((one) => one.route)).sort()
    )
    expect(sectionOf(buildSections(NAV), '/new/')?.id).toBe('guides')
  })

  test('a tab with no page is not drawn', () => {
    const sections = buildSections([{ title: 'Tools', items: [item('/cli/')] }])
    expect(sections.map((section) => section.id)).toEqual(['tools'])
  })

  test('a tab leads to its first page, and a page knows its tab', () => {
    const sections = buildSections(NAV)
    expect(sectionHome(sections[0] as (typeof sections)[number])).toBe('/quickstart/')
    expect(sectionOf(sections, '/cli/')?.label).toBe('CLI & MCP')
    expect(sectionOf(sections, '/')).toBeUndefined()
  })

  test('the rules name each tab once', () => {
    const ids = SECTION_RULES.map((rule) => rule.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
