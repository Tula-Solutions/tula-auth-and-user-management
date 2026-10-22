import { Menu, Moon, Search, Sun } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '~/components/ui/button'
import { REPO_URL } from '~/lib/config'
import { type Section, sectionHome } from '~/lib/sections'
import { GitHubMark } from './icons'
import { LogoLockup, LogoMark } from './logo'

/**
 * The site's header: the logo, the section tabs, the search, the repository and the theme.
 *
 * `data-slot="version"` sits beside the logo and holds the version marker (the `version` prop).
 * The notice about the docs' version is a row above the bar, `data-slot="banner"`, drawn by the
 * layout: it scrolls away so that this sticky bar keeps the height `--header-h` names. Add to a
 * slot; do not restructure the bar.
 *
 * @param props - The base path, the tabs, the id of the current one and the version marker.
 * @returns The sticky `header` element.
 */
export function Header({
  base,
  sections,
  active,
  version,
}: {
  base: string
  sections: readonly Section[]
  active: string | undefined
  version?: ReactNode
}) {
  const prefix = base.replace(/\/$/, '')
  return (
    <header className='site-header' id='site-header' data-search='closed'>
      <div className='shell site-header__inner'>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          id='menu-toggle'
          className='icon-btn menu-btn'
          aria-label='Menu'
          aria-expanded='false'
          aria-controls='sidebar'
        >
          <Menu aria-hidden='true' />
        </Button>
        <a href={base} className='logo' aria-label='Tula Auth documentation, home'>
          <LogoLockup className='lockup' />
          <LogoMark className='mark' />
          <span className='docs-chip'>Docs</span>
        </a>
        {/* Slot: the version marker (the versioned deploy fills it). */}
        <div data-slot='version' className='header-slot'>
          {version}
        </div>
        <nav aria-label='Sections' className='tabs'>
          {sections.map((section) => (
            <a
              key={section.id}
              className='tab'
              href={`${prefix}${sectionHome(section)}`}
              aria-current={section.id === active ? 'true' : undefined}
              data-section={section.id}
            >
              {section.label}
            </a>
          ))}
        </nav>
        <div className='header-end'>
          <search className='search'>
            <label htmlFor='search-input' className='sr-only'>
              Search the documentation
            </label>
            <div className='search-field'>
              <Search aria-hidden='true' />
              <input
                id='search-input'
                className='search-input'
                type='search'
                placeholder='Search'
                autoComplete='off'
                spellCheck={false}
                aria-controls='search-results'
              />
              <span className='kbd-hint' id='search-hint' aria-hidden='true'>
                ⌘K
              </span>
            </div>
            <div id='search-panel' hidden className='search-panel'>
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
            id='search-toggle'
            className='icon-btn search-toggle'
            aria-label='Search'
            aria-expanded='false'
            aria-controls='search-input'
          >
            <Search aria-hidden='true' />
          </Button>
          <a className='icon-btn' href={REPO_URL} aria-label='Tula Auth on GitHub'>
            <GitHubMark />
          </a>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            id='theme-toggle'
            className='icon-btn'
            aria-label='Dark theme'
            aria-pressed='false'
          >
            <Sun aria-hidden='true' className='hidden dark:block' />
            <Moon aria-hidden='true' className='dark:hidden' />
          </Button>
        </div>
      </div>
    </header>
  )
}
