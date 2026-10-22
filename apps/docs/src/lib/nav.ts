import type { Link, PhrasingContent, Root, RootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { type LinkEnvironment, resolveLink } from './links'

/** One entry of the sidebar. */
export interface NavItem {
  label: string
  /** The page's route, without the base. */
  route: string
  /** Pages grouped under this one (an OAuth provider's checklist under OAuth). */
  children: NavItem[]
}

/** A section of the sidebar: one `##` section of `docs/README.md`. */
export interface NavGroup {
  title: string
  items: NavItem[]
}

/** The longest link text used as a label. */
const MAX_LABEL = 28

/** Labels for pages whose title or link text is a sentence, not a name. */
const LABELS: Readonly<Record<string, string>> = { '/methods/oauth/': 'OAuth providers' }

function textOf(node: PhrasingContent | RootContent): string {
  if ('value' in node && typeof node.value === 'string') {
    return node.value
  }
  if ('children' in node) {
    return (node.children as (PhrasingContent | RootContent)[]).map(textOf).join('')
  }
  return ''
}

function linksIn(node: RootContent | PhrasingContent): Link[] {
  if (node.type === 'link') {
    return [node]
  }
  if ('children' in node) {
    return (node.children as (RootContent | PhrasingContent)[]).flatMap(linksIn)
  }
  return []
}

/**
 * Derive the sidebar from `docs/README.md`.
 *
 * Each `##` heading is a group. In a table, the first link of a row is an item and the other
 * links of the row (the provider checklists of the OAuth row) are its children; in a paragraph
 * or list, every link is an item. Only links to pages of the site count, and a page is listed
 * once, at its first mention. Pages the README never mentions are collected in a last group,
 * so that no page is unreachable from the sidebar.
 *
 * @param source - The text of `docs/README.md`.
 * @param readmeFile - Its path from the repository root, for resolving its links.
 * @param environment - What links may point at.
 * @param titles - The title of each page by route, used when a link's text is too long to be a label.
 * @returns The groups, in the order of the README.
 */
export function buildNav(
  source: string,
  readmeFile: string,
  environment: LinkEnvironment,
  titles: ReadonlyMap<string, string>
): NavGroup[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root
  const listed = new Set<string>()
  const base = environment.base.replace(/\/$/, '')

  function itemFor(link: Link, inTable: boolean): NavItem | null {
    const resolved = resolveLink(readmeFile, link.url, environment)
    if (resolved.kind !== 'page') {
      return null
    }
    const route = resolved.href.slice(base.length).replace(/#.*$/, '')
    if (listed.has(route)) {
      return null
    }
    listed.add(route)
    const text = textOf(link).trim()
    // A link text is a label when it names the page, which is so in a table's first column;
    // in a sentence ("how") or as a list of eight provider names it does not.
    const names = inTable && text.length <= MAX_LABEL
    const label = LABELS[route] ?? (names ? text : (titles.get(route) ?? text))
    return { label, route, children: [] }
  }

  const groups: NavGroup[] = []
  let current: NavGroup | null = null
  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 2) {
      current = { title: textOf(node).trim(), items: [] }
      groups.push(current)
      continue
    }
    if (current === null) {
      continue
    }
    if (node.type === 'table') {
      for (const row of node.children) {
        const [head, ...rest] = linksIn(row)
        const item = head === undefined ? null : itemFor(head, true)
        if (item !== null) {
          item.children = rest
            .map((link) => itemFor(link, true))
            .filter((child): child is NavItem => child !== null)
          current.items.push(item)
        }
      }
    } else {
      for (const link of linksIn(node)) {
        const item = itemFor(link, false)
        if (item !== null) {
          current.items.push(item)
        }
      }
    }
  }

  const rest: NavItem[] = []
  for (const [file, route] of environment.routes) {
    if (!listed.has(route) && file !== readmeFile) {
      rest.push({ label: titles.get(route) ?? route, route, children: [] })
    }
  }
  const nonEmpty = groups.filter((group) => group.items.length > 0)
  return rest.length > 0 ? [...nonEmpty, { title: 'More', items: rest }] : nonEmpty
}

/**
 * Every route a sidebar lists, children included.
 *
 * @param nav - The groups.
 * @returns The routes in sidebar order.
 */
export function navRoutes(nav: readonly NavGroup[]): string[] {
  const routes: string[] = []
  function walk(items: readonly NavItem[]): void {
    for (const item of items) {
      routes.push(item.route)
      walk(item.children)
    }
  }
  for (const group of nav) {
    walk(group.items)
  }
  return routes
}
