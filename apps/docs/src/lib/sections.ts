import type { NavGroup, NavItem } from './nav'

/** A tab of the header: a part of the documentation with the sidebar groups that belong to it. */
export interface Section {
  /** A stable id, for the tab's `data-section`. */
  id: string
  label: string
  /** The sidebar groups that make it up (the `##` sections of `docs/README.md`, then any group built by hand). */
  groups: NavGroup[]
}

/** Where the pages of `docs/README.md` go in the header's tabs. */
interface SectionRule {
  id: string
  label: string
  /** Sidebar groups, by title, that belong here whole. */
  groups?: readonly string[]
  /** Pages, by route, that belong here whatever group the README puts them in. */
  routes?: readonly string[]
  /** The title of the group the `routes` are collected into. */
  routesTitle?: string
}

/**
 * The header's tabs, in order. The sidebar's groups still come from `docs/README.md`; this says
 * which tab shows which. A route listed here moves out of its README group into its tab's own
 * group, and a group the rules do not name goes to the default tab, so that no page is lost.
 * A tab with no pages is not drawn: "Components" appears when the docs have a page for it.
 */
export const SECTION_RULES: readonly SectionRule[] = [
  {
    id: 'start',
    label: 'Get started',
    routes: ['/quickstart/', '/playground/'],
    routesTitle: 'Start here',
  },
  {
    id: 'guides',
    label: 'Guides',
    groups: [
      'Sign-in methods',
      'More about a user',
      'What your users are sent',
      'Claims for your backend',
      'Events for your backend',
      'Questions for your backend',
      'Native apps',
    ],
  },
  {
    id: 'self-hosting',
    label: 'Self-hosting',
    routes: ['/self-host/', '/releasing/'],
    routesTitle: 'Run it yourself',
  },
  { id: 'tools', label: 'CLI & MCP', groups: ['Tools'] },
  { id: 'reference', label: 'Reference', groups: ['SDK reference', 'More', 'For contributors'] },
]

/** The tab that takes a group the rules do not name. */
const DEFAULT_SECTION = 'guides'

/**
 * Sort the sidebar's groups into the header's tabs.
 *
 * @param nav - The groups of the sidebar, in README order.
 * @param rules - Which tab shows what; {@link SECTION_RULES} by default.
 * @returns The tabs that have at least one page, each with its groups; every item of `nav`
 *   appears in exactly one.
 */
export function buildSections(
  nav: readonly NavGroup[],
  rules: readonly SectionRule[] = SECTION_RULES
): Section[] {
  const byRoute = new Map<string, string>()
  const byGroup = new Map<string, string>()
  for (const rule of rules) {
    for (const route of rule.routes ?? []) {
      byRoute.set(route, rule.id)
    }
    for (const title of rule.groups ?? []) {
      byGroup.set(title, rule.id)
    }
  }
  const sections = new Map<string, Section>(
    rules.map((rule) => [rule.id, { id: rule.id, label: rule.label, groups: [] }])
  )
  const collected = new Map<string, NavItem[]>()
  const fallback = sections.has(DEFAULT_SECTION) ? DEFAULT_SECTION : (rules[0]?.id as string)
  for (const group of nav) {
    const home = byGroup.get(group.title) ?? fallback
    const kept: NavItem[] = []
    for (const item of group.items) {
      const moved = byRoute.get(item.route)
      if (moved !== undefined) {
        collected.set(moved, [...(collected.get(moved) ?? []), item])
      } else {
        kept.push(item)
      }
    }
    if (kept.length > 0) {
      sections.get(home)?.groups.push({ title: group.title, items: kept })
    }
  }
  for (const rule of rules) {
    const items = collected.get(rule.id)
    if (items !== undefined && items.length > 0) {
      // The pages a rule names come first in their tab, in the order the rule lists them.
      const order = rule.routes ?? []
      items.sort((a, b) => order.indexOf(a.route) - order.indexOf(b.route))
      sections.get(rule.id)?.groups.unshift({ title: rule.routesTitle ?? rule.label, items })
    }
  }
  return [...sections.values()].filter((section) => section.groups.length > 0)
}

/**
 * The route a tab leads to: its first page.
 *
 * @param section - A section.
 * @returns A route without the base.
 */
export function sectionHome(section: Section): string {
  return section.groups[0]?.items[0]?.route as string
}

function hasRoute(items: readonly NavItem[], route: string): boolean {
  return items.some((item) => item.route === route || hasRoute(item.children, route))
}

/**
 * The tab a page belongs to.
 *
 * @param sections - From {@link buildSections}.
 * @param route - The page's route, without the base.
 * @returns The section that lists it, or `undefined` for a page no tab lists (the landing
 *   page, the documentation index, the 404 page).
 */
export function sectionOf(sections: readonly Section[], route: string): Section | undefined {
  return sections.find((section) => section.groups.some((group) => hasRoute(group.items, route)))
}
