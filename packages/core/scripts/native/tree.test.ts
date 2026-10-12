import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import fs, { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directoryProblems, readGenerated, syncGenerated } from './tree'

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

// A generated directory, or a directory above it, that is a symbolic link leads somewhere
// the generator was never told about: everything there would be a stray. Nothing is read,
// removed or written in either directory, in either mode.
describe('a generated directory that is not a real directory', () => {
  const BYSTANDERS = { 'notes.txt': 'mine\n', 'docs/y.md': '# mine\n', 'One.swift': '// old\n' }
  const RULE = 'a generated directory and every directory above it must be a real directory'

  /** Every file under a directory, by path from it, links not followed. */
  async function snapshot(directory: string, prefix = ''): Promise<Record<string, string>> {
    const found: Record<string, string> = {}
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        Object.assign(found, await snapshot(join(directory, entry.name), `${path}/`))
      } else if (entry.isSymbolicLink()) {
        found[path] = '<link>'
      } else {
        found[path] = await readFile(join(directory, entry.name), 'utf8')
      }
    }
    return found
  }

  /** A directory of someone's own files, outside the generated directories. */
  async function victim(root: string, under = ''): Promise<string> {
    const directory = join(root, 'victim')
    for (const [path, text] of Object.entries(BYSTANDERS)) {
      await mkdir(join(directory, under, path, '..'), { recursive: true })
      await writeFile(join(directory, under, path), text)
    }
    return directory
  }

  const cases: [string, (root: string) => Promise<void>, string][] = [
    [
      'the generated directory is a link',
      async (root) => {
        await mkdir(join(root, 'native/a'), { recursive: true })
        await symlink(await victim(root), join(root, 'native/a/Generated'))
      },
      'native/a/Generated is a symbolic link',
    ],
    [
      'a directory above it is a link',
      async (root) => {
        await mkdir(join(root, 'native'), { recursive: true })
        await symlink(await victim(root, 'Generated'), join(root, 'native/a'))
      },
      'native/a is a symbolic link',
    ],
    [
      'the second generated directory is a link',
      async (root) => {
        await mkdir(join(root, 'native/b'), { recursive: true })
        await symlink(await victim(root), join(root, 'native/b/generated'))
        // The first directory is real and out of date: it is left as it is too.
        await mkdir(join(root, 'native/a/Generated'), { recursive: true })
        await writeFile(join(root, 'native/a/Generated/One.swift'), '// edited\n')
        await writeFile(join(root, 'native/a/Generated/ByHand.swift'), 'x\n')
      },
      'native/b/generated is a symbolic link',
    ],
    [
      'a file is where a directory above it belongs',
      async (root) => {
        await mkdir(join(root, 'native'), { recursive: true })
        await writeFile(join(root, 'native/a'), 'a file\n')
        await victim(root)
      },
      'native/a is not a directory',
    ],
  ]

  test.each(cases)('%s: check reports it and changes nothing', async (_name, arrange, problem) => {
    const root = await tree({})
    await arrange(root)
    const before = await snapshot(root)
    expect(await check(root)).toEqual({ ok: false, lines: [`${problem}: ${RULE}`] })
    expect(await snapshot(root)).toEqual(before)
  })

  test.each(cases)(
    '%s: write refuses, and removes and writes nothing',
    async (_name, arrange, problem) => {
      const root = await tree({})
      await arrange(root)
      const before = await snapshot(root)
      await expect(write(root)).rejects.toThrow(`${problem}: ${RULE}`)
      expect(await snapshot(root)).toEqual(before)
      await expect(readGenerated(root, DIRECTORIES)).rejects.toThrow(problem)
    }
  )

  test('a repository root reached through a link is the caller’s own choice and is fine', async () => {
    const real = await tree()
    const holder = await tree({})
    await symlink(real, join(holder, 'repo'))
    const root = join(holder, 'repo')
    expect(await syncGenerated(root, DIRECTORIES, FILES, 'check')).toMatchObject({ ok: true })
    expect(await syncGenerated(root, DIRECTORIES, FILES, 'write')).toMatchObject({ ok: true })
  })

  test('a directory that resolves elsewhere than its name says is refused like a link', async () => {
    // What the walk part by part cannot see and the real path can. No test can arrange it on
    // every file system (a name in another case is one way), so the one call is stood in for.
    const root = await tree()
    const before = await snapshot(root)
    const real = fs.realpath
    const spy = spyOn(fs, 'realpath').mockImplementation((async (path: string) =>
      path === join(root, 'native/b/generated') ? join(root, 'elsewhere') : real(path)) as never)
    try {
      const problem = `native/b/generated is somewhere else than its name says: ${RULE}`
      expect(await directoryProblems(root, DIRECTORIES)).toEqual([problem])
      expect(await check(root)).toEqual({ ok: false, lines: [problem] })
      await expect(write(root)).rejects.toThrow(problem)
    } finally {
      spy.mockRestore()
    }
    expect(await snapshot(root)).toEqual(before)
  })

  test('a generated directory is a path of plain names', async () => {
    const root = await tree()
    for (const directory of ['native/../victim', 'native//a', './native/a', '/native/a']) {
      expect(await directoryProblems(root, [directory])).toEqual([
        `${directory} is not a path of plain names: ${RULE}`,
      ])
    }
  })

  test('a file system that cannot answer is an error, never "nothing there"', async () => {
    const root = await tree({ ...FILES, 'native/a/Generated/ByHand.swift': 'x\n' })
    const before = await snapshot(root)
    const refusal = Object.assign(new Error('refused'), { code: 'EACCES' })
    for (const call of ['lstat', 'readdir'] as const) {
      const spy = spyOn(fs, call).mockRejectedValue(refusal as never)
      try {
        await expect(check(root)).rejects.toThrow('refused')
        await expect(write(root)).rejects.toThrow('refused')
      } finally {
        spy.mockRestore()
      }
    }
    expect(await snapshot(root)).toEqual(before)
  })
})
