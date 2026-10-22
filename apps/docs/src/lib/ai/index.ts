import type { ErrorCodeEntry } from '../error-codes'
import type { LinkEnvironment } from '../links'
import { type NavGroup, navRoutes } from '../nav'
import { checkAiFiles } from './check'
import { buildRobots, buildSitemap } from './discovery'
import { type AiPage, buildLlmsFull, buildLlmsTxt, firstSentence, inFullText } from './llms'
import { buildSkill } from './skill'
import { errorCodesMarkdown, frontMatter, renderTwin } from './twin'
import { fileUrl, pageUrl, twinPath, type Urls } from './urls'

export { checkAiFiles } from './check'
export { buildRobots, buildSitemap } from './discovery'
export { LLMS_FULL_CAP, LLMS_TXT_CAP } from './llms'
export { SKILL_SOURCE } from './skill'
export { SITE_ORIGIN, twinPath } from './urls'

/** A page the build rendered, as the files for agents need it. */
export interface AiSourcePage extends AiPage {
  /** The Markdown file, or `null` for a page the build writes itself. */
  source: string | null
  /** The anchors the page offers. */
  ids: ReadonlySet<string>
}

/** Everything {@link buildAiFiles} reads. */
export interface AiInput {
  urls: Urls
  environment: LinkEnvironment
  /** One sentence about the product. */
  summary: string
  nav: readonly NavGroup[]
  /** Every page of the site but the landing page, in any order. */
  pages: readonly AiSourcePage[]
  /** The landing page. */
  landing: AiPage
  /** The text of a Markdown file, from the repository root. */
  read(file: string): string
  /** The generated error codes, which have no source file. */
  errorCodes: { route: string; entries: readonly ErrorCodeEntry[] }
  /** The text of the skill's source, when the repository has one. */
  skillSource: string | null
  /** The date a file last changed, when the build knows it. */
  updated?(file: string): string | undefined
  /** Where a Markdown file is on GitHub. */
  repositoryUrl(file: string): string
  /** Files the pages show, copied under `files/` (images), from the repository root. */
  copied: readonly string[]
}

/**
 * Write every file for agents: a Markdown twin of every page, `llms.txt`, `llms-full.txt`,
 * `skill.md`, `sitemap.xml` and `robots.txt`, and check them (`checkAiFiles`).
 *
 * @param input - The pages, the sidebar and what the files need to be absolute.
 * @returns The files, by path from the site's root.
 * @throws LinkError or RenderError for a link that does not resolve, and for a file that
 *   fails its check.
 */
export function buildAiFiles(input: AiInput): Map<string, string> {
  const { urls } = input
  const described = input.pages.map((page) => ({
    ...page,
    description: firstSentence(page.description),
  }))
  const home = { ...input.landing, description: firstSentence(input.landing.description) }
  const files = new Map<string, string>()
  const sectionOf = new Map<string, string>()
  for (const group of input.nav) {
    const walk = (items: NavGroup['items']): void => {
      for (const item of items) {
        sectionOf.set(item.route, group.title)
        walk(item.children)
      }
    }
    walk(group.items)
  }

  const twins = new Map<string, string>()
  for (const page of described) {
    const text =
      page.source === null
        ? `${frontMatter({
            title: page.title,
            description: page.description,
            url: pageUrl(urls, page.route),
            section: sectionOf.get(page.route),
          })}\n> For an index of all documentation, see [llms.txt](${fileUrl(urls, 'llms.txt')}).\n\n${errorCodesMarkdown(input.errorCodes.entries)}`
        : renderTwin({
            file: page.source,
            route: page.route,
            title: page.title,
            description: page.description,
            section: sectionOf.get(page.route),
            updated: input.updated?.(page.source),
            source: input.read(page.source),
            environment: input.environment,
            urls,
            repositoryUrl: input.repositoryUrl(page.source),
          })
    twins.set(page.route, text)
    files.set(twinPath(page.route), text)
  }

  const pageList = new Map<string, AiPage>(described.map((page) => [page.route, page]))
  pageList.set(home.route, home)
  const links = ['/docs/', '/quickstart/']
    .filter((route) => pageList.has(route))
    .map((route) => `- [${pageList.get(route)?.title}](${pageUrl(urls, route)})`)
  files.set(
    twinPath(home.route),
    `${frontMatter({ title: home.title, description: home.description, url: pageUrl(urls, home.route) })}\n# ${home.title}\n\n${home.description}\n\nThe index of the documentation, for an agent, is [llms.txt](${fileUrl(urls, 'llms.txt')}); every page also has a Markdown twin.\n\n${links.join('\n')}\n`
  )

  const hasSkill = input.skillSource !== null
  files.set(
    'llms.txt',
    buildLlmsTxt({ urls, summary: input.summary, nav: input.nav, pages: pageList, hasSkill })
  )
  const fullRoutes = navRoutes(input.nav).filter(inFullText)
  const ordered = ['/docs/', ...fullRoutes].filter(
    (route, index, all) => all.indexOf(route) === index && twins.has(route)
  )
  files.set(
    'llms-full.txt',
    buildLlmsFull({ urls, summary: input.summary, routes: ordered, twins })
  )
  files.set('robots.txt', buildRobots(urls))
  const routes = [home.route, ...described.map((page) => page.route)]
  const dateOf = new Map(
    described.flatMap((page) => {
      const date = page.source === null ? undefined : input.updated?.(page.source)
      return date === undefined ? [] : [[page.route, date] as const]
    })
  )
  files.set(
    'sitemap.xml',
    buildSitemap(urls, routes, (route) => dateOf.get(route))
  )
  if (input.skillSource !== null) {
    // A page is named by its file, or by its route for one that has no file (the error codes).
    const fileRoutes = new Map<string, string>(
      described.map((page) => [page.source ?? page.route, page.route])
    )
    files.set('skill.md', buildSkill(input.skillSource, fileRoutes, new Set(files.keys()), urls))
  }

  const anchors = new Map<string, ReadonlySet<string>>(
    described.map((page) => [page.route, page.ids])
  )
  anchors.set(home.route, new Set())
  checkAiFiles({
    urls,
    files,
    pages: anchors,
    copied: new Set(input.copied.map((file) => `files/${file}`)),
  })
  return files
}

/**
 * Add the `<link rel="alternate" type="text/markdown">` that points a page at its twin.
 *
 * @param document - A finished HTML document.
 * @param href - The twin's address (under the base).
 * @returns The document with the link at the end of its head.
 * @throws Error when the document has no head.
 */
export function withAlternate(document: string, href: string): string {
  const at = document.indexOf('</head>')
  if (at === -1) {
    throw new Error('the document has no </head> to put the Markdown alternate in')
  }
  return `${document.slice(0, at)}<link rel="alternate" type="text/markdown" href="${href}"/>${document.slice(at)}`
}
