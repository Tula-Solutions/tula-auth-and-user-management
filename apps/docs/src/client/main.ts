import '../styles.css'
import { type SearchEntry, search } from '../lib/search'
import { initPage } from './page'

// The only script of the site. The pages are static HTML and work without it; it adds the theme
// toggle, the sidebar button on a narrow screen and the search. Everything it writes into the
// page is set with textContent or setAttribute: no search result is ever parsed as HTML.

const THEME_KEY = 'tula-docs-theme'

function storedTheme(): 'light' | 'dark' | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function systemTheme(): 'light' | 'dark' {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme)
  const toggle = document.getElementById('theme-toggle')
  toggle?.setAttribute('aria-pressed', String(theme === 'dark'))
}

function initTheme(): void {
  applyTheme(storedTheme() ?? systemTheme())
  // With no choice made the page keeps following the system.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (storedTheme() === null) {
      applyTheme(systemTheme())
    }
  })
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Storage can be blocked; the choice then lasts for this page only.
    }
    applyTheme(next)
  })
}

/** What can take focus inside a container. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** Sent by anything that takes the reader out of the drawer (the search shortcuts). */
const CLOSE_DRAWER = 'docs:close-drawer'

/** The viewport width from which the sidebar is a column and not a drawer. */
const DRAWER_BELOW = 1024

/**
 * The sidebar as a drawer on a narrow screen: the menu button opens it, focus stays inside it
 * (and on the button that closes it), the page behind is inert and does not scroll, and Escape,
 * the scrim, a followed link or a wider window close it and give focus back.
 */
function initMenu(): void {
  const button = document.getElementById('menu-toggle')
  const sidebar = document.getElementById('sidebar')
  const scrim = document.getElementById('scrim')
  if (button === null || sidebar === null) {
    return
  }
  const behind = [
    ...document.querySelectorAll<HTMLElement>('main, .toc, .landing, .header-end, .tabs'),
  ].filter((element) => !sidebar.contains(element))
  function isOpen(): boolean {
    return sidebar?.getAttribute('data-open') === 'true'
  }
  function set(open: boolean, restoreFocus = true): void {
    sidebar?.setAttribute('data-open', String(open))
    scrim?.setAttribute('data-open', String(open))
    button?.setAttribute('aria-expanded', String(open))
    document.documentElement.classList.toggle('drawer-open', open)
    for (const element of behind) {
      element.toggleAttribute('inert', open)
    }
    if (open) {
      sidebar?.querySelector<HTMLElement>('a[aria-current], a')?.focus()
    } else if (restoreFocus) {
      button?.focus()
    }
  }
  button.addEventListener('click', () => set(!isOpen()))
  // The search shortcuts leave the drawer first: the search is part of the page behind it.
  document.addEventListener(CLOSE_DRAWER, () => isOpen() && set(false, false))
  scrim?.addEventListener('click', () => set(false))
  sidebar.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a') !== null) {
      set(false, false)
    }
  })
  document.addEventListener('keydown', (event) => {
    if (!isOpen()) {
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      set(false)
    } else if (event.key === 'Tab') {
      // The drawer and the button that closes it are the only things that take focus.
      const stops = [button, ...sidebar.querySelectorAll<HTMLElement>(FOCUSABLE)]
      // Focus is moved by hand, so that it goes from the button into the drawer and round again
      // whatever else the header holds between them in the page's order.
      const at = stops.indexOf(document.activeElement as HTMLElement)
      const next = at === -1 ? 0 : (at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length
      event.preventDefault()
      stops[next]?.focus()
    }
  })
  // A window made wider than the drawer's breakpoint turns it into a column: nothing stays locked.
  matchMedia(`(min-width: ${DRAWER_BELOW}px)`).addEventListener('change', (event) => {
    if (event.matches && isOpen()) {
      set(false, false)
    }
  })
}

/** On a phone the search box is a row under the header, opened by its button. */
function setSearchRow(open: boolean): void {
  document.getElementById('site-header')?.setAttribute('data-search', open ? 'open' : 'closed')
  document.getElementById('search-toggle')?.setAttribute('aria-expanded', String(open))
}

function initSearchToggle(): void {
  const toggle = document.getElementById('search-toggle')
  const header = document.getElementById('site-header')
  const input = document.getElementById('search-input')
  if (toggle === null || header === null || input === null) {
    return
  }
  toggle.addEventListener('click', () => {
    const open = header.getAttribute('data-search') !== 'open'
    setSearchRow(open)
    if (open) {
      input.focus()
    }
  })
}

/** Shows the shortcut for the reader's platform: Command K on a Mac, Control K elsewhere. */
function initShortcutHint(): void {
  const hint = document.getElementById('search-hint')
  if (hint !== null && !/Mac|iPhone|iPad/.test(navigator.platform)) {
    hint.textContent = 'Ctrl K'
  }
}

function initSearch(): void {
  const input = document.getElementById('search-input') as HTMLInputElement | null
  const panel = document.getElementById('search-panel')
  const list = document.getElementById('search-results')
  const status = document.getElementById('search-status')
  if (input === null || panel === null || list === null || status === null) {
    return
  }
  const base = document.querySelector('meta[name="docs-base"]')?.getAttribute('content') ?? '/'
  let index: SearchEntry[] | null = null
  let loading: Promise<SearchEntry[]> | null = null

  function load(): Promise<SearchEntry[]> {
    loading ??= fetch(`${base}search-index.json`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`search index: ${response.status}`)
        }
        return response.json() as Promise<SearchEntry[]>
      })
      .then((entries) => {
        index = entries
        return entries
      })
    return loading
  }

  function close(): void {
    panel?.setAttribute('hidden', '')
    list?.replaceChildren()
  }

  function render(query: string): void {
    if (index === null || list === null || status === null) {
      return
    }
    if (query.trim() === '') {
      close()
      status.textContent = ''
      return
    }
    const hits = search(index, query)
    list.replaceChildren(
      ...hits.map((hit) => {
        const item = document.createElement('li')
        const link = document.createElement('a')
        link.href = hit.u
        const title = document.createElement('span')
        title.className = 'title'
        title.textContent = hit.t
        const where = document.createElement('span')
        where.className = 'where'
        where.textContent = hit.p
        link.append(title, where)
        item.append(link)
        return item
      })
    )
    if (hits.length === 0) {
      const none = document.createElement('li')
      none.className = 'search-none'
      none.textContent = 'No results'
      list.append(none)
    }
    panel?.removeAttribute('hidden')
    status.textContent = hits.length === 0 ? 'No results' : `${hits.length} results`
  }

  input.addEventListener('focus', () => {
    load().catch(() => {
      status.textContent = 'Search is not available'
    })
  })
  input.addEventListener('input', () => {
    load()
      .then(() => render(input.value))
      .catch(() => {
        status.textContent = 'Search is not available'
      })
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      list.querySelector<HTMLAnchorElement>('a')?.focus()
    } else if (event.key === 'Enter') {
      const first = list.querySelector<HTMLAnchorElement>('a')
      if (first !== null) {
        location.href = first.href
      }
    }
  })
  panel.addEventListener('keydown', (event) => {
    const links = [...list.querySelectorAll<HTMLAnchorElement>('a')]
    const at = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      links[Math.min(at + 1, links.length - 1)]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (at <= 0) {
        input.focus()
      } else {
        links[at - 1]?.focus()
      }
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hasAttribute('hidden')) {
      close()
      input.focus()
    } else if (
      event.key.toLowerCase() === 'k' &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey
    ) {
      // Command K (Control K elsewhere) is the search everywhere on the web docs.
      event.preventDefault()
      document.dispatchEvent(new Event(CLOSE_DRAWER))
      setSearchRow(true)
      input.focus()
      input.select()
    } else if (event.key === '/' && document.activeElement !== input) {
      const target = event.target as HTMLElement
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) {
        event.preventDefault()
        document.dispatchEvent(new Event(CLOSE_DRAWER))
        setSearchRow(true)
        input.focus()
      }
    }
  })
  document.addEventListener('click', (event) => {
    if (!(event.target as Element).closest('search')) {
      close()
    }
  })
}

initTheme()
initMenu()
initSearchToggle()
initShortcutHint()
initSearch()
initPage()
