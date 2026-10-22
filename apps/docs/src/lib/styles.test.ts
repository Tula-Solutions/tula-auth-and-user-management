import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const CSS = readFileSync(join(ROOT, 'src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleOf(selector: string): string {
  const start = CSS.search(
    new RegExp(`(^|\\n)${selector.replace(/[.[\]()*+?^$|]/g, '\\$&')}\\s*\\{`)
  )
  expect(start, `a rule for ${selector}`).toBeGreaterThanOrEqual(0)
  const open = CSS.indexOf('{', start)
  return CSS.slice(open + 1, CSS.indexOf('}', open))
}

describe('the prose styles', () => {
  test('the page’s prose does not break a word anywhere (a long identifier broke mid-token)', () => {
    expect(ruleOf('.doc')).not.toContain('overflow-wrap: anywhere')
    expect(ruleOf('.doc')).toContain('overflow-wrap: break-word')
  })

  test('only a table cell may break anywhere', () => {
    const anywhere = CSS.split('}').filter((block) => block.includes('overflow-wrap: anywhere'))
    expect(anywhere).toHaveLength(1)
    expect(anywhere[0]).toContain('.doc td')
  })

  test('an inline code chip has a border, so that a bracket beside it does not look spaced', () => {
    const chip = ruleOf('.doc :not(pre) > code')
    expect(chip).toContain('border: 1px solid')
    expect(chip).toContain('box-decoration-break: clone')
  })

  test('an anchor lands under the header by `scroll-padding-top` alone: a heading’s own `scroll-margin-top` doubled it', () => {
    expect(CSS).toContain('scroll-padding-top: calc(var(--header-h) + 16px)')
    expect(CSS).not.toContain('scroll-margin-top')
  })

  test('prose is set at a fixed measure, never fluid', () => {
    expect(ruleOf('.main')).toContain('max-width: var(--prose)')
  })
})

describe('the shell', () => {
  test('the shell is at most 1480 px and the prose 720 px, whatever the screen', () => {
    expect(ruleOf('.shell')).toContain('max-width: var(--shell)')
    const tokens = readFileSync(join(ROOT, 'src/lib/design-tokens.ts'), 'utf8')
    expect(tokens).toContain('shell: 1480')
    expect(tokens).toContain('prose: 720')
  })

  test('motion is switched off for a reader who asks', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CSS).toContain('transition: none !important')
  })
})

describe('the identity files', () => {
  test('the favicon set, the manifest and the social card are in public/', () => {
    for (const file of [
      'favicon.ico',
      'favicon.svg',
      'favicon-32.png',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'site.webmanifest',
      'og.png',
    ]) {
      expect(existsSync(join(ROOT, 'public', file)), file).toBe(true)
    }
  })

  test('the social card is a 1200 by 630 PNG', () => {
    const png = readFileSync(join(ROOT, 'public/og.png'))
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
  })

  test('the vector favicon follows the reader’s colour scheme', () => {
    expect(readFileSync(join(ROOT, 'public/favicon.svg'), 'utf8')).toContain(
      'prefers-color-scheme: dark'
    )
  })

  test('the manifest’s addresses are relative, so that it works under any base path', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'public/site.webmanifest'), 'utf8')) as {
      start_url: string
      icons: { src: string }[]
    }
    expect(manifest.start_url).toBe('./')
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(false)
    }
  })
})

describe('the fonts', () => {
  test('Geist and Geist Mono are self-hosted with their licence, within the weight budget', () => {
    const fonts = ['geist-latin-wght-normal.woff2', 'geist-mono-latin-wght-normal.woff2']
    let total = 0
    for (const file of fonts) {
      total += statSync(join(ROOT, 'src/assets/fonts', file)).size
    }
    expect(total).toBeLessThan(60 * 1024)
    expect(readFileSync(join(ROOT, 'src/assets/fonts/OFL.txt'), 'utf8')).toContain(
      'SIL Open Font License'
    )
  })

  test('every face swaps, so that text shows before the font arrives', () => {
    const faces = CSS.match(/@font-face\s*\{[^}]*\}/g) ?? []
    const loaded = faces.filter((face) => face.includes('.woff2'))
    expect(loaded).toHaveLength(2)
    for (const face of loaded) {
      expect(face).toContain('font-display: swap')
    }
  })
})

describe('the content components', () => {
  test('the copy button is drawn only where the page has script', () => {
    expect(ruleOf(':root:not([data-js]) .doc .copy')).toContain('display: none')
  })

  test('tabs: without script every panel and its label show; with it the label and the hidden panels go', () => {
    expect(ruleOf('.doc .docs-tab-label')).not.toContain('display: none')
    expect(ruleOf('.doc .docs-tabs[data-ready] .docs-tab-label')).toContain('display: none')
    expect(ruleOf('.doc .docs-tab-panel[hidden]')).toContain('display: none')
  })

  test('code never wraps: a long line scrolls the block', () => {
    expect(ruleOf('.doc pre code')).toContain('white-space: pre')
    expect(ruleOf('.doc pre')).toContain('overflow-x: auto')
  })

  test('a changed line is told by a mark as well as a colour', () => {
    expect(ruleOf('.doc .code-frame .line.diff.add::before')).toContain('content: "+"')
    expect(ruleOf('.doc .code-frame .line.diff.remove::before')).toContain('content: "-"')
  })

  test('a callout is told by an icon and its word, not by its colour alone', () => {
    expect(ruleOf('.doc .callout-title::before')).toContain('content: ""')
    for (const kind of ['tip', 'important', 'warning', 'caution']) {
      expect(CSS).toContain(`.doc .callout[data-callout="${kind}"] .callout-title::before`)
    }
  })
})
