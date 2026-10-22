import '../styles.css'
import { type SearchEntry, search } from '../lib/search'

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

function initMenu(): void {
  const button = document.getElementById('menu-toggle')
  const sidebar = document.getElementById('sidebar')
  if (button === null || sidebar === null) {
    return
  }
  function set(open: boolean): void {
    sidebar?.setAttribute('data-open', String(open))
    button?.setAttribute('aria-expanded', String(open))
  }
  button.addEventListener('click', () => set(sidebar.getAttribute('data-open') !== 'true'))
  sidebar.addEventListener('click', (event) => {
    if ((event.target as Element).closest('a') !== null) {
      set(false)
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.getAttribute('data-open') === 'true') {
      set(false)
      button.focus()
    }
  })
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
        title.className = 'block text-sm font-medium'
        title.textContent = hit.t
        const where = document.createElement('span')
        where.className = 'block text-xs text-muted-foreground'
        where.textContent = hit.p
        link.append(title, where)
        item.append(link)
        return item
      })
    )
    if (hits.length === 0) {
      const none = document.createElement('li')
      none.className = 'px-3 py-2 text-sm text-muted-foreground'
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
    } else if (event.key === '/' && document.activeElement !== input) {
      const target = event.target as HTMLElement
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) {
        event.preventDefault()
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
initSearch()
