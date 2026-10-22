import { describe, expect, test } from 'bun:test'
import { ERROR_CODES } from '@tula-tech/contract/error-codes'
import { areaId, buildErrorCodesPage, errorCodeEntries, escapeHtml } from './error-codes'

describe('the error-code page', () => {
  const entries = errorCodeEntries()
  const page = buildErrorCodesPage(entries)

  test('the page is cut into sections like a rendered page: the introduction, each area, each code', () => {
    const numbers = [...page.html.matchAll(/<div data-docs-section="(\d+)">/g)].map((m) => m[1])
    const areas = new Set(entries.map((entry) => entry.area)).size
    expect(numbers).toEqual(
      Array.from({ length: 1 + areas + entries.length }, (_, index) => String(index))
    )
    expect(page.html.match(/<\/div>/g)).toHaveLength(numbers.length)
    // Every h2 and h3 opens a section, and nothing is outside one.
    expect(page.html.match(/<div data-docs-section="\d+">\n<h[23] /g)).toHaveLength(
      areas + entries.length
    )
    expect(page.html.startsWith('<div data-docs-section="0">\n<h1')).toBe(true)
    expect(page.html.endsWith('</div>')).toBe(true)
  })

  test('lists every code the contract defines, in its order', () => {
    expect(entries.map((entry) => entry.code)).toEqual([...ERROR_CODES])
    expect(entries.length).toBeGreaterThan(60)
  })

  test('every code is an id on the page, and a section for the search', () => {
    for (const code of ERROR_CODES) {
      expect(page.html).toContain(`<h3 id="${code}">`)
      expect(page.headings.some((heading) => heading.id === code)).toBe(true)
      expect(page.sections.some((section) => section.id === code)).toBe(true)
    }
  })

  test('ids are unique, and an area never collides with a code', () => {
    const ids = [...page.html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(areaId('rate_limited')).toBe('area-rate_limited')
    expect(ERROR_CODES as readonly string[]).not.toContain(areaId('password'))
  })

  test('a code with no dot is listed under general', () => {
    expect(entries.find((entry) => entry.code === 'rate_limited')?.area).toBe('general')
    expect(entries.find((entry) => entry.code === 'password.too_short')?.area).toBe('password')
  })

  test('carries the status and the default message of each code', () => {
    expect(page.html).toContain('<p class="error-meta">HTTP 422</p>')
    expect(page.html).toContain('Password is too short.')
  })

  test('text from the contract is escaped', () => {
    const hostile = buildErrorCodesPage([
      { code: 'x.<b>', status: 400, message: '"quoted" & <script>', area: 'x' },
    ])
    expect(hostile.html).not.toContain('<script>')
    expect(hostile.html).not.toContain('<b>')
    expect(hostile.html).toContain('&lt;script&gt;')
    expect(escapeHtml('a&b<c>"d')).toBe('a&amp;b&lt;c&gt;&quot;d')
  })
})
