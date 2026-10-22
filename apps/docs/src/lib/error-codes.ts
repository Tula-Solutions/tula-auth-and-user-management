import { ERROR_DEFINITIONS } from '@tula-tech/contract/error-codes'
import { type Heading, SECTION_ATTRIBUTE, type Section } from './markdown'

/** The route of the generated error-code reference. */
export const ERROR_CODES_ROUTE = '/reference/error-codes/'

/** One error code of the contract, as the page lists it. */
export interface ErrorCodeEntry {
  code: string
  status: number
  message: string
  /** The part before the dot (`password`), or `general` for the cross-cutting codes. */
  area: string
}

/** The page built from the contract's error codes. */
export interface ErrorCodesPage {
  title: string
  html: string
  headings: Heading[]
  sections: Section[]
}

/**
 * Escape text for an HTML body or a double-quoted attribute.
 *
 * @param value - Text from the contract.
 * @returns The text with `& < > "` replaced.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Every error code of `@tula-tech/contract`, in the order the contract declares them.
 *
 * @returns One entry per code.
 */
export function errorCodeEntries(): ErrorCodeEntry[] {
  return Object.entries(ERROR_DEFINITIONS).map(([code, definition]) => ({
    code,
    status: definition.status,
    message: definition.message,
    area: code.includes('.') ? (code.split('.')[0] as string) : 'general',
  }))
}

/**
 * The id of an area's heading. Prefixed so that it can never equal a code (`rate_limited` is
 * a code, with no dot, and an area called that would collide).
 *
 * @param area - The area name.
 * @returns The id.
 */
export function areaId(area: string): string {
  return `area-${area}`
}

/**
 * Build the error-code reference: one section per code whose `id` is the code itself.
 *
 * The code is the anchor (`#password.too_short`) because it is the one name that never
 * changes: codes are append-only in the contract. The page is generated, not written, so that a
 * code added to the contract has a page entry in the same build.
 *
 * @param entries - From {@link errorCodeEntries}.
 * @returns The page's body and what the table of contents and the search need.
 */
export function buildErrorCodesPage(entries: readonly ErrorCodeEntry[]): ErrorCodesPage {
  const areas = new Map<string, ErrorCodeEntry[]>()
  for (const entry of entries) {
    areas.set(entry.area, [...(areas.get(entry.area) ?? []), entry])
  }
  const headings: Heading[] = [{ depth: 1, text: 'Error codes', id: 'error-codes' }]
  const sections: Section[] = [
    {
      id: null,
      title: 'Error codes',
      text: 'Every error code the API returns, with its HTTP status and default message.',
    },
  ]
  // The same sections `wrapSections` makes of a rendered Markdown page: the introduction, then
  // one for each h2 and h3.
  let opened = 0
  const open = () => `<div ${SECTION_ATTRIBUTE}="${opened++}">`
  const next = () => `</div>\n${open()}`
  const parts: string[] = [
    open(),
    '<h1 id="error-codes">Error codes</h1>',
    `<p>Every error code the API returns, with its HTTP status and default message. The code, not the message, is the contract: an SDK switches on <code>code</code> and may word the message itself. Codes are only ever added. An error response has the shape <code>{ status, code, detail, params?, errors? }</code>; a field error carries the code of the rule that failed. The codes are defined in <code>@tula-tech/contract</code> (<a href="../contract/">reference</a>).</p>`,
  ]
  for (const [area, codes] of areas) {
    const id = areaId(area)
    headings.push({ depth: 2, text: area, id })
    parts.push(
      next(),
      `<h2 id="${escapeHtml(id)}">${escapeHtml(area)}<a class="permalink" href="#${escapeHtml(id)}" aria-label="Link to “${escapeHtml(area)}”">#</a></h2>`
    )
    for (const { code, status, message } of codes) {
      headings.push({ depth: 3, text: code, id: code })
      sections.push({ id: code, title: code, text: `${message} HTTP ${status}` })
      parts.push(
        next(),
        `<h3 id="${escapeHtml(code)}"><code>${escapeHtml(code)}</code><a class="permalink" href="#${escapeHtml(code)}" aria-label="Link to “${escapeHtml(code)}”">#</a></h3>`,
        `<p class="error-meta">HTTP ${status}</p>`,
        `<p>${escapeHtml(message)}</p>`
      )
    }
  }
  parts.push('</div>')
  return { title: 'Error codes', html: parts.join('\n'), headings, sections }
}
