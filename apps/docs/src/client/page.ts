import { activeHeading, MCP_SETUP, menuTarget } from '../lib/page-actions'

// What a page does once the script has loaded: copy its Markdown, run the actions menu, follow
// the reader's place in the table of contents, and take an answer to "Was this page helpful?".
// Every one of them has a working page without it (`components/page-anatomy.tsx`). Nothing here
// sends a request except the one that fetches the page's own Markdown twin, and nothing is kept.

/** How long "Copied" stays on the button. */
const COPIED_MS = 2000

function announce(root: Element, message: string): void {
  const status = root.querySelector('[data-status]')
  if (status !== null) {
    // Cleared first, so that the same message twice is announced twice.
    status.textContent = ''
    requestAnimationFrame(() => {
      status.textContent = message
    })
  }
}

function flash(button: HTMLElement, label: string, done: boolean): void {
  const text = button.querySelector('[data-label]')
  const original = button.getAttribute('data-original') ?? text?.textContent ?? ''
  button.setAttribute('data-original', original)
  button.toggleAttribute('data-done', done)
  if (text !== null) {
    text.textContent = label
  }
  window.setTimeout(() => {
    button.removeAttribute('data-done')
    if (text !== null) {
      text.textContent = original
    }
  }, COPIED_MS)
}

/**
 * Put text on the clipboard. Safari ends the permission to write when an `await` passes, so a
 * browser that has `ClipboardItem` is handed the promise of the text, which it waits for inside
 * the click.
 */
async function copyText(text: string | Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
    const blob = Promise.resolve(text).then((value) => new Blob([value], { type: 'text/plain' }))
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
    return
  }
  await navigator.clipboard.writeText(await text)
}

function initActions(): void {
  const root = document.querySelector<HTMLElement>('[data-page-actions]')
  const trigger = root?.querySelector<HTMLButtonElement>('.split-more[aria-haspopup]')
  const menu = root?.querySelector<HTMLElement>('[role="menu"]')
  const copy = root?.querySelector<HTMLButtonElement>('[data-action="copy"]')
  if (root === null || root === undefined || !trigger || !menu || !copy) {
    return
  }
  const twin = root.getAttribute('data-twin') ?? ''
  let cached: Promise<string> | null = null
  const markdown = (): Promise<string> => {
    cached ??= fetch(twin).then((response) => {
      if (!response.ok) {
        throw new Error(`${twin}: ${response.status}`)
      }
      return response.text()
    })
    // A failed fetch is tried again by the next click.
    cached.catch(() => {
      cached = null
    })
    return cached
  }

  async function run(
    button: HTMLElement | null,
    text: () => string | Promise<string>,
    said: string
  ) {
    try {
      await copyText(text())
      if (button !== null) {
        flash(button, 'Copied', true)
      }
      announce(root as Element, said)
    } catch {
      if (button !== null) {
        flash(button, 'Copy failed', false)
      }
      announce(root as Element, 'Copy failed. Use View as Markdown instead.')
    }
  }

  copy.addEventListener('click', () => {
    void run(copy, markdown, 'Page copied as Markdown')
  })

  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const isOpen = (): boolean => !menu.hasAttribute('hidden')
  function setOpen(open: boolean, focus: 'first' | 'last' | 'trigger' | 'none' = 'none'): void {
    menu?.toggleAttribute('hidden', !open)
    trigger?.setAttribute('aria-expanded', String(open))
    if (open) {
      items[focus === 'last' ? items.length - 1 : 0]?.focus()
    } else if (focus === 'trigger') {
      trigger?.focus()
    }
  }
  trigger.addEventListener('click', () => setOpen(!isOpen(), isOpen() ? 'none' : 'first'))
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true, event.key === 'ArrowUp' ? 'last' : 'first')
    }
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false, 'trigger')
    } else if (event.key === ' ' && document.activeElement instanceof HTMLAnchorElement) {
      // Space activates an item as Enter does; on a link it would scroll the page.
      event.preventDefault()
      document.activeElement.click()
    } else if (event.key === 'Tab') {
      // Tab leaves the menu where focus would have gone on: it closes and does not trap.
      setOpen(false)
    } else {
      const target = menuTarget(
        event.key,
        items.indexOf(document.activeElement as HTMLElement),
        items.length
      )
      if (target !== undefined) {
        event.preventDefault()
        items[target]?.focus()
      }
    }
  })
  document.addEventListener('click', (event) => {
    if (isOpen() && !root.contains(event.target as Node)) {
      setOpen(false)
    }
  })
  menu.addEventListener('click', (event) => {
    const item = (event.target as Element).closest<HTMLElement>('[role="menuitem"]')
    if (item === null) {
      return
    }
    if (item.getAttribute('data-action') === 'mcp') {
      void run(null, () => MCP_SETUP, 'MCP setup copied')
    }
    // Whatever the item did (a link has opened a tab), focus goes back to the button: the
    // focused item is about to be hidden.
    setOpen(false, 'trigger')
  })
}

/** The table of contents' entries (both rails) by heading id. */
function initToc(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.toc-list a[href^="#"]')]
  if (links.length === 0) {
    return
  }
  const headings = [
    ...new Set(links.map((link) => decodeURIComponent(link.hash.slice(1)))),
  ].flatMap((id) => {
    const element = document.getElementById(id)
    return element === null ? [] : [{ id, element }]
  })
  if (headings.length === 0) {
    return
  }
  const current = document.querySelector('[data-toc-current]')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  let shown = -1
  const rail = document.querySelector<HTMLElement>('.toc')

  function line(): number {
    const header = document.getElementById('site-header')
    return (header?.getBoundingClientRect().height ?? 0) + 24
  }

  function mark(index: number): void {
    if (index === shown) {
      return
    }
    shown = index
    const id = headings[index]?.id
    for (const link of links) {
      const on = decodeURIComponent(link.hash.slice(1)) === id
      if (on) {
        link.setAttribute('aria-current', 'location')
      } else {
        link.removeAttribute('aria-current')
      }
    }
    if (current !== null) {
      // The entry's own text: the heading's holds its permalink mark.
      current.textContent =
        links.find((link) => decodeURIComponent(link.hash.slice(1)) === id)?.textContent ?? ''
    }
    // Keep the lit entry in view in a rail that has its own scroll.
    const lit = rail?.querySelector<HTMLElement>('a[aria-current]')
    if (rail !== null && lit !== null && lit !== undefined) {
      const box = lit.getBoundingClientRect()
      const bounds = rail.getBoundingClientRect()
      // The rail is scrolled by hand: `scrollIntoView` would scroll the page too.
      const behavior = reduce.matches ? 'auto' : 'smooth'
      if (box.top < bounds.top) {
        rail.scrollTo({ top: rail.scrollTop - (bounds.top - box.top), behavior })
      } else if (box.bottom > bounds.bottom) {
        rail.scrollTo({ top: rail.scrollTop + (box.bottom - bounds.bottom), behavior })
      }
    }
  }

  function update(): void {
    // The bottom of the page lights the last entry, which a short last section never reaches.
    // A page that does not scroll is at its top, not its end.
    const atEnd =
      window.scrollY > 0 &&
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
    mark(
      atEnd
        ? headings.length - 1
        : activeHeading(
            headings.map((heading) => heading.element.getBoundingClientRect().top),
            line()
          )
    )
  }

  // One observer wakes the check when a heading crosses the band under the header; the check
  // itself reads the positions, so a fast scroll that skips a heading still lands right.
  const observer = new IntersectionObserver(update, {
    rootMargin: `-${Math.round(line())}px 0px -60% 0px`,
    threshold: [0, 1],
  })
  for (const heading of headings) {
    observer.observe(heading.element)
  }
  window.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true })
  window.addEventListener('hashchange', update)
  for (const link of links) {
    link.addEventListener('click', () => {
      const index = headings.findIndex(
        (heading) => `#${heading.id}` === decodeURIComponent(link.hash)
      )
      if (index !== -1) {
        mark(index)
      }
    })
  }
  update()
}

function initFeedback(): void {
  const root = document.querySelector<HTMLElement>('[data-feedback]')
  const thanks = root?.querySelector<HTMLElement>('[data-thanks]')
  const text = root?.querySelector<HTMLElement>('[data-thanks-text]')
  if (!root || !thanks || !text) {
    return
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-answer]')) {
    button.addEventListener('click', () => {
      text.textContent =
        button.getAttribute('data-answer') === 'yes'
          ? 'Thanks for the feedback.'
          : 'Sorry this fell short.'
      root.setAttribute('data-answered', '')
      thanks.removeAttribute('hidden')
      // The buttons are gone: focus goes to the answer, which a screen reader reads.
      thanks.focus()
    })
  }
}

/** Starts everything a page does with a script. */
export function initPage(): void {
  initActions()
  initToc()
  initFeedback()
}
