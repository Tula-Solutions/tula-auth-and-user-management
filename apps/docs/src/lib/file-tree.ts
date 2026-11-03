import type { Element, ElementContent } from 'hast'

/** One line of a tree. */
export interface TreeEntry {
  name: string
  note?: string
  directory: boolean
  children: TreeEntry[]
}

function element(
  tagName: string,
  properties: Element['properties'],
  children: ElementContent[]
): Element {
  return { type: 'element', tagName, properties, children }
}

/**
 * Read the text of a `tree` fence: one entry a line, a level deeper for each step of
 * indentation, a name ending in `/` a folder, and ` # words` after a name its note.
 *
 * The text is also what GitHub shows, as a plain code block, so it has to read well as text.
 *
 * @param source - The fence's content.
 * @returns The top-level entries.
 * @throws Error naming the line (1-based within the fence) for a tab, an indent that is not a
 *   multiple of the first one or that skips a level, or a fence with no entry.
 */
export function parseTree(source: string): TreeEntry[] {
  const roots: TreeEntry[] = []
  const path: TreeEntry[] = []
  let unit = 0
  const lines = source.split('\n')
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === '') {
      continue
    }
    const at = `line ${index + 1} of the tree`
    if (raw.includes('\t')) {
      throw new Error(`${at} is indented with a tab: use spaces`)
    }
    const match = /^( *)(\S.*?)(?:\s+#\s?(.*))?$/.exec(raw.trimEnd())
    const indent = match?.[1]?.length ?? 0
    if (match === null) {
      throw new Error(`${at} cannot be read`)
    }
    if (indent > 0 && unit === 0) {
      unit = indent
    }
    if (indent > 0 && indent % unit !== 0) {
      throw new Error(`${at} is indented by ${indent}, not a multiple of ${unit}`)
    }
    const depth = unit === 0 ? 0 : indent / unit
    if (depth > path.length) {
      throw new Error(
        `${at} is indented ${depth - path.length + 1} levels deeper than the line above`
      )
    }
    const name = match[2] as string
    const entry: TreeEntry = {
      name: name.replace(/\/$/, ''),
      directory: name.endsWith('/'),
      children: [],
    }
    if (match[3] !== undefined && match[3] !== '') {
      entry.note = match[3]
    }
    path.length = depth
    ;(path[depth - 1]?.children ?? roots).push(entry)
    path[depth] = entry
  }
  if (roots.length === 0) {
    throw new Error('the tree has no entries')
  }
  return roots
}

function listOf(entries: TreeEntry[]): Element {
  return element(
    'ul',
    {},
    entries.map((entry) => {
      const directory = entry.directory || entry.children.length > 0
      const ellipsis = entry.name === '...' || entry.name === '…'
      const row: ElementContent[] = [
        element('span', { className: ['tree-icon'], ariaHidden: 'true' }, []),
        element('span', { className: ['tree-name'] }, [
          { type: 'text', value: directory ? `${entry.name}/` : entry.name },
        ]),
      ]
      if (entry.note !== undefined) {
        row.push(
          element('span', { className: ['tree-note'] }, [{ type: 'text', value: entry.note }])
        )
      }
      const item: ElementContent[] = [element('span', { className: ['tree-entry'] }, row)]
      if (directory && entry.children.length > 0) {
        item.push(listOf(entry.children))
      }
      return element(
        'li',
        { className: [ellipsis ? 'tree-more' : directory ? 'tree-dir' : 'tree-file'] },
        item
      )
    })
  )
}

/**
 * Draw a tree.
 *
 * @param source - The fence's content (see {@link parseTree}).
 * @returns A focusable, named region holding nested lists; the icons are drawn by the
 *   stylesheet, so the markup is only the names.
 * @throws Error from {@link parseTree}.
 */
export function renderTree(source: string): Element {
  return element(
    'div',
    { className: ['file-tree'], tabIndex: 0, role: 'region', ariaLabel: 'File tree' },
    [listOf(parseTree(source))]
  )
}
