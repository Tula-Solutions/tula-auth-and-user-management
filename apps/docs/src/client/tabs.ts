/**
 * The tabs of a page: `:::tabs` and `:::code-group` (`src/lib/blocks.ts`).
 *
 * The server writes every panel with its label above it, so a page with no script shows all of
 * them, in order. This function, which the page runs **inline, right after each group** so that
 * it is a set of tabs before the browser first paints it (no flash of the stacked panels), then
 *
 * - builds the tab list (`role="tablist"`, buttons that are `role="tab"`) and marks the panels
 *   `role="tabpanel"` with the ids that tie them together (the ARIA tabs pattern, with
 *   automatic activation: Left and Right Arrow, Home and End move the selection);
 * - selects the reader's saved choice, if the group has a `sync` key and a tab of that label,
 *   or else the first tab;
 * - keeps every group with the same `sync` key on a page, and every other open tab of the
 *   browser (the `storage` event), on the same label, and remembers it in `localStorage`
 *   (inside `try`: storage can be blocked, and the choice then lasts for the page).
 *
 * It must stay **self-contained**: `src/lib/tabs-runtime.ts` writes its source into the page
 * with `Function.prototype.toString`, so it can use nothing outside its own body. It is not
 * bundled into `main.ts` for the same reason: it has to run before the deferred bundle does.
 */
export function tabsRuntime(): void {
  const KEY = 'tula-docs-tabs'
  const w = window as unknown as { __docsTabs?: () => void }
  if (w.__docsTabs !== undefined) {
    w.__docsTabs()
    return
  }

  function read(): Record<string, string> {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || '{}')
      return value !== null && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  function write(sync: string, label: string): void {
    try {
      const all = read()
      all[sync] = label
      localStorage.setItem(KEY, JSON.stringify(all))
    } catch {
      // Storage can be blocked; the choice then lasts for this page only.
    }
  }

  function tabsOf(group: Element): HTMLElement[] {
    return Array.from(
      group.querySelectorAll<HTMLElement>(':scope > [role="tablist"] > [role="tab"]')
    )
  }

  function panelsOf(group: Element): HTMLElement[] {
    return Array.from(group.querySelectorAll<HTMLElement>(':scope > [role="tabpanel"]'))
  }

  /** Show the tab labelled `label` of a group; false when it has none. */
  function show(group: Element, label: string): boolean {
    const tabs = tabsOf(group)
    const at = tabs.findIndex((tab) => tab.getAttribute('data-label') === label)
    if (at === -1) {
      return false
    }
    const panels = panelsOf(group)
    tabs.forEach((tab, index) => {
      const selected = index === at
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      if (selected) {
        panels[index]?.removeAttribute('hidden')
      } else {
        panels[index]?.setAttribute('hidden', '')
      }
    })
    return true
  }

  /** Select a tab by the reader's action, and carry the choice to the groups that share it. */
  function choose(group: Element, label: string): void {
    const tabs = tabsOf(group)
    const anchor = tabs.find((tab) => tab.getAttribute('data-label') === label)
    const before = anchor?.getBoundingClientRect().top ?? 0
    show(group, label)
    const sync = group.getAttribute('data-sync')
    if (sync === null) {
      return
    }
    write(sync, label)
    for (const other of Array.from(document.querySelectorAll('[data-docs-tabs][data-ready]'))) {
      if (other !== group && other.getAttribute('data-sync') === sync) {
        show(other, label)
      }
    }
    // Groups above this one changed height: keep the tabs the reader pressed where they were.
    if (anchor !== undefined) {
      window.scrollBy(0, anchor.getBoundingClientRect().top - before)
    }
  }

  let counter = document.querySelectorAll('[data-docs-tabs][data-ready]').length

  function enhance(group: Element): void {
    const panels = Array.from(group.querySelectorAll<HTMLElement>(':scope > .docs-tab-panel'))
    if (panels.length === 0) {
      return
    }
    counter += 1
    const list = document.createElement('div')
    list.className = 'docs-tablist'
    list.setAttribute('role', 'tablist')
    panels.forEach((panel, index) => {
      const label = panel.getAttribute('data-label') || ''
      const tab = document.createElement('button')
      const id = `docs-tabs-${counter}-${index}`
      tab.type = 'button'
      tab.id = `${id}-tab`
      tab.className = 'docs-tab'
      tab.textContent = label
      tab.setAttribute('role', 'tab')
      tab.setAttribute('data-label', label)
      tab.setAttribute('aria-controls', `${id}-panel`)
      tab.setAttribute('aria-selected', 'false')
      tab.tabIndex = -1
      list.appendChild(tab)
      panel.id = `${id}-panel`
      panel.setAttribute('role', 'tabpanel')
      panel.setAttribute('aria-labelledby', tab.id)
      // A panel with nothing to focus in it is a stop of its own, so that a keyboard user
      // can reach its text and the scroll area of a wide table.
      if (
        panel.querySelector('a[href], button, input, select, textarea, pre, [tabindex]') === null
      ) {
        panel.tabIndex = 0
      }
    })
    group.insertBefore(list, group.firstChild)
    group.setAttribute('data-ready', '')
    const sync = group.getAttribute('data-sync')
    const saved = sync === null ? undefined : read()[sync]
    if (saved === undefined || !show(group, saved)) {
      show(group, panels[0]?.getAttribute('data-label') || '')
    }
  }

  function init(): void {
    for (const group of Array.from(
      document.querySelectorAll('[data-docs-tabs]:not([data-ready])')
    )) {
      enhance(group)
    }
  }

  document.addEventListener('click', (event) => {
    const tab = (event.target as Element).closest?.('[role="tab"]')
    const group = tab?.closest('[data-docs-tabs]')
    if (tab !== null && tab !== undefined && group !== null && group !== undefined) {
      choose(group, tab.getAttribute('data-label') || '')
    }
  })

  document.addEventListener('keydown', (event) => {
    const tab = (event.target as Element).closest?.('[role="tab"]')
    const group = tab?.closest('[data-docs-tabs]')
    if (tab === null || tab === undefined || group === null || group === undefined) {
      return
    }
    const tabs = tabsOf(group)
    const at = tabs.indexOf(tab as HTMLElement)
    let next = -1
    if (event.key === 'ArrowRight') {
      next = (at + 1) % tabs.length
    } else if (event.key === 'ArrowLeft') {
      next = (at - 1 + tabs.length) % tabs.length
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = tabs.length - 1
    }
    if (next !== -1) {
      event.preventDefault()
      tabs[next]?.focus()
      choose(group, tabs[next]?.getAttribute('data-label') || '')
    }
  })

  // Another tab of the browser changed the choice: follow it.
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) {
      return
    }
    const all = read()
    for (const group of Array.from(document.querySelectorAll('[data-docs-tabs][data-ready]'))) {
      const sync = group.getAttribute('data-sync')
      if (sync !== null && all[sync] !== undefined) {
        show(group, all[sync] as string)
      }
    }
  })

  w.__docsTabs = init
  init()
}
