import { existsSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Landing } from '~/components/landing'
import { Document, type Frame, type PageProps } from '~/components/layout'
import { BASE, REPO_ROOT, SITE_DESCRIPTION } from './config'
import { buildErrorCodesPage, ERROR_CODES_ROUTE, errorCodeEntries } from './error-codes'
import { checkCacheInputs } from './inputs'
import type { LinkEnvironment } from './links'
import {
  createCodeHighlighter,
  type Heading,
  markdownAnchors,
  type ParsedDoc,
  parseMarkdown,
  renderMarkdown,
  SECTION_ATTRIBUTE,
  type Section,
  titleOf,
} from './markdown'
import { buildNav, type NavGroup } from './nav'
import { checkPage } from './page-check'
import { collectPages, type SourcePage } from './pages'
import { buildIndex, type SearchEntry } from './search'

/** The docs app's `turbo.json`, whose inputs a whole build checks against the links. */
const TURBO_PATH = join(import.meta.dir, '../../turbo.json')

/** A page of the built site. */
export interface BuiltPage {
  /** The Markdown file it comes from, or `null` for a page the build writes itself. */
  source: string | null
  route: string
  title: string
  description: string
  html: string
  headings: Heading[]
  sections: Section[]
}

/** The site, built and not yet written. */
export interface Site {
  pages: BuiltPage[]
  nav: NavGroup[]
  index: SearchEntry[]
  /** Repository files the pages show (images), to copy under `files/`. */
  assets: string[]
  /** The finished HTML of each route, by route. */
  documents: Map<string, string>
  notFound: string
}

/** The route of the landing page. */
export const LANDING_ROUTE = '/'

/**
 * Read the repository the way the link resolver needs it.
 *
 * @param pages - The pages of the site.
 * @param docs - Their parsed documents, so a page's anchors are the ones it renders.
 * @param base - The path the site is served under.
 * @returns The environment.
 */
export function repositoryEnvironment(
  pages: readonly SourcePage[],
  docs: ReadonlyMap<string, ParsedDoc>,
  base: string
): LinkEnvironment {
  const others = new Map<string, ReadonlySet<string>>()
  return {
    routes: new Map(pages.map((page) => [page.file, page.route])),
    base,
    kind(path) {
      const absolute = join(REPO_ROOT, path)
      if (!existsSync(absolute)) {
        return null
      }
      return statSync(absolute).isDirectory() ? 'directory' : 'file'
    },
    anchorsOf(file) {
      const parsed = docs.get(file)
      if (parsed !== undefined) {
        return parsed.ids
      }
      if (!file.endsWith('.md')) {
        return null
      }
      let anchors = others.get(file)
      if (anchors === undefined) {
        anchors = markdownAnchors(file, readFileSync(join(REPO_ROOT, file), 'utf8'))
        others.set(file, anchors)
      }
      return anchors
    },
  }
}

function describe(text: string, title: string): string {
  const clipped = text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text
  return clipped === '' ? title : clipped
}

function html(page: PageProps, frame: Frame, children?: React.ReactNode): string {
  return `<!doctype html>${renderToStaticMarkup(
    <Document page={page} frame={frame}>
      {children}
    </Document>
  )}`
}

/**
 * Build the whole site in memory.
 *
 * Every Markdown file of `docs/` in scope is parsed, then rendered with its links resolved; the
 * first file that cannot be rendered, or link that cannot be resolved, throws and nothing is
 * written. The sidebar comes from `docs/README.md`, the error-code page from the contract.
 *
 * @param assets - The stylesheet and script the pages load (empty for a check).
 * @param base - The path the site is served under.
 * @param only - Routes to render and index, for a test that needs the shape of the site and
 *   not all of it (the sidebar is complete, and a link into a page that is not rendered still
 *   has its anchor checked). Omitted, every page is parsed and rendered.
 * @returns The pages, the search index and the finished HTML.
 * @throws RenderError or LinkError for a file or link that cannot be rendered, and, for a build
 *   of every page, RenderError when the app's cached tasks do not name an input for a file the
 *   pages link to.
 */
export async function buildSite(
  assets: Frame['assets'] = { css: [], js: '' },
  base: string = BASE,
  only?: readonly string[]
): Promise<Site> {
  const wanted = (route: string) => only === undefined || only.includes(route)
  const sources = collectPages()
  const docs = new Map<string, ParsedDoc>()
  const docOf = (source: SourcePage): ParsedDoc => {
    let doc = docs.get(source.file)
    if (doc === undefined) {
      doc = parseMarkdown(source.file, readFileSync(join(REPO_ROOT, source.file), 'utf8'))
      docs.set(source.file, doc)
    }
    return doc
  }
  // A whole build parses every file, so that one that cannot be parsed stops it. A build of a
  // sample parses only the pages it renders; the others are parsed when something asks for
  // their title (the sidebar) and their anchors are read when a link points into them.
  for (const source of sources.filter((one) => wanted(one.route))) {
    docOf(source)
  }
  const environment = repositoryEnvironment(sources, docs, base)
  const sourceOfRoute = new Map(sources.map((source) => [source.route, source]))
  const titles = {
    get: (route: string) => {
      const source = sourceOfRoute.get(route)
      if (source === undefined) {
        return undefined
      }
      // A page already parsed has its title; any other costs only the lines before its first
      // `##`, not the whole file.
      return (
        docs.get(source.file)?.title ??
        titleOf(source.file, readFileSync(join(REPO_ROOT, source.file), 'utf8'))
      )
    },
  }
  const readme = 'docs/README.md'
  const nav = buildNav(await readFile(join(REPO_ROOT, readme), 'utf8'), readme, environment, titles)
  const reference = nav.find((group) => group.title === 'SDK reference')
  const errorsItem = { label: 'Error codes', route: ERROR_CODES_ROUTE, children: [] }
  if (reference === undefined) {
    nav.push({ title: 'Reference', items: [errorsItem] })
  } else {
    reference.items.push(errorsItem)
  }

  const highlighter = await createCodeHighlighter()
  const frame: Frame = { base, assets, nav }
  const pages: BuiltPage[] = []
  const copied = new Set<string>()
  const linked = new Set<string>()
  for (const source of sources.filter((one) => wanted(one.route))) {
    const doc = docOf(source)
    const rendered = renderMarkdown(doc, environment, highlighter)
    for (const file of rendered.assets) {
      copied.add(file)
    }
    for (const file of rendered.files) {
      linked.add(file)
    }
    pages.push({
      source: source.file,
      route: source.route,
      title: doc.title,
      description: describe(doc.sections[0]?.text ?? '', doc.title),
      html: rendered.html,
      headings: doc.headings,
      sections: doc.sections,
    })
  }
  if (only === undefined) {
    // Only a build of every page knows every file the pages read (`inputs.ts` says why).
    checkCacheInputs(readFileSync(TURBO_PATH, 'utf8'), [...linked], (path) =>
      statSync(join(REPO_ROOT, path)).isDirectory()
    )
  }
  const errors = buildErrorCodesPage(errorCodeEntries())
  if (wanted(ERROR_CODES_ROUTE)) {
    pages.push({
      source: null,
      route: ERROR_CODES_ROUTE,
      title: errors.title,
      description: 'Every error code the API returns, with its HTTP status and default message.',
      html: errors.html,
      headings: errors.headings,
      sections: errors.sections,
    })
  }

  const documents = new Map<string, string>()
  for (const page of pages) {
    documents.set(page.route, html(page, frame))
  }
  const landing: PageProps = {
    title: 'Tula Auth',
    description: SITE_DESCRIPTION,
    route: LANDING_ROUTE,
    html: '',
    headings: [],
  }
  if (wanted(LANDING_ROUTE)) {
    documents.set(LANDING_ROUTE, html(landing, frame, <Landing base={base} />))
  }
  const notFound = html(
    {
      title: 'Page not found',
      description: 'There is nothing at this address.',
      route: '/404',
      html: '',
      headings: [],
    },
    frame,
    <div className='shell'>
      <div className='doc notfound'>
        <h1>Page not found</h1>
        <p>
          There is nothing at this address. <a href={base}>Go to the start page</a>, or search the
          documentation from the box above.
        </p>
      </div>
    </div>
  )

  // Whole-page rules that axe cannot judge when a large page is checked in pieces, and that
  // every address stays under the base path.
  for (const [route, document] of documents) {
    checkPage(route, document, base)
  }
  checkPage('/404', notFound, base)

  return {
    pages,
    nav,
    index: buildIndex(pages, base),
    assets: [...copied].sort(),
    documents,
    notFound,
  }
}

/**
 * The file a route is written to.
 *
 * @param outDir - The output directory.
 * @param route - A route with a leading and trailing slash.
 * @returns `<outDir>/<route>/index.html`.
 */
export function fileOfRoute(outDir: string, route: string): string {
  return join(outDir, ...route.split('/').filter((part) => part !== ''), 'index.html')
}

/**
 * Write a built site: one `index.html` per route, the search index, the copied images and a
 * list of the routes.
 *
 * @param site - From {@link buildSite}.
 * @param outDir - The directory; the bundler's output is already there and is kept.
 */
export async function writeSite(site: Site, outDir: string): Promise<void> {
  for (const [route, document] of site.documents) {
    const file = fileOfRoute(outDir, route)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, document)
  }
  await writeFile(join(outDir, '404.html'), site.notFound)
  await writeFile(join(outDir, 'search-index.json'), JSON.stringify(site.index))
  await writeFile(join(outDir, 'pages.json'), JSON.stringify([...site.documents.keys()].sort()))
  await writeFile(
    join(outDir, 'page-stats.json'),
    JSON.stringify(
      Object.fromEntries(
        [...site.documents].sort().map(([route, html]) => [route, pageStats(html)])
      )
    )
  )
  for (const asset of site.assets) {
    const target = join(outDir, 'files', ...asset.split(posix.sep))
    await mkdir(dirname(target), { recursive: true })
    await cp(join(REPO_ROOT, asset), target)
  }
}

/** How big a page is, for the browser tests that check it in pieces. */
export interface PageStats {
  /** The size of the document, in characters. */
  bytes: number
  /** The size of each content section (`data-docs-section`, in order), in characters. */
  sections: number[]
  /** How many lines of highlighted code (`class="line"`) each section holds. */
  lines: number[]
}

/**
 * Measure a rendered page.
 *
 * @param html - The document.
 * @returns Its size and the size of each content section (the last one runs to the end of the
 * document, footer included, which is a few hundred characters).
 */
export function pageStats(html: string): PageStats {
  const parts = html.split(`<div ${SECTION_ATTRIBUTE}="`).slice(1)
  return {
    bytes: html.length,
    sections: parts.map((part) => part.length),
    lines: parts.map((part) => part.split('class="line"').length - 1),
  }
}

/**
 * Remove a previous build's output.
 *
 * @param outDir - The output directory.
 */
export async function clean(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true })
}
