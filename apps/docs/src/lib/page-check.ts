import type { Element, Root } from 'hast'
import rehypeParse from 'rehype-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { RenderError } from './markdown'

const parser = unified().use(rehypeParse, { fragment: false })

/** The attributes whose value is a list of ids of other elements. */
const ID_LIST_PROPERTIES = ['ariaLabelledBy', 'ariaDescribedBy'] as const

/** The ids in an attribute that hast gives as a string or a list. */
function listOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return list.flatMap((item) => String(item).split(/\s+/)).filter((entry) => entry !== '')
}

/**
 * Check the whole of a rendered page for what the browser tests cannot see once a large page is
 * checked in pieces: no `h1`, a heading level that jumps by two or more across any boundary
 * (from the `h1` on), an id used twice, and a reference by id (`aria-labelledby`,
 * `aria-describedby`, a label's `for`) that points at nothing. Axe checks these only within the
 * part of the page it is given, so the build checks them for the page as a whole.
 *
 * @param label - Names the page in the failure (its route).
 * @param html - The page's document.
 * @throws RenderError naming the page and the problem.
 */
export function checkPage(label: string, html: string): void {
  const tree = parser.parse(html) as Root
  const ids = new Set<string>()
  const references: { attribute: string; id: string; tag: string }[] = []
  let level = 0

  visit(tree, 'element', (node: Element) => {
    const id = node.properties?.id
    if (typeof id === 'string' && id !== '') {
      if (ids.has(id)) {
        throw new RenderError(label, `has the id "${id}" more than once`)
      }
      ids.add(id)
    }
    const heading = /^h([1-6])$/.exec(node.tagName)
    if (heading !== null) {
      const next = Number(heading[1])
      // The page's chrome (the sidebar's group titles) comes before the h1 in the document and
      // is not part of the outline of the content: the levels are followed from the h1 on.
      if (level === 0 && next !== 1) {
        return
      }
      if (next - level >= 2) {
        throw new RenderError(
          label,
          `has an h${next} after an h${level}: a heading level is skipped`
        )
      }
      level = next
    }
    for (const attribute of ID_LIST_PROPERTIES) {
      for (const entry of listOf(node.properties?.[attribute])) {
        references.push({ attribute, id: entry, tag: node.tagName })
      }
    }
    if (node.tagName === 'label') {
      for (const entry of listOf(node.properties?.htmlFor)) {
        references.push({ attribute: 'for', id: entry, tag: 'label' })
      }
    }
  })

  if (level === 0) {
    throw new RenderError(label, 'has no h1')
  }
  for (const { attribute, id, tag } of references) {
    if (!ids.has(id)) {
      throw new RenderError(label, `has a ${tag} whose ${attribute} "${id}" matches no element`)
    }
  }
}
