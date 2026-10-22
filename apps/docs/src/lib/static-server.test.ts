import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locate, serveStatic } from './static-server'

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

describe('serveStatic', () => {
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
