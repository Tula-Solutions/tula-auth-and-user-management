import { Menu, Moon, Search, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import type { Heading } from '~/lib/markdown'
import type { NavGroup, NavItem } from '~/lib/nav'

/** What a page needs from the build to be drawn. */
export interface Frame {
  /** The path the site is served under. */
  base: string
  /** The site's stylesheet and script, as the bundler named them. */
  assets: { css: string[]; js: string }
  nav: NavGroup[]
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
const THEME_SCRIPT = `(function(){try{var s=localStorage.getItem('tula-docs-theme');var t=s==='light'||s==='dark'?s:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`

function NavList({ items, route, base }: { items: NavItem[]; route: string; base: string }) {
  return (
    <ul className='m-0 list-none space-y-0.5 p-0'>
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
            <div className='ml-3 border-l pl-1'>
              <NavList items={item.children} route={route} base={base} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * The sidebar: the groups of `docs/README.md`.
 *
 * @param props - The groups, the current route and the base path.
 * @returns A navigation landmark.
 */
export function Sidebar({ nav, route, base }: { nav: NavGroup[]; route: string; base: string }) {
  return (
    <nav aria-label='Documentation' className='space-y-5 text-sm'>
      <a
        className='nav-link'
        href={`${base.replace(/\/$/, '')}/docs/`}
        aria-current={route === '/docs/' ? 'page' : undefined}
      >
        Overview
      </a>
      {nav.map((group) => (
        <div key={group.title}>
          <h2 className='mb-1 px-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'>
            {group.title}
          </h2>
          <NavList items={group.items} route={route} base={base} />
        </div>
      ))}
    </nav>
  )
}

function Header({ base }: { base: string }) {
  return (
    <header className='sticky top-0 z-40 border-b bg-background'>
      <div className='mx-auto flex h-14 max-w-[88rem] items-center gap-2 px-4'>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          id='menu-toggle'
          className='lg:hidden'
          aria-label='Menu'
          aria-expanded='false'
          aria-controls='sidebar'
        >
          <Menu aria-hidden='true' />
        </Button>
        <a
          href={base}
          className='mr-2 shrink-0 whitespace-nowrap font-semibold text-foreground no-underline'
        >
          Tula Auth <span className='hidden font-normal text-muted-foreground sm:inline'>docs</span>
        </a>
        <search className='relative ml-auto block w-full min-w-0 max-w-sm'>
          <label htmlFor='search-input' className='sr-only'>
            Search the documentation
          </label>
          <Search
            aria-hidden='true'
            className='pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground'
          />
          <Input
            id='search-input'
            type='search'
            placeholder='Search'
            autoComplete='off'
            spellCheck={false}
            aria-controls='search-results'
            className='pl-8'
          />
          <div
            id='search-panel'
            hidden
            className='absolute right-0 top-11 z-50 max-h-[70vh] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg'
          >
            <ul
              id='search-results'
              aria-label='Search results'
              className='search-results m-0 list-none p-0'
            />
          </div>
          <div id='search-status' role='status' className='sr-only' />
        </search>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          id='theme-toggle'
          aria-label='Dark theme'
          aria-pressed='false'
        >
          <Sun aria-hidden='true' className='hidden dark:block' />
          <Moon aria-hidden='true' className='dark:hidden' />
        </Button>
      </div>
    </header>
  )
}

/**
 * A whole document: head, header, sidebar, the page, and the table of contents.
 *
 * @param props - The page and the build's frame.
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
  const toc = page.headings.filter((heading) => heading.depth === 2)
  return (
    <html lang='en'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <meta name='color-scheme' content='light dark' />
        <title>{page.route === '/' ? page.title : `${page.title} · Tula Auth docs`}</title>
        <meta name='description' content={page.description} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant script, no input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {frame.assets.css.map((href) => (
          <link key={href} rel='stylesheet' href={href} />
        ))}
        {frame.assets.js === '' ? null : <script type='module' src={frame.assets.js} />}
        <meta name='docs-base' content={base} />
      </head>
      <body>
        <a href='#content' className='skip-link'>
          Skip to content
        </a>
        <Header base={base} />
        <div className='mx-auto flex max-w-[88rem] gap-8 px-4'>
          <div
            id='sidebar'
            data-open='false'
            className='fixed inset-x-0 bottom-0 top-14 z-30 hidden overflow-y-auto bg-background p-4 data-[open=true]:block lg:sticky lg:top-14 lg:block lg:h-[calc(100vh-3.5rem)] lg:w-64 lg:shrink-0 lg:self-start lg:p-0 lg:py-6'
          >
            <Sidebar nav={frame.nav} route={page.route} base={base} />
          </div>
          <main id='content' className='min-w-0 flex-1 py-8' tabIndex={-1}>
            {children ?? (
              // biome-ignore lint/security/noDangerouslySetInnerHtml: the build's own render of docs/**
              <article className='doc max-w-3xl' dangerouslySetInnerHTML={{ __html: page.html }} />
            )}
          </main>
          {toc.length > 1 ? (
            <div className='hidden w-56 shrink-0 self-start py-8 xl:sticky xl:top-14 xl:block xl:max-h-[calc(100vh-3.5rem)] xl:overflow-y-auto'>
              <nav aria-label='On this page' className='text-sm'>
                <h2 className='mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground'>
                  On this page
                </h2>
                <ul className='m-0 list-none space-y-1 p-0'>
                  {toc.map((heading) => (
                    <li key={heading.id}>
                      <a className='nav-link' href={`#${heading.id}`}>
                        {heading.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          ) : null}
        </div>
      </body>
    </html>
  )
}
