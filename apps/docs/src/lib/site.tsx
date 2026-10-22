import { existsSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Landing } from '~/components/landing'
import { Document, type Frame, type PageProps } from '~/components/layout'
import { BASE, REPO_ROOT } from './config'
import { buildErrorCodesPage, ERROR_CODES_ROUTE, errorCodeEntries } from './error-codes'
import type { LinkEnvironment } from './links'
import {
  createCodeHighlighter,
  type Heading,
  markdownAnchors,
  type ParsedDoc,
  parseMarkdown,
  renderMarkdown,
  type Section,
} from './markdown'
import { buildNav, type NavGroup } from './nav'
import { collectPages, type SourcePage } from './pages'
import { buildIndex, type SearchEntry } from './search'

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
 * @returns The pages, the search index and the finished HTML.
 * @throws RenderError or LinkError for a file or link that cannot be rendered.
 */
export async function buildSite(
  assets: Frame['assets'] = { css: [], js: '' },
  base: string = BASE
): Promise<Site> {
  const sources = collectPages()
  const docs = new Map<string, ParsedDoc>()
  for (const source of sources) {
    docs.set(
      source.file,
      parseMarkdown(source.file, await readFile(join(REPO_ROOT, source.file), 'utf8'))
    )
  }
  const environment = repositoryEnvironment(sources, docs, base)
  const titles = new Map(
    sources.map((source) => [source.route, (docs.get(source.file) as ParsedDoc).title])
  )
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
  for (const source of sources) {
    const doc = docs.get(source.file) as ParsedDoc
    const rendered = renderMarkdown(doc, environment, highlighter)
    for (const file of rendered.assets) {
      copied.add(file)
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
  const errors = buildErrorCodesPage(errorCodeEntries())
  pages.push({
    source: null,
    route: ERROR_CODES_ROUTE,
    title: errors.title,
    description: 'Every error code the API returns, with its HTTP status and default message.',
    html: errors.html,
    headings: errors.headings,
    sections: errors.sections,
  })

  const documents = new Map<string, string>()
  for (const page of pages) {
    documents.set(page.route, html(page, frame))
  }
  const landing: PageProps = {
    title: 'Tula Auth',
    description:
      'Self-hosted authentication and user management with prebuilt UI and native mobile SDKs.',
    route: LANDING_ROUTE,
    html: '',
    headings: [],
  }
  documents.set(LANDING_ROUTE, html(landing, frame, <Landing base={base} />))
  const notFound = html(
    {
      title: 'Page not found',
      description: 'There is nothing at this address.',
      route: '/404',
      html: '',
      headings: [],
    },
    frame,
    <div className='max-w-3xl'>
      <h1 className='text-2xl font-semibold'>Page not found</h1>
      <p>
        There is nothing at this address. <a href={base}>Go to the start page</a>.
      </p>
    </div>
  )

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
  for (const asset of site.assets) {
    const target = join(outDir, 'files', ...asset.split(posix.sep))
    await mkdir(dirname(target), { recursive: true })
    await cp(join(REPO_ROOT, asset), target)
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
