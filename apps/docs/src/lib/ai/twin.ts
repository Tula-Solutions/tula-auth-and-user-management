import type { Link, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { BlockError, twinEdits } from '../blocks'
import type { ErrorCodeEntry } from '../error-codes'
import { isExternal, type LinkEnvironment, resolveLink } from '../links'
import { RenderError } from '../markdown'
import { fileUrl, pageUrl, twinUrl, type Urls } from './urls'

const parser = unified().use(remarkParse).use(remarkGfm)

/** What a page's Markdown twin is made of. */
export interface TwinInput {
  /** The Markdown file, from the repository root: the base of its relative links. */
  file: string
  /** The page's route. */
  route: string
  title: string
  description: string
  /** The sidebar group the page is in, when it is in one. */
  section?: string
  /** The date the file last changed (`YYYY-MM-DD`), when the build knows it. */
  updated?: string
  /** The file's text. */
  source: string
  /** Where the page's links go. */
  environment: LinkEnvironment
  urls: Urls
  /** The address of the file on GitHub, when the page has one. */
  repositoryUrl?: string
}

/** One change to the source text: the characters from `start` to `end` become `text`. */
interface Edit {
  start: number
  end: number
  text: string
}

/**
 * The front matter of a twin: a YAML block, every value a JSON string (which YAML reads).
 *
 * @param fields - Name and value; a value that is undefined or empty leaves the line out.
 * @returns The block, with its `---` lines and a trailing newline.
 */
export function frontMatter(fields: Readonly<Record<string, string | undefined>>): string {
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

/** Where `needle` is in `slice` from `from` on, or an error that names the file. */
function locate(file: string, slice: string, needle: string, from: number): number {
  const at = slice.indexOf(needle, from)
  if (at === -1) {
    throw new RenderError(file, `the address "${needle}" cannot be found in its link's text`)
  }
  return at
}

/**
 * The address a relative link takes in a twin: a page's Markdown twin, a repository file on
 * GitHub, an image under `files/`; an address outside the repository is left as written.
 */
function twinAddress(input: TwinInput, target: string): string {
  if (target.startsWith('#')) {
    return twinUrl(input.urls, input.route, target.slice(1))
  }
  const resolved = resolveLink(input.file, target, input.environment)
  if (resolved.kind === 'external') {
    return target
  }
  if (resolved.kind === 'asset') {
    return fileUrl(input.urls, `files/${resolved.file}`)
  }
  if (resolved.kind === 'repository') {
    return resolved.href
  }
  // A page: the route is the href without the base, and the anchor stays.
  const base = input.environment.base.replace(/\/$/, '')
  const [path = '', fragment = ''] = resolved.href.slice(base.length).split('#')
  return twinUrl(input.urls, path, fragment)
}

/**
 * The body of a page for an agent: the source Markdown with every relative link made absolute
 * and the HTML-only parts taken out.
 *
 * Links to another page become the address of its Markdown twin, links to repository files
 * their address on GitHub, images their copy under `files/`. The fences of the content
 * components (`:::steps`, `:::tabs`, …) are taken out, and each block of a code group is
 * labelled with its tab; a callout stays `> [!NOTE]`. A `<!-- snippet -->` marker is a
 * comment and goes; the code block between two of them is the snippet already copied in by
 * `docs:generate`, and stays. Any other raw HTML is dropped.
 *
 * @param input - The page.
 * @returns The Markdown.
 * @throws LinkError for a link that does not resolve; RenderError for one it cannot rewrite.
 */
export function twinBody(input: TwinInput): string {
  const tree = parser.parse(input.source) as Root
  const edits: Edit[] = []
  visit(tree, (node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) {
      return
    }
    if (node.type === 'html') {
      // A line break must not join the words around it; any other tag or comment goes.
      edits.push({ start, end, text: /^<br\s*\/?>$/i.test(node.value) ? ' ' : '' })
      return
    }
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') {
      return
    }
    const target = (node as Link).url
    if (target === '' || isExternal(target)) {
      return
    }
    // The address comes after the label (or the `]:` of a definition), so a title that repeats
    // it is not the one rewritten.
    const labelEnd = (node as Link).children?.at(-1)?.position?.end.offset
    const from =
      node.type === 'definition'
        ? input.source.indexOf(']:', start) - start
        : (labelEnd ?? start + 1) - start
    const at = locate(input.file, input.source.slice(start, end), target, Math.max(from, 0))
    edits.push({
      start: start + at,
      end: start + at + target.length,
      text: twinAddress(input, target),
    })
  })
  // The `:::` fences go and a code group's blocks are labelled, so that tabs read as
  // sequential labelled sections; callouts and everything else stay as the author wrote them.
  try {
    edits.push(...twinEdits(input.source, tree))
  } catch (error) {
    if (error instanceof BlockError) {
      throw new RenderError(input.file, `line ${error.line}: ${error.message}`)
    }
    throw error
  }
  let body = input.source
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end)
  }
  return `${body.replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/**
 * A page's Markdown twin: front matter, a pointer to the index, and {@link twinBody}.
 *
 * @param input - The page.
 * @returns The file's text.
 */
export function renderTwin(input: TwinInput): string {
  const head = frontMatter({
    title: input.title,
    description: input.description,
    url: pageUrl(input.urls, input.route),
    source: input.repositoryUrl,
    section: input.section,
    updated: input.updated,
  })
  return `${head}\n> For an index of all documentation, see [llms.txt](${fileUrl(input.urls, 'llms.txt')}).\n\n${twinBody(input)}`
}

/**
 * The Markdown of the generated error-code page, from the contract's codes.
 *
 * @param entries - Every code, as `errorCodeEntries` lists them.
 * @returns Markdown with one heading per code.
 */
export function errorCodesMarkdown(entries: readonly ErrorCodeEntry[]): string {
  const areas = new Map<string, ErrorCodeEntry[]>()
  for (const entry of entries) {
    areas.set(entry.area, [...(areas.get(entry.area) ?? []), entry])
  }
  const parts = [
    '# Error codes',
    'Every error code the API returns, with its HTTP status and default message. The code, not the message, is the contract: an SDK switches on `code` and may word the message itself. Codes are only ever added.',
  ]
  for (const [area, codes] of areas) {
    parts.push(`## ${area}`)
    for (const { code, status, message } of codes) {
      parts.push(`### \`${code}\``, `HTTP ${status}. ${message}`)
    }
  }
  return `${parts.join('\n\n')}\n`
}
