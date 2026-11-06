import { EXCLUDED_DIRECTORIES } from './config'
import { RenderError } from './markdown'

/**
 * What a reader of the published site must never meet: the repository's own bookkeeping.
 * An ADR, a ticket, an audit finding and a link into a directory the site leaves out mean
 * nothing outside the repository, and the link would not resolve there. Nor does a note on
 * what the maintainers did or did not test: the docs say what the product does and what to
 * check before going live, in the product's voice.
 */
const DIRECTORIES = EXCLUDED_DIRECTORIES.join('|')
const INTERNAL = [
  // `\s` and not a space: a line wrap in a comment can split "ADR" from its number.
  /\bADR[\s-]?\d{4}\b/gi,
  /\bTULA-\d+\b/g,
  /\bH-\d{3}\b/g,
  // A plan's step id, as the headings of docs/plans name them ("Orgs 07", "SSO 03").
  /\b(?:Orgs|SSO)\s\d{2}\b/g,
  new RegExp(`docs/(?:${DIRECTORIES})\\b|(?:^|[/"'(])(?:${DIRECTORIES})/[\\w.-]+`, 'gm'),
  /\bnot\s+verified\s+against\b/gi,
  /\bnothing\s+in\s+this\s+repository\b/gi,
  /\bclicked\s+through\b/gi,
  /\bwritten\s+from\s+[\w' ]{1,40}\s+documentation\b/gi,
  /\b(?:was|were)\s+not\s+tried\b/gi,
  /\bnot\s+been\s+(?:observed|tried|walked|clicked)\b/gi,
  /\bnever\s+observed\s+here\b/gi,
]

/** One line of a published file that names the repository's bookkeeping. */
export interface InternalReference {
  file: string
  line: number
  text: string
}

/**
 * Find the lines of published files that name an ADR, a ticket, an audit id or an unpublished directory.
 *
 * @param files - Published files by path (rendered pages and Markdown twins alike).
 * @returns Every offending line, in file order.
 */
export function findInternalReferences(files: ReadonlyMap<string, string>): InternalReference[] {
  const found: InternalReference[] = []
  for (const [file, text] of files) {
    const lines = new Set<number>()
    for (const pattern of INTERNAL) {
      for (const match of text.matchAll(pattern)) {
        lines.add(text.slice(0, match.index).split('\n').length)
      }
    }
    const all = text.split('\n')
    for (const line of [...lines].sort((x, y) => x - y)) {
      found.push({ file, line, text: (all[line - 1] ?? '').trim().slice(0, 160) })
    }
  }
  return found
}

/**
 * Fail the build when a published file names the repository's bookkeeping.
 *
 * The site is a product's documentation: a reader has no use for an ADR, a ticket, an audit id
 * or a link into a directory the site does not publish, so none may appear, in any page, Markdown
 * twin or file for agents.
 *
 * @param files - Published files by path.
 * @throws RenderError listing every offending file and line.
 */
export function checkInternalReferences(files: ReadonlyMap<string, string>): void {
  const over = findInternalReferences(files)
  if (over.length > 0) {
    throw new RenderError(
      'internal references',
      `${over.length} line(s) of the published site name an ADR, a ticket, an audit id or an unpublished directory:\n${over
        .map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`)
        .join('\n')}`
    )
  }
}
