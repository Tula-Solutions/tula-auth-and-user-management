import { RenderError } from '../markdown'
import { LLMS_FULL_CAP, LLMS_TXT_CAP } from './llms'
import { twinPath, type Urls } from './urls'

/** What {@link checkAiFiles} judges. */
export interface AiCheckInput {
  urls: Urls
  /** The files written, by path from the site's root (`llms.txt`, `methods/password.md`). */
  files: ReadonlyMap<string, string>
  /** Every page's route, with the ids its page offers as anchors. */
  pages: ReadonlyMap<string, ReadonlySet<string>>
  /** Files the site copies under `files/` (images), by path from the site's root. */
  copied: ReadonlySet<string>
}

const ADDRESS = /https?:\/\/[^\s)>\]"'`<]+/g

/**
 * Every address of this site that a file mentions.
 *
 * @param text - A file's text.
 * @param urls - The origin and the base.
 * @returns The path after the base (with the fragment), for each address.
 */
function ownAddresses(text: string, urls: Urls): string[] {
  const prefix = `${urls.origin}${urls.base.replace(/\/$/, '')}/`
  const exact = `${urls.origin}${urls.base.replace(/\/$/, '')}`
  return (text.match(ADDRESS) ?? [])
    .map((address) => address.replace(/[.,;:]+$/, ''))
    .filter((address) => address === exact || address.startsWith(prefix))
    .map((address) => address.slice(prefix.length - 1).replace(/^\//, ''))
}

/** Why an address of the site, as a path after the base, does not lead anywhere, or `null`. */
function problemWith(path: string, input: AiCheckInput): string | null {
  const [location = '', rawFragment] = path.split('#')
  let fragment: string | undefined
  try {
    fragment = rawFragment === undefined ? undefined : decodeURIComponent(rawFragment)
  } catch {
    return 'has an anchor that is not a valid URL'
  }
  if (input.files.has(location)) {
    const route = [...input.pages.keys()].find((one) => twinPath(one) === location)
    if (fragment !== undefined && fragment !== '' && route !== undefined) {
      const ids = input.pages.get(route) as ReadonlySet<string>
      if (!ids.has(fragment)) {
        return `points at an anchor "#${fragment}" its page does not have`
      }
    }
    return null
  }
  if (input.copied.has(location)) {
    return null
  }
  // The HTML page of a route: a route is a directory.
  const route = location === '' ? '/' : `/${location.replace(/\/$/, '')}/`
  if (input.pages.has(route)) {
    const ids = input.pages.get(route) as ReadonlySet<string>
    return fragment !== undefined && fragment !== '' && !ids.has(fragment)
      ? `points at an anchor "#${fragment}" its page does not have`
      : null
  }
  return 'points at a file the build does not write'
}

/**
 * Check the files written for agents, and throw for the first problem of each kind: a page
 * with no Markdown twin, a link in a twin, in `llms.txt`, in `llms-full.txt` or in `skill.md`
 * that goes to this site and finds nothing (or an anchor the page does not have), a page that
 * `llms.txt` leaves out, and `llms.txt` or `llms-full.txt` over its cap.
 *
 * @param input - The files, the pages and the copied images.
 * @throws RenderError naming the file and what is wrong.
 */
export function checkAiFiles(input: AiCheckInput): void {
  for (const route of input.pages.keys()) {
    if (!input.files.has(twinPath(route))) {
      throw new RenderError(route, `has no Markdown twin (${twinPath(route)})`)
    }
  }
  const index = input.files.get('llms.txt')
  if (index === undefined) {
    throw new RenderError('llms.txt', 'is not written')
  }
  const listed = new Set(ownAddresses(index, input.urls))
  for (const route of input.pages.keys()) {
    if (!listed.has(twinPath(route))) {
      throw new RenderError('llms.txt', `does not list ${route} (${twinPath(route)})`)
    }
  }
  const full = input.files.get('llms-full.txt')
  if (full === undefined) {
    throw new RenderError('llms-full.txt', 'is not written')
  }
  if (index.length > LLMS_TXT_CAP) {
    throw new RenderError(
      'llms.txt',
      `is ${index.length} characters, over the cap of ${LLMS_TXT_CAP}`
    )
  }
  if (full.length > LLMS_FULL_CAP) {
    throw new RenderError(
      'llms-full.txt',
      `is ${full.length} characters, over the cap of ${LLMS_FULL_CAP}`
    )
  }
  // `llms-full.txt` holds the twins' text again, so its links are the twins' links.
  for (const [path, text] of input.files) {
    if (!path.endsWith('.md') && !path.endsWith('.txt') && path !== 'sitemap.xml') {
      continue
    }
    for (const address of ownAddresses(text, input.urls)) {
      const problem = problemWith(address, input)
      if (problem !== null) {
        throw new RenderError(path, `links to "${address}", which ${problem}`)
      }
    }
  }
}
