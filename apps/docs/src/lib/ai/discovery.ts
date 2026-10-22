import { fileUrl, pageUrl, type Urls } from './urls'

/** Escape text for an XML element. */
function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * `sitemap.xml`: every page's address, with the date it last changed where the build knows it.
 *
 * @param urls - The origin and the base.
 * @param routes - The routes of the pages (the 404 page is not one).
 * @param updated - The date (`YYYY-MM-DD`) a route's source last changed, when known.
 * @returns The XML.
 */
export function buildSitemap(
  urls: Urls,
  routes: readonly string[],
  updated: (route: string) => string | undefined = () => undefined
): string {
  const entries = [...routes].sort().map((route) => {
    const date = updated(route)
    return `  <url><loc>${xml(pageUrl(urls, route))}</loc>${date === undefined ? '' : `<lastmod>${xml(date)}</lastmod>`}</url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`
}

/**
 * `robots.txt`: everything is allowed, and the sitemap is named. Crawlers read this file only
 * at a host's root, so under a sub-path (GitHub Pages) it is a file for whoever fetches it by
 * name, and the sitemap line is what it is for.
 *
 * @param urls - The origin and the base.
 * @returns The file's text.
 */
export function buildRobots(urls: Urls): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${fileUrl(urls, 'sitemap.xml')}\n`
}
