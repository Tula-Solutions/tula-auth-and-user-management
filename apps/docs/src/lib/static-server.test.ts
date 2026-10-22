import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locate, locateUnder, serveStatic } from './static-server'

let directory: string
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'docs-static-'))
  mkdirSync(join(directory, 'a'))
  mkdirSync(join(directory, 'empty'))
  writeFileSync(join(directory, 'index.html'), '<h1>home</h1>')
  writeFileSync(join(directory, 'a', 'index.html'), '<h1>a</h1>')
  writeFileSync(join(directory, '404.html'), '<h1>missing</h1>')
  writeFileSync(join(directory, 'file.txt'), 'plain')
  writeFileSync(join(directory, '..secret'), 'no')
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('locate', () => {
  test('a directory path ending in a slash is its index.html', () => {
    expect(locate(directory, '/')).toEqual({ file: join(directory, 'index.html') })
    expect(locate(directory, '/a/')).toEqual({ file: join(directory, 'a', 'index.html') })
  })

  test('a directory path without the slash is redirected to it', () => {
    expect(locate(directory, '/a')).toEqual({ redirect: '/a/' })
  })

  test('a file is itself, and a missing path or a directory with no index is nothing', () => {
    expect(locate(directory, '/file.txt')).toEqual({ file: join(directory, 'file.txt') })
    expect(locate(directory, '/nope')).toBeNull()
    expect(locate(directory, '/empty/')).toBeNull()
  })

  test.each(['/../etc/passwd', '/a/../../x', '/%2e%2e/%2e%2e/etc/passwd', '/%00', '/%E0%A4%A'])(
    'a path that leaves the directory or is malformed is nothing: %s',
    (path) => {
      expect(locate(directory, path)).toBeNull()
    }
  )
})

describe('locateUnder', () => {
  const BASE = '/tula-auth-and-user-management/'

  test('a path under the base is the file under the directory', () => {
    expect(locateUnder(directory, BASE, BASE)).toEqual({ file: join(directory, 'index.html') })
    expect(locateUnder(directory, `${BASE}a/`, BASE)).toEqual({
      file: join(directory, 'a', 'index.html'),
    })
    expect(locateUnder(directory, `${BASE}file.txt`, BASE)).toEqual({
      file: join(directory, 'file.txt'),
    })
  })

  test('a redirect keeps the base, and the base without its slash goes to the base', () => {
    expect(locateUnder(directory, `${BASE}a`, BASE)).toEqual({ redirect: `${BASE}a/` })
    expect(locateUnder(directory, '/tula-auth-and-user-management', BASE)).toEqual({
      redirect: BASE,
    })
  })

  test.each([
    '/',
    '/a/',
    '/file.txt',
    '/tula-auth-and-user-management-x/',
    `${BASE}../file.txt`,
    `${BASE}%2e%2e/%2e%2e/etc/passwd`,
  ])('a path outside the base, or that leaves it, is nothing: %s', (path) => {
    expect(locateUnder(directory, path, BASE)).toBeNull()
  })

  test('at the root it is locate itself', () => {
    expect(locateUnder(directory, '/a', '/')).toEqual({ redirect: '/a/' })
    expect(locateUnder(directory, '/a/', '/')).toEqual(locate(directory, '/a/'))
  })
})

describe('serveStatic', () => {
  test('serves under a base path, as GitHub Pages does', async () => {
    const server = serveStatic(directory, 0, '/docs-base/')
    try {
      const origin = `http://127.0.0.1:${server.port}`
      expect(await (await fetch(`${origin}/docs-base/a/`)).text()).toBe('<h1>a</h1>')
      const outside = await fetch(`${origin}/a/`)
      expect(outside.status).toBe(404)
      expect(await outside.text()).toBe('<h1>missing</h1>')
      const redirect = await fetch(`${origin}/docs-base/a`, { redirect: 'manual' })
      expect(redirect.headers.get('location')).toBe(`${origin}/docs-base/a/`)
    } finally {
      await server.stop(true)
    }
  })

  test('answers pages, the 404 page and redirects over HTTP', async () => {
    const server = serveStatic(directory, 0)
    try {
      const base = `http://127.0.0.1:${server.port}`
      expect(await (await fetch(`${base}/a/`)).text()).toBe('<h1>a</h1>')
      const missing = await fetch(`${base}/nope/`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toBe('<h1>missing</h1>')
      const redirect = await fetch(`${base}/a`, { redirect: 'manual' })
      expect(redirect.status).toBe(301)
      expect(redirect.headers.get('location')).toBe(`${base}/a/`)
    } finally {
      await server.stop(true)
    }
  })
})
