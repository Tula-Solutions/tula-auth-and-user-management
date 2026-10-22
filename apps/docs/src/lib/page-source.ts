import { REPO_BRANCH, REPO_URL } from './config'

/** The file the error-code page is generated from: it has no Markdown source. */
export const ERROR_CODES_SOURCE = 'packages/contract/src/error-codes.ts'

/** Directories of `docs/` that a generator writes: a hand edit would be overwritten. */
const GENERATED = ['docs/reference/'] as const

/** Where the source of a page is on GitHub, and what to call the link. */
export interface SourceLink {
  href: string
  label: string
  /** The file, from the repository root. */
  file: string
  /** Whether the link opens an editor (a hand-written file) or only shows the file. */
  editable: boolean
}

/**
 * The link from a page to its source on the development branch.
 *
 * A hand-written Markdown file gets GitHub's editor. A page that a generator writes (the SDK
 * reference, the error codes) links to the file that holds the text without offering to edit
 * the generated output, which `bun run docs:generate` would overwrite.
 *
 * @param source - The page's Markdown file from the repository root, or `null` for a page the
 *   build writes itself (the error codes).
 * @returns The link.
 */
export function sourceLink(source: string | null): SourceLink {
  const file = source ?? ERROR_CODES_SOURCE
  const editable = source !== null && !GENERATED.some((prefix) => source.startsWith(prefix))
  return {
    file,
    editable,
    href: `${REPO_URL}/${editable ? 'edit' : 'blob'}/${REPO_BRANCH}/${file}`,
    label: editable ? 'Edit this page on GitHub' : 'View the source on GitHub',
  }
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/**
 * A date as a reader reads it, without a time zone or a locale (a build in any place writes
 * the same page).
 *
 * @param iso - `YYYY-MM-DD`.
 * @returns `20 Oct 2026`, or `undefined` for anything that is not such a date.
 */
export function readableDate(iso: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const month = match === null ? undefined : MONTHS[Number(match[2]) - 1]
  return match === null || month === undefined
    ? undefined
    : `${Number(match[3])} ${month} ${match[1]}`
}

/**
 * The link that opens a prefilled issue about a page.
 *
 * @param title - The page's title.
 * @param pageAddress - The page's absolute address.
 * @returns A GitHub "new issue" address.
 */
export function issueLink(title: string, pageAddress: string): string {
  const query = new URLSearchParams({
    title: `Docs: ${title}`,
    body: `Page: ${pageAddress}\n\nWhat was wrong or missing?\n`,
    labels: 'docs',
  })
  return `${REPO_URL}/issues/new?${query.toString()}`
}
