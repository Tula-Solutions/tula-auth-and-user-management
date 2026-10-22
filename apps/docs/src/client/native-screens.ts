// The native screens' gallery (`:::native-screens`, `src/lib/native-captures.ts`).
//
// The server writes a complete list of every capture, so a page with no script shows all of them.
// This turns that list into a picker: it shows the toolbar the server wrote hidden, then shows one
// screen, one step and one colour scheme at a time. It follows the ARIA tabs pattern for the
// screens (Left and Right Arrow, Home and End move the selection), toggle buttons for the steps,
// the scheme and the device frame, and it follows the site's theme until the reader picks one.
// Nothing it writes is parsed as HTML: it only sets attributes.

type Theme = 'light' | 'dark'

function siteTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

function enhance(root: HTMLElement): void {
  const toolbar = root.querySelector<HTMLElement>('.ns-toolbar')
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('.ns-toolbar [role="tab"]'))
  const panels = Array.from(root.querySelectorAll<HTMLElement>('.ns-panel'))
  if (toolbar === null || tabs.length === 0 || panels.length !== tabs.length) {
    return
  }
  toolbar.hidden = false

  function showStep(panel: HTMLElement, step: string): void {
    for (const item of Array.from(panel.querySelectorAll<HTMLElement>('.ns-shot'))) {
      item.hidden = item.getAttribute('data-step') !== step
    }
    for (const button of Array.from(panel.querySelectorAll<HTMLElement>('.ns-step'))) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-step') === step))
    }
  }

  function showScreen(index: number, focus: boolean): void {
    tabs.forEach((tab, at) => {
      const selected = at === index
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      const panel = panels[at] as HTMLElement
      panel.hidden = !selected
      if (selected && focus) {
        tab.focus()
      }
    })
  }

  function setTheme(theme: Theme): void {
    root.setAttribute('data-ns-theme', theme)
    for (const button of Array.from(root.querySelectorAll<HTMLElement>('[data-theme-choice]'))) {
      button.setAttribute(
        'aria-pressed',
        String(button.getAttribute('data-theme-choice') === theme)
      )
    }
  }

  function setFrame(on: boolean): void {
    root.setAttribute('data-ns-frame', on ? 'on' : 'off')
    root.querySelector('[data-frame-toggle]')?.setAttribute('aria-pressed', String(on))
  }

  for (const panel of panels) {
    const group = panel.querySelector<HTMLElement>('.ns-steps')
    const buttons = Array.from(panel.querySelectorAll<HTMLElement>('.ns-step'))
    // A screen with one step has nothing to choose.
    if (group !== null && buttons.length > 1) {
      group.hidden = false
    }
    const first = panel.querySelector<HTMLElement>('.ns-shot')?.getAttribute('data-step') ?? ''
    showStep(panel, first)
    for (const button of buttons) {
      button.addEventListener('click', () => {
        showStep(panel, button.getAttribute('data-step') ?? first)
      })
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => showScreen(index, false))
    tab.addEventListener('keydown', (event) => {
      const last = tabs.length - 1
      const next =
        event.key === 'ArrowRight'
          ? index === last
            ? 0
            : index + 1
          : event.key === 'ArrowLeft'
            ? index === 0
              ? last
              : index - 1
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? last
                : null
      if (next !== null) {
        event.preventDefault()
        showScreen(next, true)
      }
    })
  })

  for (const button of Array.from(root.querySelectorAll<HTMLElement>('[data-theme-choice]'))) {
    button.addEventListener('click', () => {
      setTheme(button.getAttribute('data-theme-choice') === 'dark' ? 'dark' : 'light')
    })
  }
  root.querySelector('[data-frame-toggle]')?.addEventListener('click', () => {
    setFrame(root.getAttribute('data-ns-frame') !== 'on')
  })

  // The gallery starts in the page's scheme and follows the header's toggle.
  new MutationObserver(() => setTheme(siteTheme())).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  setTheme(siteTheme())
  setFrame(true)
  showScreen(0, false)
  root.setAttribute('data-enhanced', '')
}

/** Turn every gallery of the page into a picker. */
export function initNativeScreens(): void {
  for (const root of Array.from(document.querySelectorAll<HTMLElement>('[data-native-screens]'))) {
    enhance(root)
  }
}
