import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './config'
import { ERROR_CODES_SOURCE, issueLink, readableDate, sourceLink } from './page-source'
import { collectPages } from './pages'

const REPO = 'https://github.com/Tula-Solutions/tula-auth-and-user-management'

describe('sourceLink', () => {
  test('opens the editor on develop for a hand-written page', () => {
    expect(sourceLink('docs/methods/password.md')).toEqual({
      file: 'docs/methods/password.md',
      editable: true,
      href: `${REPO}/edit/develop/docs/methods/password.md`,
      label: 'Edit this page on GitHub',
    })
  })

  test('only shows a generated page’s file: an edit would be overwritten', () => {
    const link = sourceLink('docs/reference/core.md')
    expect(link.editable).toBe(false)
    expect(link.href).toBe(`${REPO}/blob/develop/docs/reference/core.md`)
    expect(link.label).toBe('View the source on GitHub')
  })

  test('points the error codes at the contract file they come from', () => {
    expect(sourceLink(null).href).toBe(`${REPO}/blob/develop/${ERROR_CODES_SOURCE}`)
  })

  test('names a real file for the error codes and for every page of docs/', () => {
    expect(existsSync(join(REPO_ROOT, ERROR_CODES_SOURCE))).toBe(true)
    for (const page of collectPages()) {
      expect(existsSync(join(REPO_ROOT, sourceLink(page.file).file)), page.file).toBe(true)
    }
  })
})

describe('readableDate', () => {
  test('writes a day, a short month and a year, with no zone', () => {
    expect(readableDate('2026-10-20')).toBe('20 Oct 2026')
    expect(readableDate('2026-01-05')).toBe('5 Jan 2026')
  })

  test('refuses anything that is not a date', () => {
    expect(readableDate('yesterday')).toBeUndefined()
    expect(readableDate('2026-13-01')).toBeUndefined()
  })
})

describe('issueLink', () => {
  test('opens a new issue that names the page, with nothing else of the reader’s', () => {
    const url = new URL(issueLink('Password & more', 'https://x.test/p/'))
    expect(url.origin + url.pathname).toBe(`${REPO}/issues/new`)
    expect(url.searchParams.get('title')).toBe('Docs: Password & more')
    expect(url.searchParams.get('body')).toContain('Page: https://x.test/p/')
    expect(url.searchParams.get('labels')).toBe('docs')
  })
})
