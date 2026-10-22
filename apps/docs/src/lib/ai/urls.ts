/** Where the published site lives, without a path: the base is added to it. */
export const SITE_ORIGIN = 'https://tula-solutions.github.io'

/** What an absolute address of the site is made of. */
export interface Urls {
  /** The scheme and host (`https://tula-solutions.github.io`), without a trailing slash. */
  origin: string
  /** The path the site is served under (`/`, or `/a/b/`): always from `resolveBase()`. */
  base: string
}

/**
 * The file a route's Markdown twin is written to, relative to the site's root.
 *
 * `/methods/password/` is `methods/password.md`, `/docs/` is `docs.md` and the landing page `/`
 * is `index.md`: the address of the page without its trailing slash, plus `.md`.
 *
 * @param route - A route with a leading and trailing slash, without the base.
 * @returns The path, without a leading slash.
 */
export function twinPath(route: string): string {
  const inside = route.replace(/^\/+|\/+$/g, '')
  return inside === '' ? 'index.md' : `${inside}.md`
}

/**
 * An absolute address of a file of the site.
 *
 * @param urls - The origin and the base.
 * @param path - The file, relative to the site's root (`llms.txt`, `methods/password.md`).
 * @returns `<origin><base><path>`.
 */
export function fileUrl(urls: Urls, path: string): string {
  return `${urls.origin}${urls.base}${path}`
}

/**
 * The absolute address of a page (the HTML one, with its trailing slash).
 *
 * @param urls - The origin and the base.
 * @param route - The page's route.
 * @returns `<origin><base without its slash><route>`.
 */
export function pageUrl(urls: Urls, route: string): string {
  return `${urls.origin}${urls.base.replace(/\/$/, '')}${route}`
}

/**
 * The absolute address of a page's Markdown twin.
 *
 * @param urls - The origin and the base.
 * @param route - The page's route.
 * @param fragment - An anchor of the page, without the `#`.
 * @returns The address, with `#fragment` when one is given.
 */
export function twinUrl(urls: Urls, route: string, fragment = ''): string {
  const address = fileUrl(urls, twinPath(route))
  return fragment === '' ? address : `${address}#${fragment}`
}
