import type { Blockquote, Code, Heading, Parent, Root, RootContent, Table } from 'mdast'
import { visit } from 'unist-util-visit'
import { parseCodeMeta, withoutTitle } from './code-meta'

// The content components of a page, written in Markdown that GitHub renders too:
//
//   > [!NOTE]                 a callout (GitHub's own alert syntax: NOTE, TIP, IMPORTANT,
//   > text                    WARNING, CAUTION)
//
//   :::steps                  a numbered rail of steps: the headings are the steps
//   ### First
//   :::                       (GitHub shows the two fence lines as text and keeps the rest)
//
//   :::tabs{sync="framework"} tabs: the headings are the labels
//   :::code-group{sync="pm"}  tabs of fenced code blocks, labelled by title="…" or language
//   :::params                 a table of name, type, required, default, description
//
// A fence stands alone on its line with a blank line either side, so that it is a paragraph of
// its own for every Markdown parser. This module turns the fences and the alerts into plain
// mdast nodes carrying `data.hName` and `data.hProperties`, which `remark-rehype` writes as
// elements; it knows nothing of the highlighter, which runs later (`markdown.ts`).

/** A block the Markdown cannot be rendered with: the page's author is told the line. */
export class BlockError extends Error {
  /** The 1-based line of the source the problem is on. */
  readonly line: number

  constructor(line: number, message: string) {
    super(message)
    this.name = 'BlockError'
    this.line = line
  }
}

/** The containers a page may open with `:::name`. */
export const CONTAINERS = ['steps', 'tabs', 'code-group', 'params'] as const

/** The kinds of callout, by the word between `[!` and `]` (GitHub's alerts). */
export const CALLOUTS = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
} as const

/** One line of a container fence: `:::name`, `:::name{key="value"}` or the bare `:::`. */
const FENCE = /^:::(?:([A-Za-z][\w-]*)(\{[^\n]*\})?)?[ \t]*$/

/** The attribute each container accepts. */
const ATTRIBUTES: Record<string, readonly string[]> = {
  steps: [],
  tabs: ['sync'],
  'code-group': ['sync'],
  params: [],
}

/** A container fence found in a document. */
export interface Fence {
  /** `open` for `:::name`, `close` for the bare `:::`. */
  kind: 'open' | 'close'
  name?: string
  attributes: Record<string, string>
  line: number
  /** The offsets of the fence's line in the source. */
  start: number
  end: number
}

/** A node the renderer turns into an element. */
interface BlockNode {
  type: 'docsBlock'
  data: { hName: string; hProperties: Record<string, unknown> }
  children: RootContent[]
}

function block(
  tagName: string,
  properties: Record<string, unknown>,
  children: RootContent[]
): RootContent {
  const node: BlockNode = {
    type: 'docsBlock',
    data: { hName: tagName, hProperties: properties },
    children,
  }
  return node as unknown as RootContent
}

function text(value: string): RootContent {
  return { type: 'text', value }
}

/** The text of an mdast node, as a heading's label or a table cell's name. */
function textOf(node: { value?: string; children?: unknown[] }): string {
  if (typeof node.value === 'string') {
    return node.value
  }
  return (node.children ?? []).map((child) => textOf(child as { value?: string })).join('')
}

function lineOf(node: { position?: { start: { line: number } } }, fallback: number): number {
  return node.position?.start.line ?? fallback
}

/** `key="value"` pairs, each key at most once; anything else is an error. */
function parseAttributes(line: number, name: string, raw: string | undefined) {
  const attributes: Record<string, string> = {}
  if (raw === undefined) {
    return attributes
  }
  const inner = raw.slice(1, -1).trim()
  const pair = /\s*([a-z][a-z-]*)="([^"]*)"\s*/y
  let at = 0
  while (at < inner.length) {
    pair.lastIndex = at
    const match = pair.exec(inner)
    if (match === null) {
      throw new BlockError(
        line,
        `the attributes {${inner}} of :::${name} are not key="value" pairs`
      )
    }
    const key = match[1] as string
    const accepted = ATTRIBUTES[name] ?? []
    if (!accepted.includes(key)) {
      throw new BlockError(
        line,
        `:::${name} has no attribute "${key}"${accepted.length === 0 ? ' (it takes none)' : ` (it takes ${accepted.join(', ')})`}`
      )
    }
    if (key in attributes) {
      throw new BlockError(line, `:::${name} sets "${key}" twice`)
    }
    attributes[key] = match[2] as string
    at = pair.lastIndex
  }
  if (attributes.sync !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(attributes.sync)) {
    throw new BlockError(
      line,
      `sync="${attributes.sync}" must be lower-case letters, digits and hyphens, starting with a letter`
    )
  }
  return attributes
}

/**
 * Read a node as a container fence.
 *
 * @param source - The document's text.
 * @param node - A child of a block container.
 * @returns The fence, or `null` for a node that is not one.
 * @throws BlockError for a paragraph with a `:::` line that is not alone, or is malformed.
 */
export function fenceOf(source: string, node: RootContent): Fence | null {
  if (node.type !== 'paragraph' || node.position?.start.offset === undefined) {
    return null
  }
  const start = node.position.start.offset
  const end = node.position.end.offset as number
  const lines = source.slice(start, end).split('\n')
  if (!lines.some((one) => one.trimStart().startsWith(':::'))) {
    return null
  }
  const line = node.position.start.line
  const first = (lines[0] as string).trim()
  if (lines.length > 1) {
    throw new BlockError(
      line,
      'a ::: line must stand alone, with a blank line before and after it (here it shares a paragraph with other text)'
    )
  }
  const match = FENCE.exec(first)
  if (match === null) {
    throw new BlockError(
      line,
      `"${first}" is not a block fence: write :::name, :::name{key="value"} or a bare :::`
    )
  }
  const name = match[1]
  if (name === undefined) {
    return { kind: 'close', attributes: {}, line, start, end }
  }
  if (!(CONTAINERS as readonly string[]).includes(name)) {
    throw new BlockError(
      line,
      `unknown block :::${name} (the blocks are ${CONTAINERS.map((one) => `:::${one}`).join(', ')})`
    )
  }
  return { kind: 'open', name, attributes: parseAttributes(line, name, match[2]), line, start, end }
}

interface Open {
  fence: Fence
  children: RootContent[]
}

/** Heading-delimited sections of a container: the steps of `:::steps`, the tabs of `:::tabs`. */
interface Section {
  heading: Heading
  label: string
  line: number
  body: RootContent[]
}

function sectionsOf(open: Open, what: string): Section[] {
  const sections: Section[] = []
  let depth = 0
  for (const child of open.children) {
    if (child.type === 'heading') {
      if (depth === 0) {
        depth = child.depth
      } else if (child.depth !== depth) {
        throw new BlockError(
          lineOf(child, open.fence.line),
          `a heading of depth ${child.depth} inside :::${open.fence.name}, whose ${what} are depth ${depth}`
        )
      }
      sections.push({
        heading: child,
        label: textOf(child).trim(),
        line: lineOf(child, open.fence.line),
        body: [],
      })
    } else if (sections.length === 0) {
      throw new BlockError(
        lineOf(child, open.fence.line),
        `:::${open.fence.name} must start with a heading, the ${what === 'steps' ? 'title of its first step' : 'label of its first tab'}`
      )
    } else {
      sections[sections.length - 1]?.body.push(child)
    }
  }
  if (sections.length === 0) {
    throw new BlockError(open.fence.line, `:::${open.fence.name} is empty`)
  }
  return sections
}

function steps(open: Open): RootContent {
  const items = sectionsOf(open, 'steps')
  return block(
    'ol',
    { className: ['steps'] },
    items.map((item) => block('li', { className: ['step'] }, [item.heading, ...item.body]))
  )
}

/** The tabs of a group: a panel each, headed by its label (what a reader without script sees). */
function panels(
  open: Open,
  entries: { label: string; line: number; body: RootContent[] }[],
  kind: 'tabs' | 'code'
): RootContent {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.label === '') {
      throw new BlockError(entry.line, `a tab of :::${open.fence.name} has no label`)
    }
    if (seen.has(entry.label)) {
      throw new BlockError(
        entry.line,
        `:::${open.fence.name} has two tabs labelled "${entry.label}"`
      )
    }
    seen.add(entry.label)
  }
  const properties: Record<string, unknown> = {
    className: ['docs-tabs'],
    dataDocsTabs: '',
    dataKind: kind,
  }
  if (open.fence.attributes.sync !== undefined) {
    properties.dataSync = open.fence.attributes.sync
  }
  return block(
    'div',
    properties,
    entries.map((entry) =>
      block('div', { className: ['docs-tab-panel'], dataLabel: entry.label }, [
        block('p', { className: ['docs-tab-label'] }, [text(entry.label)]),
        ...entry.body,
      ])
    )
  )
}

function tabs(open: Open): RootContent {
  const sections = sectionsOf(open, 'tabs')
  for (const section of sections) {
    if (section.body.length === 0) {
      throw new BlockError(section.line, `the tab "${section.label}" has no content`)
    }
  }
  return panels(open, sections, 'tabs')
}

function codeGroup(open: Open): RootContent {
  if (open.children.length === 0) {
    throw new BlockError(open.fence.line, ':::code-group is empty')
  }
  const entries = open.children.map((child) => {
    const line = lineOf(child, open.fence.line)
    if (child.type !== 'code') {
      throw new BlockError(
        line,
        `:::code-group holds fenced code blocks only (found a ${child.type})`
      )
    }
    let title: string | undefined
    try {
      title = parseCodeMeta(child.meta).title
    } catch (error) {
      throw new BlockError(line, (error as Error).message)
    }
    const label = title ?? child.lang ?? ''
    if (label === '') {
      throw new BlockError(
        line,
        'a block of :::code-group needs a title="…" or a language to name its tab'
      )
    }
    // The tab carries the title; the block under it does not repeat it.
    const code: Code = { ...child, meta: withoutTitle(child.meta) }
    return { label, line, body: [code as RootContent] }
  })
  return panels(open, entries, 'code')
}

const REQUIRED = new Set(['yes', 'true', 'required', 'y', '✓', '✔'])
const OPTIONAL = new Set(['no', 'false', 'optional', 'n', '-', '–', '—', ''])
const PARAM_COLUMNS = ['name', 'type', 'required', 'default', 'description']

function params(open: Open): RootContent {
  const table = open.children[0]
  if (open.children.length !== 1 || table?.type !== 'table') {
    throw new BlockError(
      open.fence.line,
      ':::params holds one table, with columns Name, Type, Required, Default and Description'
    )
  }
  const [head, ...rows] = (table as Table).children
  const columns = (head?.children ?? []).map((cell) => textOf(cell).trim().toLowerCase())
  for (const column of columns) {
    if (!PARAM_COLUMNS.includes(column)) {
      throw new BlockError(
        lineOf(table, open.fence.line),
        `the column "${column}" of :::params is not one of ${PARAM_COLUMNS.join(', ')}`
      )
    }
  }
  for (const needed of ['name', 'description']) {
    if (!columns.includes(needed)) {
      throw new BlockError(
        lineOf(table, open.fence.line),
        `the table of :::params has no ${needed} column`
      )
    }
  }
  const items = rows.map((row) => {
    const line = lineOf(row, open.fence.line)
    const cell = (column: string) => row.children[columns.indexOf(column)]
    const head: RootContent[] = [
      block('span', { className: ['param-name'] }, (cell('name')?.children ?? []) as RootContent[]),
    ]
    const type = cell('type')
    if (type !== undefined && textOf(type).trim() !== '') {
      head.push(block('span', { className: ['param-type'] }, type.children as RootContent[]))
    }
    const required = cell('required')
    if (required !== undefined) {
      const value = textOf(required).trim().toLowerCase()
      if (REQUIRED.has(value)) {
        head.push(block('span', { className: ['param-required'] }, [text('required')]))
      } else if (!OPTIONAL.has(value)) {
        throw new BlockError(line, `"${value}" in the Required column is not yes or no`)
      }
    }
    const fallback = cell('default')
    if (fallback !== undefined && textOf(fallback).trim() !== '') {
      head.push(
        block('span', { className: ['param-default'] }, [
          text('Default '),
          ...(fallback.children as RootContent[]),
        ])
      )
    }
    return block('div', { className: ['param'] }, [
      block('dt', {}, head),
      block('dd', {}, (cell('description')?.children ?? []) as RootContent[]),
    ])
  })
  return block('dl', { className: ['params'] }, items)
}

function build(open: Open): RootContent {
  switch (open.fence.name) {
    case 'steps':
      return steps(open)
    case 'tabs':
      return tabs(open)
    case 'code-group':
      return codeGroup(open)
    default:
      return params(open)
  }
}

/** Replace the fences among a parent's children with the containers they delimit, depth first. */
function group(source: string, parent: Parent): void {
  const done: RootContent[] = []
  const stack: Open[] = []
  const into = (node: RootContent) => (stack.at(-1)?.children ?? done).push(node)
  for (const child of parent.children as RootContent[]) {
    const fence = fenceOf(source, child)
    if (fence === null) {
      if ('children' in child) {
        group(source, child as Parent)
      }
      into(child)
    } else if (fence.kind === 'open') {
      stack.push({ fence, children: [] })
    } else {
      const open = stack.pop()
      if (open === undefined) {
        throw new BlockError(fence.line, 'a closing ::: with no block open')
      }
      into(build(open))
    }
  }
  const unclosed = stack.at(-1)
  if (unclosed !== undefined) {
    throw new BlockError(
      unclosed.fence.line,
      `:::${unclosed.fence.name} is never closed with a bare :::`
    )
  }
  parent.children = done as never
}

/** The callout a blockquote is, when it starts with `[!KIND]`. */
function calloutOf(source: string, quote: Blockquote): RootContent | null {
  const first = quote.children[0]
  if (first?.type !== 'paragraph' || first.position?.start.offset === undefined) {
    return null
  }
  const head = /^\[!([A-Za-z]+)\]([ \t]*)(?=\n|$)/.exec(source.slice(first.position.start.offset))
  const loose = /^\[!([A-Za-z]+)\]/.exec(source.slice(first.position.start.offset))
  if (head === null) {
    if (loose !== null) {
      throw new BlockError(
        lineOf(quote, 1),
        `put the text of the [!${loose[1]}] callout on the next line: GitHub only reads the marker alone on its line`
      )
    }
    return null
  }
  const kind = (head[1] as string).toUpperCase() as keyof typeof CALLOUTS
  const line = lineOf(quote, 1)
  if (!(kind in CALLOUTS)) {
    throw new BlockError(
      line,
      `unknown callout [!${head[1]}] (the kinds are ${Object.keys(CALLOUTS)
        .map((one) => `[!${one}]`)
        .join(', ')})`
    )
  }
  // The marker is the start of the paragraph's first text: take it, and the line break after it.
  const [lead, ...rest] = first.children
  if (lead?.type !== 'text') {
    return null
  }
  const body = lead.value.replace(/^\[![A-Za-z]+\][ \t]*\n?/, '')
  let inline = rest
  if (body !== '') {
    inline = [{ ...lead, value: body }, ...rest]
  } else if (inline[0]?.type === 'break') {
    inline = inline.slice(1)
  }
  const content: RootContent[] = []
  if (inline.length > 0) {
    content.push({ ...first, children: inline })
  }
  content.push(...quote.children.slice(1))
  if (content.length === 0) {
    throw new BlockError(line, `the [!${kind}] callout has no text`)
  }
  return block('div', { className: ['callout'], dataCallout: kind.toLowerCase(), role: 'note' }, [
    block('p', { className: ['callout-title'] }, [text(CALLOUTS[kind])]),
    ...content,
  ])
}

function callouts(source: string, parent: Parent): void {
  parent.children = (parent.children as RootContent[]).map((child) => {
    if (child.type === 'blockquote') {
      const callout = calloutOf(source, child)
      if (callout !== null) {
        callouts(source, callout as unknown as Parent)
        return callout
      }
    }
    if ('children' in child) {
      callouts(source, child as Parent)
    }
    return child
  }) as never
}

/**
 * Turn a document's callouts and block containers into elements.
 *
 * @param source - The document's text (the positions of the nodes are offsets into it).
 * @param tree - Its mdast tree, changed in place.
 * @throws BlockError, with the line, for an unknown or unclosed block, a malformed fence or
 *   attribute, a block of the wrong content or an unknown callout.
 */
export function transformBlocks(source: string, tree: Root): void {
  callouts(source, tree)
  group(source, tree)
  // The renderer reads a code block's info string and line from the element, which is all
  // that is left of the node by then.
  visit(tree, 'code', (node) => {
    Object.assign(node, {
      data: {
        hProperties: { dataMeta: node.meta ?? '', dataLine: node.position?.start.line ?? 0 },
      },
    })
  })
}

/** One change to a document's text: the characters from `start` to `end` become `text`. */
export interface TextEdit {
  start: number
  end: number
  text: string
}

/**
 * The edits that turn a page's Markdown into its twin for an agent: the fence lines go, and
 * each block of a code group gets its tab's label above it, so that tabs read as sequential
 * labelled sections. Callouts, headings and tables are left as written.
 *
 * @param source - The document's text.
 * @param tree - Its mdast tree before {@link transformBlocks}.
 * @returns The edits, in any order.
 * @throws BlockError when the fences are malformed (the site's build has already refused it).
 */
export function twinEdits(source: string, tree: Root): TextEdit[] {
  const edits: TextEdit[] = []
  const walk = (parent: Parent): void => {
    const names: string[] = []
    for (const child of parent.children as RootContent[]) {
      const fence = fenceOf(source, child)
      if (fence === null) {
        if (
          child.type === 'code' &&
          names.at(-1) === 'code-group' &&
          child.position !== undefined
        ) {
          let label: string | undefined
          try {
            label = parseCodeMeta(child.meta).title ?? child.lang ?? undefined
          } catch {
            label = child.lang ?? undefined
          }
          if (label !== undefined) {
            edits.push({
              start: child.position.start.offset as number,
              end: child.position.start.offset as number,
              text: `**${label}**\n\n`,
            })
          }
        } else if ('children' in child) {
          walk(child as Parent)
        }
        continue
      }
      if (fence.kind === 'open') {
        names.push(fence.name as string)
      } else {
        names.pop()
      }
      edits.push({ start: fence.start, end: fence.end, text: '' })
    }
  }
  walk(tree)
  return edits
}
