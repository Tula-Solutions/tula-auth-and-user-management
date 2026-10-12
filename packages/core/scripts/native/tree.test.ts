import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGenerated, syncGenerated } from './tree'

// What the command does to a directory tree, on a tree of its own: the two modes, and
// everything that can be in a generated directory besides the files the generator writes.

const DIRECTORIES = ['native/a/Generated', 'native/b/generated']
const FILES = {
  'native/a/Generated/One.swift': '// one\n',
  'native/a/Generated/Two.swift': '// two\n',
  'native/b/generated/One.kt': '// one\n',
}

const roots: string[] = []

async function tree(files: Record<string, string> = FILES): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tula-native-tree-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const check = (root: string) => syncGenerated(root, DIRECTORIES, FILES, 'check')
const write = (root: string) => syncGenerated(root, DIRECTORIES, FILES, 'write')

describe('a tree that is what the generator writes', () => {
  test('check passes and says how many files it looked at', async () => {
    expect(await check(await tree())).toEqual({
      ok: true,
      lines: ['3 generated native files are up to date'],
    })
  })

  test('write changes nothing and says so', async () => {
    const root = await tree()
    expect(await write(root)).toEqual({
      ok: true,
      lines: ['the generated native files were already up to date'],
    })
    expect(await readGenerated(root, DIRECTORIES)).toEqual(FILES)
  })
})

describe('a tree that is not', () => {
  test('nothing there yet: check names every file, write makes the directories', async () => {
    const root = await tree({})
    expect(await check(root)).toEqual({
      ok: false,
      lines: [
        'native/a/Generated/One.swift is missing',
        'native/a/Generated/Two.swift is missing',
        'native/b/generated/One.kt is missing',
        'run `bun run native:generate`',
      ],
    })
    expect(await readdir(root)).toEqual([])
    expect(await write(root)).toEqual({
      ok: true,
      lines: [
        'wrote native/a/Generated/One.swift',
        'wrote native/a/Generated/Two.swift',
        'wrote native/b/generated/One.kt',
      ],
    })
    expect(await check(root)).toMatchObject({ ok: true })
  })

  test('a file edited by hand: reported by check and left alone, rewritten by write', async () => {
    const root = await tree({ ...FILES, 'native/b/generated/One.kt': '// edited\n' })
    expect(await check(root)).toEqual({
      ok: false,
      lines: ['native/b/generated/One.kt is out of date', 'run `bun run native:generate`'],
    })
    expect(await readFile(join(root, 'native/b/generated/One.kt'), 'utf8')).toBe('// edited\n')
    expect(await write(root)).toEqual({ ok: true, lines: ['wrote native/b/generated/One.kt'] })
    expect(await readFile(join(root, 'native/b/generated/One.kt'), 'utf8')).toBe('// one\n')
  })

  test('a file the generator does not write, a .DS_Store among them, is a stray', async () => {
    const root = await tree({
      ...FILES,
      'native/a/Generated/ByHand.swift': 'let x = 1\n',
      'native/b/generated/.DS_Store': 'Bud1',
    })
    expect(await check(root)).toEqual({
      ok: false,
      lines: [
        'native/a/Generated/ByHand.swift is not a generated file',
        'native/b/generated/.DS_Store is not a generated file',
        'run `bun run native:generate`',
      ],
    })
    expect(await write(root)).toEqual({
      ok: true,
      lines: ['removed native/a/Generated/ByHand.swift', 'removed native/b/generated/.DS_Store'],
    })
    expect(await readGenerated(root, DIRECTORIES)).toEqual(FILES)
  })

  test('a directory in a generated directory is a stray, not a crash; write removes it whole', async () => {
    const root = await tree({ ...FILES, 'native/a/Generated/Extra/Deep/Inside.swift': 'x\n' })
    expect(await check(root)).toEqual({
      ok: false,
      lines: ['native/a/Generated/Extra is not a generated file', 'run `bun run native:generate`'],
    })
    // Check mode never changes the tree.
    expect(await readFile(join(root, 'native/a/Generated/Extra/Deep/Inside.swift'), 'utf8')).toBe(
      'x\n'
    )
    expect(await write(root)).toEqual({ ok: true, lines: ['removed native/a/Generated/Extra'] })
    expect((await readdir(join(root, 'native/a/Generated'))).sort()).toEqual([
      'One.swift',
      'Two.swift',
    ])
  })

  test('a directory where a generated file belongs: reported, then replaced by the file', async () => {
    const { 'native/a/Generated/One.swift': _one, ...rest } = FILES
    const root = await tree({ ...rest, 'native/a/Generated/One.swift/inside.txt': 'x\n' })
    expect(await check(root)).toEqual({
      ok: false,
      lines: ['native/a/Generated/One.swift is not a file', 'run `bun run native:generate`'],
    })
    expect(await write(root)).toEqual({
      ok: true,
      lines: ['removed native/a/Generated/One.swift', 'wrote native/a/Generated/One.swift'],
    })
    expect(await readGenerated(root, DIRECTORIES)).toEqual(FILES)
  })

  test('a symbolic link is never read or written through: it is removed, its target kept', async () => {
    const { 'native/b/generated/One.kt': _one, ...rest } = FILES
    const root = await tree({ ...rest, 'outside/target.kt': '// one\n' })
    await mkdir(join(root, 'native/b/generated'), { recursive: true })
    // The link's target holds exactly what the generator would write: still not a file.
    await symlink(join(root, 'outside/target.kt'), join(root, 'native/b/generated/One.kt'))
    await symlink(join(root, 'outside'), join(root, 'native/b/generated/Linked'))
    expect(await check(root)).toEqual({
      ok: false,
      lines: [
        'native/b/generated/Linked is not a generated file',
        'native/b/generated/One.kt is not a file',
        'run `bun run native:generate`',
      ],
    })
    expect(await write(root)).toEqual({
      ok: true,
      lines: [
        'removed native/b/generated/Linked',
        'removed native/b/generated/One.kt',
        'wrote native/b/generated/One.kt',
      ],
    })
    expect(await readFile(join(root, 'outside/target.kt'), 'utf8')).toBe('// one\n')
    expect(await readdir(join(root, 'outside'))).toEqual(['target.kt'])
    expect(await readGenerated(root, DIRECTORIES)).toEqual(FILES)
  })

  test('nothing outside the generated directories is read, reported or removed', async () => {
    const root = await tree({
      ...FILES,
      'native/a/Package.swift': 'by hand\n',
      'native/a/Tests/T.swift': 'by hand\n',
      'native/b/Client.kt': 'by hand\n',
    })
    expect(await check(root)).toMatchObject({ ok: true })
    expect(await write(root)).toMatchObject({ ok: true })
    expect(await readFile(join(root, 'native/a/Package.swift'), 'utf8')).toBe('by hand\n')
    expect(await readFile(join(root, 'native/b/Client.kt'), 'utf8')).toBe('by hand\n')
  })

  test('a generated file outside the directories it was told about is refused', async () => {
    const root = await tree({})
    await expect(
      syncGenerated(root, DIRECTORIES, { 'native/elsewhere/X.swift': 'x\n' }, 'write')
    ).rejects.toThrow('native/elsewhere/X.swift is not in a generated directory')
    await expect(
      syncGenerated(root, DIRECTORIES, { 'native/a/Generated/../../../X.swift': 'x\n' }, 'write')
    ).rejects.toThrow('is not in a generated directory')
    expect(await readdir(root)).toEqual([])
  })
})
