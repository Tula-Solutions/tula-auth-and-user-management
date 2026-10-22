import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { SITE_ORIGIN } from '~/lib/ai/urls'
import { hasPlayground } from '~/lib/blocks'
import { SITE_NAME } from '~/lib/config'
import type { Heading } from '~/lib/markdown'
import type { NavGroup, NavItem } from '~/lib/nav'
import { canonicalOf, type ReleaseInfo } from '~/lib/release'
import { buildSections, type Section, sectionHome, sectionOf } from '~/lib/sections'
import { Header } from './header'
import { VersionBanner, VersionMarker } from './version'

/** The pages whose content is wider than the prose measure (the full playground). */
const WIDE_ROUTES: readonly string[] = ['/playground/']

/** What a page needs from the build to be drawn. */
export interface Frame {
  /** The path the site is served under. */
  base: string
  /** The site's stylesheet and script, as the bundler named them, and the fonts to preload. */
  assets: {
    css: string[]
    js: string
    fonts?: string[]
    /**
     * The playground island's entry and stylesheet, added to a page that holds a playground
     * (`hasPlayground`) and to no other. Absent in a check, which writes no assets.
     */
    playground?: { css: string[]; js: string }
  }
  nav: NavGroup[]
  /** Which docs this build is; `null` or absent for a site with one version (a local build). */
  release?: ReleaseInfo | null
}

/** The page-specific part of a document. */
export interface PageProps {
  title: string
  description: string
  /** The page's route, without the base; marks the current entry of the sidebar. */
  route: string
  /** The rendered body. */
  html: string
  headings: readonly Heading[]
}

/**
 * Runs before the first paint, so a reader who chose a theme never sees the other one flash.
 * With no choice it follows the system. The body is a constant string, not built from input.
 */
const THEME_SCRIPT = `(function(){document.documentElement.setAttribute('data-js','');try{var s=localStorage.getItem('tula-docs-theme');var t=s==='light'||s==='dark'?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`

/** The two background colours the browser's own chrome takes, one for each scheme. */
const THEME_COLORS = { light: '#FAF9F5', dark: '#141412' } as const

function NavList({ items, route, base }: { items: NavItem[]; route: string; base: string }) {
  return (
    <ul className='nav-list'>
      {items.map((item) => (
        <li key={item.route}>
          <a
            className='nav-link'
            href={`${base.replace(/\/$/, '')}${item.route}`}
            aria-current={item.route === route ? 'page' : undefined}
          >
            {item.label}
          </a>
          {item.children.length > 0 ? (
            <div className='nav-children'>
              <NavList items={item.children} route={route} base={base} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * The sidebar: the groups of the current tab, which come from `docs/README.md`. Below 1024 px
 * it is the drawer, and then also lists the tabs, which the header has no room for.
 *
 * @param props - The tabs, the current one, the current route and the base path.
 * @returns The sidebar's container with a navigation landmark inside.
 */
export function Sidebar({
  sections,
  active,
  route,
  base,
}: {
  sections: readonly Section[]
  active: Section | undefined
  route: string
  base: string
}) {
  const prefix = base.replace(/\/$/, '')
  return (
    <div
      id='sidebar'
      className='sidebar'
      data-open='false'
      data-drawer-only={active === undefined ? 'true' : undefined}
    >
      <nav aria-label='Documentation'>
        <ul className='drawer-sections'>
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`${prefix}${sectionHome(section)}`}
                aria-current={section.id === active?.id ? 'true' : undefined}
              >
                {section.label}
              </a>
            </li>
          ))}
        </ul>
        <a
          className='nav-link'
          href={`${prefix}/docs/`}
          aria-current={route === '/docs/' ? 'page' : undefined}
        >
          Overview
        </a>
        {(active?.groups ?? []).map((group) => (
          <div className='nav-group' key={group.title}>
            <h2 className='nav-group-title'>{group.title}</h2>
            <NavList items={group.items} route={route} base={base} />
          </div>
        ))}
      </nav>
    </div>
  )
}

/** The head's links to the icons, the manifest and the social card. */
function SiteIdentity({
  base,
  title,
  description,
}: {
  base: string
  title: string
  description: string
}) {
  const image = `${SITE_ORIGIN}${base}og.png`
  return (
    <>
      <link rel='icon' href={`${base}favicon.ico`} sizes='48x48' />
      <link rel='icon' href={`${base}favicon.svg`} type='image/svg+xml' sizes='any' />
      <link rel='apple-touch-icon' href={`${base}apple-touch-icon.png`} />
      <link rel='manifest' href={`${base}site.webmanifest`} />
      <meta name='theme-color' content={THEME_COLORS.light} media='(prefers-color-scheme: light)' />
      <meta name='theme-color' content={THEME_COLORS.dark} media='(prefers-color-scheme: dark)' />
      <meta property='og:site_name' content={SITE_NAME} />
      <meta property='og:type' content='website' />
      <meta property='og:title' content={title} />
      <meta property='og:description' content={description} />
      <meta property='og:image' content={image} />
      <meta property='og:image:width' content='1200' />
      <meta property='og:image:height' content='630' />
      <meta property='og:image:alt' content='Tula Auth: ink and paper, in balance' />
      <meta name='twitter:card' content='summary_large_image' />
      <meta name='twitter:title' content={title} />
      <meta name='twitter:description' content={description} />
      <meta name='twitter:image' content={image} />
    </>
  )
}

/**
 * A whole document: head, header, sidebar, the page, and the table of contents.
 *
 * @param props - The page and the build's frame. `children` replaces the article (the landing
 *   page and the 404 page), and then there is no column layout.
 * @returns The `<html>` element, to be rendered to static markup.
 */
export function Document({
  page,
  frame,
  children,
}: {
  page: PageProps
  frame: Frame
  children?: ReactNode
}) {
  const { base } = frame
  const release = frame.release ?? null
  const versionProps = release === null ? null : { release, base, route: page.route }
  const canonical = canonicalOf(release, base, page.route)
  const sections = buildSections(frame.nav)
  // The documentation index belongs to the first tab; the landing and 404 pages to none.
  const active =
    sectionOf(sections, page.route) ?? (page.route === '/docs/' ? sections[0] : undefined)
  // The island's script and stylesheet are for a page that holds a playground and no other.
  const playground = hasPlayground(page.html) ? frame.assets.playground : undefined
  const toc = page.headings.filter((heading) => heading.depth === 2)
  // The full playground page gives its width to the playground: wider than the prose, and no
  // table of contents column beside it (`WIDE_ROUTES`).
  const wide = WIDE_ROUTES.includes(page.route)
  const hasToc = children === undefined && toc.length > 1 && !wide
  const title = page.route === '/' ? page.title : `${page.title} · ${SITE_NAME}`
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1, viewport-fit=cover' />
        <meta name='color-scheme' content='light dark' />
        <title>{title}</title>
        <meta name='description' content={page.description} />
        {release?.channel === 'next' ? <meta name='robots' content='noindex' /> : null}
        {canonical === null ? null : <link rel='canonical' href={canonical} />}
        <SiteIdentity base={base} title={title} description={page.description} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script, no input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {(frame.assets.fonts ?? []).map((href) => (
          <link key={href} rel='preload' as='font' type='font/woff2' href={href} crossOrigin='' />
        ))}
        {frame.assets.css.map((href) => (
          <link key={href} rel='stylesheet' href={href} />
        ))}
        {frame.assets.js === '' ? null : <script type='module' src={frame.assets.js} />}
        {playground === undefined
          ? null
          : playground.css.map((href) => <link key={href} rel='stylesheet' href={href} />)}
        {playground === undefined ? null : <script type='module' src={playground.js} />}
        <meta name='docs-base' content={base} />
      </head>
      <body>
        <a href='#content' className='skip-link'>
          Skip to content
        </a>
        {/* Slot: a notice above the header (it scrolls away; the header stays). */}
        <div data-slot='banner'>
          {versionProps === null ? null : <VersionBanner {...versionProps} />}
        </div>
        <Header
          base={base}
          sections={sections}
          active={active?.id}
          version={versionProps === null ? null : <VersionMarker {...versionProps} />}
        />
        <div id='scrim' className='scrim' data-open='false' aria-hidden='true' />
        {children === undefined ? (
          <div className='shell layout' data-toc={hasToc ? '' : undefined}>
            <Sidebar sections={sections} active={active} route={page.route} base={base} />
            <main id='content' className='main' tabIndex={-1} data-wide={wide ? '' : undefined}>
              <div className='page-head'>
                {active === undefined ? null : <span className='page-eyebrow'>{active.label}</span>}
                {/* Slot: the page's actions (copy as Markdown and the like). */}
                <div className='page-actions' data-slot='page-actions' />
              </div>
              {hasToc ? (
                <details className='toc-mobile'>
                  <summary>
                    On this page
                    <ChevronDown aria-hidden='true' />
                  </summary>
                  <nav aria-label='Page contents'>
                    <ul className='toc-list'>
                      {toc.map((heading) => (
                        <li key={heading.id}>
                          <a href={`#${heading.id}`}>{heading.text}</a>
                        </li>
                      ))}
                    </ul>
                  </nav>
                </details>
              ) : null}
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the build's own render of docs/** */}
              <article className='doc' dangerouslySetInnerHTML={{ __html: page.html }} />
            </main>
            {hasToc ? (
              <aside className='toc'>
                <nav aria-label='On this page'>
                  <h2 className='toc-title'>On this page</h2>
                  <ul className='toc-list'>
                    {toc.map((heading) => (
                      <li key={heading.id}>
                        <a href={`#${heading.id}`}>{heading.text}</a>
                      </li>
                    ))}
                  </ul>
                </nav>
              </aside>
            ) : null}
          </div>
        ) : (
          <>
            <Sidebar sections={sections} active={undefined} route={page.route} base={base} />
            <main id='content' tabIndex={-1}>
              {children}
            </main>
          </>
        )}
      </body>
    </html>
  )
}
