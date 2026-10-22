import GithubSlugger from 'github-slugger'
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { toString as hastText } from 'hast-util-to-string'
import rehypeRaw from 'rehype-raw'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import type { BundledLanguage, HighlighterGeneric } from 'shiki'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { isExternal, type LinkEnvironment, resolveLink } from './links'

/** A heading of a page: what the table of contents and the anchors are made from. */
export interface Heading {
  depth: number
  text: string
  id: string
}

/** A part of a page, from one heading to the next: the unit of the search index. */
export interface Section {
  /** The heading's id, or `null` for the text before the first heading. */
  id: string | null
  title: string
  /** The prose of the section without code blocks, whitespace collapsed. */
  text: string
}

/** A Markdown file, parsed: its tree with every heading given its id. */
export interface ParsedDoc {
  file: string
  title: string
  tree: Root
  headings: Heading[]
  /** Everything a link may point at: heading ids, `id` attributes and `<a name>`. */
  ids: ReadonlySet<string>
  sections: Section[]
}

/** A page's body, rendered. */
export interface RenderedDoc {
  html: string
  /** Files (from the repository root) the page shows and the site must copy. */
  assets: string[]
  /**
   * Every repository file or directory the page links to or shows, as the resolver read it
   * (reference definitions and either kind of quote in raw HTML included), with repeats and
   * none for an external link or an anchor in the page itself. A page reads them to check
   * that a link resolves, so a guard that must know what a page reads takes them from here
   * and cannot disagree with the build.
   */
  files: string[]
}

/** A Markdown file the site cannot render: the build stops on it. */
export class RenderError extends Error {
  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`)
    this.name = 'RenderError'
  }
}

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)

/** The text of a node without its code blocks: what a reader searches for. */
function proseOf(node: Root | RootContent | ElementContent): string {
  if (node.type === 'text') {
    return node.value
  }
  if (node.type === 'element') {
    if (node.tagName === 'pre') {
      return ''
    }
    return `${node.children.map((child) => proseOf(child)).join('')}${BLOCKS.has(node.tagName) ? ' ' : ''}`
  }
  if (node.type === 'root') {
    return node.children.map((child) => proseOf(child)).join('')
  }
  return ''
}

const BLOCKS = new Set(['p', 'li', 'td', 'th', 'tr', 'br', 'div', 'blockquote'])
const HEADING = /^h[1-6]$/

/**
 * Parse a Markdown file into a tree with an id on every heading.
 *
 * The ids are GitHub's (`github-slugger`, with `-1`, `-2` for repeats), because the docs link to
 * `file.md#heading` as GitHub renders it. Comments (`<!-- snippet … -->`) are dropped; the code
 * block between a pair of snippet markers is an ordinary fenced block and stays.
 *
 * @param file - The file, from the repository root (for messages).
 * @param source - Its text.
 * @returns The parsed document.
 * @throws RenderError when the Markdown cannot be parsed or has no top-level heading.
 */
export function parseMarkdown(file: string, source: string): ParsedDoc {
  const { tree, headings, ids } = analyze(file, source)
  const first = headings.find((heading) => heading.depth === 1)
  if (first === undefined) {
    throw new RenderError(file, 'has no top-level (#) heading to use as the page title')
  }
  return { file, title: first.text, tree, headings, ids, sections: sectionsOf(tree, first.text) }
}

/**
 * The anchors a Markdown file offers, for a link into a file the site does not render.
 *
 * @param file - The file, from the repository root (for messages).
 * @param source - Its text.
 * @returns Heading ids and explicit anchors.
 */
export function markdownAnchors(file: string, source: string): ReadonlySet<string> {
  return analyze(file, source).ids
}

/**
 * The title of a Markdown file, without parsing the rest of it.
 *
 * The sidebar needs a page's title and nothing else; parsing a 500 KB reference page for one
 * line costs hundreds of milliseconds. The text before the first `##` is parsed as the page
 * would be, so the title is the same one {@link parseMarkdown} finds; a file whose `#` heading
 * comes after a `##` is parsed whole.
 *
 * @param file - The file, from the repository root (for messages).
 * @param source - Its text.
 * @returns The text of the first `#` heading.
 * @throws RenderError when the Markdown cannot be parsed or has no top-level heading.
 */
export function titleOf(file: string, source: string): string {
  const cut = source.search(/^##/m)
  if (cut > 0) {
    const first = analyze(file, source.slice(0, cut)).headings.find((one) => one.depth === 1)
    if (first !== undefined) {
      return first.text
    }
  }
  return parseMarkdown(file, source).title
}

function analyze(
  file: string,
  source: string
): { tree: Root; headings: Heading[]; ids: Set<string> } {
  let tree: Root
  try {
    tree = parser.runSync(parser.parse(source)) as Root
  } catch (error) {
    throw new RenderError(file, `cannot be parsed: ${(error as Error).message}`)
  }
  const slugger = new GithubSlugger()
  const ids = new Set<string>()
  const headings: Heading[] = []
  const comments: { parent: Root | Element; index: number }[] = []
  visit(tree, (node, index, parent) => {
    if (node.type === 'comment' && parent && index !== undefined) {
      comments.push({ parent: parent as Root | Element, index })
    }
    if (node.type !== 'element') {
      return
    }
    const element = node as Element
    const existing = element.properties?.id
    if (HEADING.test(element.tagName)) {
      const text = hastText(element).trim()
      const id = typeof existing === 'string' && existing !== '' ? existing : slugger.slug(text)
      element.properties = { ...element.properties, id }
      headings.push({ depth: Number(element.tagName.slice(1)), text, id })
      ids.add(id)
    } else if (typeof existing === 'string' && existing !== '') {
      ids.add(existing)
    }
    const name = element.tagName === 'a' ? element.properties?.name : undefined
    if (typeof name === 'string' && name !== '') {
      ids.add(name)
    }
  })
  for (const { parent, index } of comments.reverse()) {
    parent.children.splice(index, 1)
  }
  return { tree, headings, ids }
}

/** Split a tree into the parts the search finds: one per heading down to `###`. */
function sectionsOf(tree: Root, title: string): Section[] {
  const sections: Section[] = [{ id: null, title, text: '' }]
  for (const node of tree.children) {
    if (node.type === 'element' && HEADING.test(node.tagName)) {
      const depth = Number(node.tagName.slice(1))
      if (depth >= 2 && depth <= 3) {
        sections.push({ id: String(node.properties?.id), title: hastText(node).trim(), text: '' })
      }
      continue
    }
    const current = sections[sections.length - 1] as Section
    current.text += proseOf(node)
  }
  return sections
    .map((section) => ({ ...section, text: section.text.replace(/\s+/g, ' ').trim() }))
    .filter((section) => section.id !== null || section.text !== '')
}

/** The languages a code block may name; anything else fails the build rather than going plain. */
export const CODE_LANGUAGES = [
  'ts',
  'tsx',
  'bash',
  'sh',
  'shell',
  'json',
  'swift',
  'kotlin',
  'xml',
  'sql',
  'yaml',
  'nginx',
  'html',
  'css',
  'diff',
  'toml',
  'dockerfile',
  'http',
] as const

/** The two themes a code block carries; CSS picks one by the page's theme. */
export const CODE_THEMES = {
  light: 'github-light-high-contrast',
  dark: 'github-dark-high-contrast',
}

/** A shiki highlighter loaded with {@link CODE_LANGUAGES} and {@link CODE_THEMES}. */
export type Highlighter = HighlighterGeneric<BundledLanguage, string>

/**
 * Create the highlighter used for every page of a build.
 *
 * @returns A highlighter that runs at build time; no highlighter ships to the browser.
 */
export async function createCodeHighlighter(): Promise<Highlighter> {
  const { createHighlighter } = await import('shiki')
  return (await createHighlighter({
    themes: Object.values(CODE_THEMES),
    langs: [...CODE_LANGUAGES],
  })) as Highlighter
}

function languageOf(code: Element): string {
  const classes = code.properties?.className
  const found = Array.isArray(classes)
    ? classes.find((name) => String(name).startsWith('language-'))
    : undefined
  return found === undefined ? 'text' : String(found).slice('language-'.length)
}

function element(
  tagName: string,
  properties: Element['properties'],
  children: ElementContent[]
): Element {
  return { type: 'element', tagName, properties, children }
}

/**
 * Render a parsed document to the HTML of a page body.
 *
 * Code blocks are highlighted, tables get a scrollable wrapper, headings a permalink, and every
 * relative link and image is resolved: a link that cannot be, fails the build.
 *
 * @param doc - A document from {@link parseMarkdown}; its tree is copied, not consumed.
 * @param environment - What links may point at.
 * @param highlighter - From {@link createCodeHighlighter}.
 * @returns The HTML, the files the page shows and the files it links to.
 * @throws RenderError for an unknown code language; LinkError for a link that does not resolve.
 */
export function renderMarkdown(
  doc: ParsedDoc,
  environment: LinkEnvironment,
  highlighter: Highlighter
): RenderedDoc {
  const tree = structuredClone(doc.tree)
  const assets: string[] = []
  const files: string[] = []
  let tables = 0
  let lastDepth = 0

  visit(tree, 'element', (node, index, parent) => {
    if (parent === undefined || index === undefined) {
      return
    }
    if (HEADING.test(node.tagName)) {
      // A heading may not skip a level (`##` then `####`), or a screen reader's outline has a
      // hole; the page keeps the document's text and anchors and only lowers the level.
      lastDepth = Math.min(Number(node.tagName.slice(1)), lastDepth + 1)
      node.tagName = `h${lastDepth}`
    }
    if (node.tagName === 'pre') {
      const code = node.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'code'
      )
      if (code === undefined) {
        return
      }
      const language = languageOf(code)
      if (language !== 'text' && !(CODE_LANGUAGES as readonly string[]).includes(language)) {
        throw new RenderError(doc.file, `has a code block in an unknown language "${language}"`)
      }
      const highlighted = highlighter.codeToHast(hastText(code).replace(/\n$/, ''), {
        lang: language,
        themes: CODE_THEMES,
        defaultColor: false,
      })
      const pre = highlighted.children[0] as Element
      pre.properties = { ...pre.properties, 'data-language': language }
      ;(parent as Element).children[index] = pre
      return 'skip'
    }
    if (node.tagName === 'table') {
      tables += 1
      nameHeaderCells(node)
      // A table wider than the screen scrolls inside its own box, which must be reachable
      // by keyboard and have a name of its own.
      ;(parent as Element).children[index] = element(
        'div',
        { className: ['table-wrap'], tabIndex: 0, role: 'region', ariaLabel: `Table ${tables}` },
        [node]
      )
      return
    }
    rewriteLink(node, doc, environment, assets, files)
    return
  })

  // A permalink after each heading, so that a reader can copy the address of a section.
  visit(tree, 'element', (node) => {
    if (
      HEADING.test(node.tagName) &&
      node.tagName !== 'h1' &&
      typeof node.properties?.id === 'string'
    ) {
      node.children.push(
        element(
          'a',
          {
            className: ['permalink'],
            href: `#${node.properties.id}`,
            ariaLabel: `Link to “${hastText(node).trim()}”`,
          },
          [{ type: 'text', value: '#' }]
        )
      )
    }
  })

  wrapSections(tree)
  const html = unified().use(rehypeStringify).stringify(tree)
  return { html, assets, files }
}

/**
 * Give every column header a name. The docs' two-column tables of links have an empty header
 * row (`| | |`), which a screen reader announces as nothing: a table whose headers are all
 * empty loses the row, and one with some empty gets a hidden "Column N" in each.
 */
function nameHeaderCells(table: Element): void {
  const head = table.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'thead'
  )
  const row = head?.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'tr'
  )
  if (head === undefined || row === undefined) {
    return
  }
  const cells = row.children.filter(
    (child): child is Element => child.type === 'element' && child.tagName === 'th'
  )
  const empty = cells.filter((cell) => hastText(cell).trim() === '')
  if (empty.length === cells.length) {
    table.children = table.children.filter((child) => child !== head)
    return
  }
  for (const cell of empty) {
    cell.children = [
      element('span', { className: ['sr-only'] }, [
        { type: 'text', value: `Column ${cells.indexOf(cell) + 1}` },
      ]),
    ]
  }
}

/** The attribute that marks a section of a page's content (`wrapSections`). */
export const SECTION_ATTRIBUTE = 'data-docs-section'

/**
 * The size, in characters of HTML, past which `wrapSections` closes a section at the next block.
 * Below the browser tests' piece size (`CHUNK_BUDGET` in `e2e/chunks.ts`, which a test holds
 * above it), so that a section is never a piece too big for axe unless one block is.
 */
export const SECTION_CAP = 60_000

/**
 * Wrap the content of a page in sections: a `div` for what comes before the first `h2` (the
 * title and the introduction, number 0) and one for each `h2` or `h3` and what follows it.
 * The generated reference pages put most of their content under a handful of `h2`, so the
 * unit is the `h3` too, and a section that grows past {@link SECTION_CAP} is closed at the next
 * block (a paragraph, a list, a table, a code block, a deeper heading) and goes on in a new one;
 * the tests group the small ones back into chunks of a size axe can do in well under a minute.
 *
 * The browser tests run the accessibility checker on one section at a time, so that the
 * megabyte-sized reference pages are checked in pieces, none of it skipped: every child of the
 * root is inside exactly one section. A `div` and not a `section`, so that no landmark or
 * region is added to the outline, and nothing else about the content changes.
 *
 * @param root - The rendered tree, changed in place.
 */
export function wrapSections(root: Root): void {
  const sections: Element[] = []
  let size = 0
  for (const child of root.children) {
    const heading = child.type === 'element' && (child.tagName === 'h2' || child.tagName === 'h3')
    const blockSize = unified()
      .use(rehypeStringify)
      .stringify({ type: 'root', children: [child] } as Root).length
    // A heading starts a section; so does a block that would take the current one past the cap
    // (the section is closed at the block boundary, so one block is never cut). A block bigger
    // than the cap ends up alone in its section.
    if (sections.length === 0 || heading || (size > 0 && size + blockSize > SECTION_CAP)) {
      sections.push(element('div', { [SECTION_ATTRIBUTE]: String(sections.length) }, []))
      size = 0
    }
    ;(sections[sections.length - 1] as Element).children.push(child as ElementContent)
    size += blockSize
  }
  root.children = sections
}

/**
 * Resolve the address of a link or an image element in place. The one place that reads an
 * element's address, once, for the page and for the list of files it links to.
 */
function rewriteLink(
  node: Element,
  doc: ParsedDoc,
  environment: LinkEnvironment,
  assets: string[],
  files: string[]
): void {
  if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
    node.properties.href = rewrite(doc, node.properties.href, environment, false, assets, files)
    if (isExternal(String(node.properties.href))) {
      node.properties.rel = ['noopener']
    }
  }
  if (node.tagName === 'img' && typeof node.properties?.src === 'string') {
    node.properties.src = rewrite(doc, node.properties.src, environment, true, assets, files)
  }
}

/** The schemes a link may leave the site by. */
const EXTERNAL_SCHEMES = /^(https?|mailto):/i

/** The rewritten address of a link or an image of a document. */
function rewrite(
  doc: ParsedDoc,
  target: string,
  environment: LinkEnvironment,
  image: boolean,
  assets: string[],
  files: string[]
): string {
  if (target.startsWith('#')) {
    let fragment: string
    try {
      fragment = decodeURIComponent(target.slice(1))
    } catch {
      throw new RenderError(doc.file, `link "${target}" is not a valid anchor`)
    }
    if (fragment !== '' && fragment !== 'top' && !doc.ids.has(fragment)) {
      throw new RenderError(doc.file, `link "${target}" points at an anchor the page does not have`)
    }
    return target
  }
  const resolved = resolveLink(doc.file, target, environment)
  // The Markdown is ours, but a link is still a way to run script on a reader's page: only
  // addresses a reader may follow are allowed out of the site.
  if (resolved.kind === 'external' && !EXTERNAL_SCHEMES.test(target)) {
    throw new RenderError(doc.file, `link "${target}" has a scheme the site does not link to`)
  }
  if (resolved.kind !== 'external') {
    files.push(resolved.file)
  }
  if (resolved.kind === 'asset') {
    assets.push(resolved.file)
    return `${environment.base}files/${resolved.file}`
  }
  if (image && resolved.kind !== 'external') {
    throw new RenderError(doc.file, `image "${target}" is not an image file of the repository`)
  }
  return resolved.href
}
