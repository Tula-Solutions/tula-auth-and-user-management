import { RenderError } from './markdown'

/**
 * What a reader of the published site must never meet: the repository's own bookkeeping.
 * An ADR, a ticket, an audit finding and a link into a directory the site leaves out mean
 * nothing outside the repository, and the link would not resolve there.
 */
const INTERNAL = [
  /\bADR[ -]?\d{4}\b/i,
  /\bTULA-\d+\b/,
  /\bH-\d{3}\b/,
  /docs\/(?:adr|plans|codebase-map|internal)\b|(?:^|[/"'(])(?:adr|plans|codebase-map|internal)\/[\w.-]+/,
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
    text.split('\n').forEach((line, index) => {
      if (INTERNAL.some((pattern) => pattern.test(line))) {
        found.push({ file, line: index + 1, text: line.trim().slice(0, 160) })
      }
    })
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
