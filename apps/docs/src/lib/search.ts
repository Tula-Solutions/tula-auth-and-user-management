/**
 * The site's search: a static index written at build time and a small matcher that runs in the
 * browser (and in the tests). No service, no library: the index is one JSON file.
 */

/** One searchable part of a page: a page, a section of it, or an error code. */
export interface SearchEntry {
  /** The title: the section's heading, or the error code. */
  t: string
  /** The title of the page it is on. */
  p: string
  /** The address, with the base and the anchor. */
  u: string
  /** The start of its prose, for matching and for the snippet. */
  x: string
}

/** What the indexer reads from a page. */
export interface IndexablePage {
  title: string
  /** The page's route, without the base. */
  route: string
  sections: readonly { id: string | null; title: string; text: string }[]
}

/** The most prose kept per section: enough to find a word, small enough to download. */
export const MAX_TEXT = 1200

/**
 * The score of a page whose own title starts with the query (`passkey` for Passkeys): above
 * every section, even a heading equal to the query (a reference section named `passkey`).
 */
const PAGE_PREFIX_SCORE = 2000

/**
 * Build the index.
 *
 * @param pages - Every page with its sections (error codes are sections of their page, with the code as id).
 * @param base - The path the site is served under (`/`).
 * @returns One entry per section.
 */
export function buildIndex(pages: readonly IndexablePage[], base: string): SearchEntry[] {
  const prefix = base.replace(/\/$/, '')
  return pages.flatMap((page) =>
    page.sections.map((section) => ({
      t: section.id === null ? page.title : section.title,
      p: page.title,
      u: `${prefix}${page.route}${section.id === null ? '' : `#${section.id}`}`,
      x: section.text.slice(0, MAX_TEXT),
    }))
  )
}

/** Separators that a reader may or may not type: `password.too_short`, `too short`. */
function loose(value: string): string {
  return value.replace(/[._\-/\s]+/g, ' ').trim()
}

function matches(haystack: string, term: string): boolean {
  return haystack.includes(term) || loose(haystack).includes(loose(term))
}

/**
 * Score an entry for a query; 0 means it does not match.
 *
 * Every word of the query must appear in the title, the page title or the text. The order is:
 * a page whose title starts with the query, a section title equal to it (an error code typed
 * in full), a title that contains it, a page title, and last the prose.
 *
 * @param entry - An index entry.
 * @param query - What the reader typed.
 * @returns The score.
 */
export function score(entry: SearchEntry, query: string): number {
  const whole = query.trim().toLowerCase()
  const words = whole.split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) {
    return 0
  }
  const title = entry.t.toLowerCase()
  const page = entry.p.toLowerCase()
  const text = entry.x.toLowerCase()
  let total = title === whole ? 1000 : 0
  // A page whose title starts with the query (`passkey` for Passkeys, `self-host` for
  // Self-hosting) leads, ahead of any section that merely contains the word. A page's own
  // entry is the one with no anchor.
  if (!entry.u.includes('#') && loose(title).startsWith(loose(whole))) {
    total = PAGE_PREFIX_SCORE
  }
  if (total === 0 && matches(title, whole)) {
    total += 100
  }
  for (const word of words) {
    if (matches(title, word)) {
      total += 30 + (title.startsWith(word) ? 10 : 0)
    } else if (matches(page, word)) {
      total += 8
    } else if (matches(text, word)) {
      total += 2
    } else {
      return 0
    }
  }
  return total
}

/**
 * What a result says about itself: its title and where it is.
 *
 * @param entry - An index entry.
 * @returns The heading (or page title) and the page it is on, or `Page` for a page itself.
 */
export function label(entry: SearchEntry): { title: string; where: string } {
  return { title: entry.t, where: entry.u.includes('#') ? entry.p : 'Page' }
}

/**
 * Find the entries that match a query, best first.
 *
 * @param index - From {@link buildIndex}.
 * @param query - What the reader typed.
 * @param limit - The most results to return.
 * @returns The matching entries.
 */
export function search(index: readonly SearchEntry[], query: string, limit = 12): SearchEntry[] {
  return index
    .map((entry) => ({ entry, points: score(entry, query) }))
    .filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map(({ entry }) => entry)
}
