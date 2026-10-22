import { REPO_BRANCH, REPO_URL } from '../config'
import type { NavGroup, NavItem } from '../nav'
import { fileUrl, twinUrl, type Urls } from './urls'

/** The most characters `llms.txt` may hold (Mintlify's cap: a longer index is not read whole). */
export const LLMS_TXT_CAP = 100_000

/**
 * The most characters `llms-full.txt` may hold. The hand-written pages are about 0.9 million
 * characters; the generated SDK reference, which is several times that, is left out (it is in
 * `llms.txt` and has a twin of its own), so that the file an agent loads whole stays loadable.
 */
export const LLMS_FULL_CAP = 1_500_000

/** The routes that are not in `llms-full.txt`: the generated reference and the landing page. */
export function inFullText(route: string): boolean {
  return route !== '/' && !route.startsWith('/reference/')
}

/**
 * The first sentence of a page's description: the pages' own description is the start of the
 * introduction cut to 160 characters, which may end in the middle of a word.
 *
 * @param description - A page's description.
 * @returns The text up to the first full stop that ends a sentence, else the whole text.
 */
export function firstSentence(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim()
  const end = /[.!?](?=\s|$)/.exec(text)
  return end === null ? text : text.slice(0, end.index + 1)
}

/** What the index says of a page. */
export interface AiPage {
  route: string
  title: string
  description: string
}

/** What {@link buildLlmsTxt} needs. */
export interface LlmsInput {
  urls: Urls
  /** One sentence about the product, the blockquote under the title. */
  summary: string
  /** The sidebar, whose groups are the sections. */
  nav: readonly NavGroup[]
  /** Every page by route. */
  pages: ReadonlyMap<string, AiPage>
  /** Whether the site has a `skill.md`. */
  hasSkill: boolean
}

/** A link's text: brackets would end it early. */
function label(text: string): string {
  return text.replace(/[[\]]/g, (bracket) => `\\${bracket}`)
}

function line(urls: Urls, page: AiPage): string {
  const description = page.description.replace(/\s+/g, ' ').trim()
  const entry = `- [${label(page.title)}](${twinUrl(urls, page.route)})`
  return description === '' ? entry : `${entry}: ${description}`
}

function flatten(items: readonly NavItem[]): string[] {
  return items.flatMap((item) => [item.route, ...flatten(item.children)])
}

/**
 * The index of the documentation in the llms.txt convention (llmstxt.org): a title, a summary,
 * a few lines on how to read the rest, and a section of `- [Title](url): description` per
 * group of the sidebar, in its order, one line for every page. Pages outside the repository's
 * `docs/` that an agent may skip are in a last `Optional` section.
 *
 * @param input - The sidebar, the pages and the base.
 * @returns The file's text.
 * @throws Error when the sidebar names a route that has no page.
 */
export function buildLlmsTxt(input: LlmsInput): string {
  const { urls } = input
  const listed = new Set<string>()
  function section(title: string, routes: readonly string[]): string[] {
    const lines: string[] = []
    for (const route of routes) {
      const page = input.pages.get(route)
      if (page === undefined) {
        throw new Error(`the sidebar lists ${route}, which has no page`)
      }
      if (!listed.has(route)) {
        listed.add(route)
        lines.push(line(urls, page))
      }
    }
    return lines.length === 0 ? [] : [`## ${title}`, ...lines, '']
  }
  const sections = [
    ...section('Overview', ['/', '/docs/']),
    ...input.nav.flatMap((group) => section(group.title, flatten(group.items))),
  ]
  const own = [
    `- [llms-full.txt](${fileUrl(urls, 'llms-full.txt')}): the hand-written pages in one file, in this order; the generated SDK reference is left out and listed below.`,
    ...(input.hasSkill
      ? [
          `- [skill.md](${fileUrl(urls, 'skill.md')}): an agent skill that says how to add Tula Auth to a project.`,
        ]
      : []),
  ]
  const repository = `${REPO_URL}/tree/${REPO_BRANCH}`
  return [
    '# Tula Auth',
    '',
    `> ${input.summary}`,
    '',
    '## How agents should use these docs',
    '',
    '- Every page has a Markdown twin: take its address, drop the trailing slash and add `.md` (`/methods/password/` is `/methods/password.md`).',
    '- The links below are those twins. Fetch the one you need instead of the whole site.',
    '- The error codes have anchors of their own (`/reference/error-codes/#password.too_short`), and the codes are only ever added: prefer them to guessing from a message.',
    ...own,
    '',
    ...sections,
    '## Optional',
    '',
    `- [Architecture decisions](${repository}/docs/adr): one record per decision, with the reasoning the pages above link to.`,
    `- [Plans](${repository}/docs/plans): what was built, in what order, and what was not verified.`,
    '',
  ].join('\n')
}

/** What {@link buildLlmsFull} needs. */
export interface FullInput {
  urls: Urls
  summary: string
  /** The routes to include, in the sidebar's order. */
  routes: readonly string[]
  /** Each page's twin, by route. */
  twins: ReadonlyMap<string, string>
}

/**
 * Every hand-written page in one file: each page's twin (front matter, then the Markdown),
 * in the sidebar's order, separated by a line of `---`.
 *
 * @param input - The routes and their twins.
 * @returns The file's text.
 * @throws Error when a route has no twin.
 */
export function buildLlmsFull(input: FullInput): string {
  const parts = input.routes.map((route) => {
    const twin = input.twins.get(route)
    if (twin === undefined) {
      throw new Error(`${route} has no Markdown twin to put in llms-full.txt`)
    }
    return twin.trim()
  })
  const head = `# Tula Auth: the documentation in one file\n\n> ${input.summary}\n\nThe index is ${fileUrl(input.urls, 'llms.txt')}. The generated SDK reference is not repeated here: it is listed there, page by page.`
  return `${[head, ...parts].join('\n\n---\n\n')}\n`
}
