import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveBase, resolveOutDir, resolveRepoRoot } from './paths'

const APP_ROOT = resolve(import.meta.dir, '../..')
const REPO = resolve(APP_ROOT, '../..')

describe('resolveOutDir', () => {
  test('unset, it is apps/docs/dist', () => {
    expect(resolveOutDir({})).toBe(join(APP_ROOT, 'dist'))
    expect(resolveOutDir({ DOCS_OUT_DIR: '' })).toBe(join(APP_ROOT, 'dist'))
  })

  test('a subdirectory of the temporary directory is accepted, existing or not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-paths-'))
    try {
      expect(resolveOutDir({ DOCS_OUT_DIR: dir })).toBe(resolveOutDir({ DOCS_OUT_DIR: dir }))
      expect(resolveOutDir({ DOCS_OUT_DIR: join(dir, 'not', 'yet') }).endsWith('not/yet')).toBe(
        true
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['the repository root', REPO],
    ['the root of the file system', '/'],
    ['the home directory', homedir()],
    ['the temporary directory itself', tmpdir()],
    ['a relative path', 'dist'],
    ['a relative path that climbs', '../../x'],
    ['a path that climbs out of the temporary directory', join(tmpdir(), '..', 'x')],
  ])('%s is refused', (_name, value) => {
    expect(() => resolveOutDir({ DOCS_OUT_DIR: value })).toThrow('DOCS_OUT_DIR')
  })

  test('a symbolic link in the temporary directory that leads out of it is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-paths-'))
    try {
      const outside = join(homedir(), '.docs-paths-never-created')
      expect(existsSync(outside)).toBe(false)
      const link = join(dir, 'link')
      Bun.spawnSync(['ln', '-s', homedir(), link], { timeout: 10_000 })
      expect(() => resolveOutDir({ DOCS_OUT_DIR: join(link, 'x') })).toThrow('DOCS_OUT_DIR')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a refusal deletes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-paths-'))
    try {
      mkdirSync(join(dir, 'keep'))
      writeFileSync(join(dir, 'keep/file.txt'), 'x')
      expect(() => resolveOutDir({ DOCS_OUT_DIR: 'keep' })).toThrow()
      expect(existsSync(join(dir, 'keep/file.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveRepoRoot', () => {
  test('unset, it is the repository', () => {
    expect(resolveRepoRoot({})).toBe(REPO)
  })

  test('the real repository root is accepted when named, a temporary directory too', () => {
    expect(resolveRepoRoot({ DOCS_REPO_ROOT: REPO })).toBe(REPO)
    const dir = mkdtempSync(join(tmpdir(), 'docs-paths-'))
    try {
      expect(
        resolveRepoRoot({ DOCS_REPO_ROOT: dir }).endsWith(dir.split('/').pop() as string)
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['the root of the file system', '/'],
    ['the home directory', homedir()],
    ['the temporary directory itself', tmpdir()],
    ['a relative path', 'repo'],
    ['a directory of the repository', join(REPO, 'docs')],
  ])('%s is refused', (_name, value) => {
    expect(() => resolveRepoRoot({ DOCS_REPO_ROOT: value })).toThrow('DOCS_REPO_ROOT')
  })
})

describe('resolveBase', () => {
  test('unset or empty, it is the root', () => {
    expect(resolveBase({})).toBe('/')
    expect(resolveBase({ DOCS_BASE: '' })).toBe('/')
  })

  test.each(['/', '/tula-auth-and-user-management/', '/docs/v1.2/', '/a/b_c/~d/'])(
    '%s is accepted as written',
    (value) => {
      expect(resolveBase({ DOCS_BASE: value })).toBe(value)
    }
  )

  test.each([
    ['no leading slash', 'tula-auth-and-user-management/'],
    ['no trailing slash', '/tula-auth-and-user-management'],
    ['no slash at all', 'docs'],
    ['a double slash', '//evil.example/'],
    ['an empty segment', '/a//b/'],
    ['a segment that climbs', '/a/../b/'],
    ['a segment of one dot', '/./'],
    ['a hidden segment', '/.git/'],
    ['a full address', 'https://example.com/'],
    ['a space', '/a b/'],
    ['a quote', '/a"b/'],
    ['an angle bracket', '/<script>/'],
    ['a percent escape', '/a%2e/'],
    ['a query', '/a?b/'],
    ['a fragment', '/a#b/'],
    ['a backslash', '/a\\b/'],
    ['a new line', '/a\n/'],
    ['a letter outside ASCII', '/é/'],
    ['a path that is far too long', `/${'a'.repeat(250)}/`],
  ])('%s is refused', (_name, value) => {
    expect(() => resolveBase({ DOCS_BASE: value })).toThrow('DOCS_BASE')
  })
})
