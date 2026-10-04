import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGenerated } from './check-generated'

// `generate:check` runs in `verify` and in the Stop hook, on a working tree: whatever
// happens, it must leave the committed files as it found them.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tula-check-generated-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/a.gen.ts'), 'committed a\n')
  writeFileSync(join(root, 'src/b.gen.ts'), 'committed b\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const PATHS = ['src/a.gen.ts', 'src/b.gen.ts', 'src/c.gen.ts'] as const

function content(path: string): string | null {
  const file = join(root, path)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

describe('checkGenerated', () => {
  test('a generator that crashes half-way leaves the tree as it was', async () => {
    const crash = async () => {
      writeFileSync(join(root, 'src/a.gen.ts'), 'half-written')
      writeFileSync(join(root, 'src/c.gen.ts'), 'new file')
      throw new Error('orval failed')
    }
    expect(checkGenerated(root, PATHS, crash)).rejects.toThrow('orval failed')
    await Promise.resolve()
    await checkGenerated(root, PATHS, crash).catch(() => undefined)
    expect(content('src/a.gen.ts')).toBe('committed a\n')
    expect(content('src/b.gen.ts')).toBe('committed b\n')
    // A file the generator created and that was not there before is taken away again.
    expect(content('src/c.gen.ts')).toBeNull()
  })

  test('files that are out of date are named, and put back', async () => {
    const stale = await checkGenerated(root, PATHS, async () => {
      writeFileSync(join(root, 'src/b.gen.ts'), 'regenerated b\n')
      writeFileSync(join(root, 'src/c.gen.ts'), 'regenerated c\n')
    })
    expect(stale).toEqual(['src/b.gen.ts', 'src/c.gen.ts'])
    expect(content('src/b.gen.ts')).toBe('committed b\n')
    expect(content('src/c.gen.ts')).toBeNull()
  })

  test('up to date: nothing is named and nothing changes', async () => {
    const stale = await checkGenerated(root, PATHS, async () => {
      writeFileSync(join(root, 'src/a.gen.ts'), 'committed a\n')
    })
    expect(stale).toEqual([])
    expect(content('src/a.gen.ts')).toBe('committed a\n')
  })
})
