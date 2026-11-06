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
 * Fail the build when a published file names the repository's bookkeeping more often than its baseline allows.
 *
 * The baseline is the worklist of the content cleanup: a file may keep the lines it has today and
 * never gain one. Pass an empty baseline for the strict check.
 *
 * @param files - Published files by path.
 * @param baseline - How many offending lines each file may still have.
 * @throws RenderError listing every offending file and line of a file over its baseline.
 */
export function checkInternalReferences(
  files: ReadonlyMap<string, string>,
  baseline: Readonly<Record<string, number>> = {}
): void {
  const found = findInternalReferences(files)
  const counts = new Map<string, number>()
  for (const hit of found) {
    counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1)
  }
  const over = found.filter(
    (hit) =>
      (counts.get(hit.file) ?? 0) >
      (Object.hasOwn(baseline, hit.file) ? (baseline[hit.file] as number) : 0)
  )
  if (over.length > 0) {
    throw new RenderError(
      'internal references',
      `${over.length} line(s) of the published site name an ADR, a ticket, an audit id or an unpublished directory:\n${over
        .map((hit) => `  ${hit.file}:${hit.line}  ${hit.text}`)
        .join('\n')}`
    )
  }
}
