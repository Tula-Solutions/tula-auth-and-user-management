import type { NavItem } from './nav'
import { type Section, sectionHome } from './sections'

/** One step of a page's breadcrumb. */
export interface Crumb {
  label: string
  /** The route it leads to, without the base; absent for a step that is not a page. */
  route?: string
}

/** A page in the order the sidebar lists them. */
export interface OrderedPage {
  route: string
  label: string
  /** The tab, then the sidebar group, it is listed under. */
  section: string
  group: string
}

function walk(
  items: readonly NavItem[],
  visit: (item: NavItem, parents: readonly NavItem[]) => boolean,
  parents: readonly NavItem[] = []
): boolean {
  for (const item of items) {
    if (visit(item, parents) || walk(item.children, visit, [...parents, item])) {
      return true
    }
  }
  return false
}

/**
 * Every page in the order a reader meets them in the sidebar: the header's tabs in order, each
 * tab's groups in order, a page before the pages grouped under it.
 *
 * @param sections - From `buildSections`.
 * @returns The pages, each once.
 */
export function pageOrder(sections: readonly Section[]): OrderedPage[] {
  const pages: OrderedPage[] = []
  const seen = new Set<string>()
  for (const section of sections) {
    for (const group of section.groups) {
      const emit = (items: readonly NavItem[]): void => {
        for (const item of items) {
          if (!seen.has(item.route)) {
            seen.add(item.route)
            pages.push({
              route: item.route,
              label: item.label,
              section: section.label,
              group: group.title,
            })
          }
          emit(item.children)
        }
      }
      emit(group.items)
    }
  }
  return pages
}

/**
 * The page before and the page after one, in sidebar order.
 *
 * @param order - From {@link pageOrder}.
 * @param route - The current page's route.
 * @returns The neighbours; either is `undefined` at an end, and both for a page not in the order.
 */
export function neighbours(
  order: readonly OrderedPage[],
  route: string
): { previous: OrderedPage | undefined; next: OrderedPage | undefined } {
  const at = order.findIndex((page) => page.route === route)
  if (at === -1) {
    return { previous: undefined, next: undefined }
  }
  return { previous: order[at - 1], next: order[at + 1] }
}

/**
 * A page's breadcrumb, from the sidebar's tree: the tab (a link), the group (text: a group is
 * not a page), the pages it hangs under, and the page itself (the last step, not a link).
 *
 * @param sections - From `buildSections`.
 * @param route - The page's route.
 * @returns The steps; empty for a page no tab lists.
 */
export function breadcrumb(sections: readonly Section[], route: string): Crumb[] {
  for (const section of sections) {
    for (const group of section.groups) {
      let found: Crumb[] | undefined
      walk(group.items, (item, parents) => {
        if (item.route !== route) {
          return false
        }
        found = [
          { label: section.label, route: sectionHome(section) },
          { label: group.title },
          ...parents.map((parent) => ({ label: parent.label, route: parent.route })),
          { label: item.label },
        ]
        return true
      })
      if (found !== undefined) {
        return found
      }
    }
  }
  return []
}
