import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { directoryProblem, VENDORED, type Vendored, vendor } from './vendor'

// The copy of the native SDKs' sources, on trees made for the test. What it must never do
// is follow a symbolic link: as a source, a stranger's files would be in a published
// package; as a target, the copy and the removal before it would land somewhere else.

const made: string[] = []

async function tree(): Promise<{ repository: string; pack: string; elsewhere: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'tula-vendor-')))
  made.push(base)
  const repository = join(base, 'repository')
  const pack = join(base, 'package')
  const elsewhere = join(base, 'elsewhere')
  await mkdir(repository, { recursive: true })
  await mkdir(pack, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  return { repository, pack, elsewhere }
}

async function put(root: string, path: string, text = '// source\n'): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), text)
}

async function listed(root: string, prefix = ''): Promise<string[]> {
  const names = await readdir(join(root, prefix)).catch(() => [])
  const found: string[] = []
  for (const name of names.sort()) {
    const below = await listed(root, `${prefix}${name}/`)
    found.push(...(below.length > 0 ? below : [`${prefix}${name}`]))
  }
  return found
}

const ONE: readonly Vendored[] = [
  { from: 'native/swift/Sources/One', to: 'ios/vendor/One', extension: '.swift' },
  { from: 'native/android/two/src/main/kotlin', to: 'android/vendor/two', extension: '.kt' },
]

afterEach(async () => {
  for (const directory of made.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('what is copied', () => {
  test('the six directories of the two SDKs, by extension', () => {
    expect(VENDORED.map(({ from, to, extension }) => `${from} → ${to} (${extension})`)).toEqual([
      'native/swift/Sources/TulaAuth → ios/vendor/TulaAuth (.swift)',
      'native/swift/Sources/TulaAuthUI → ios/vendor/TulaAuthUI (.swift)',
      'native/android/tula-auth/src/main/kotlin → android/vendor/tula-auth (.kt)',
      'native/android/tula-auth-ui/src/main/kotlin → android/vendor/tula-auth-ui (.kt)',
      'native/android/tula-auth-android/src/main/kotlin → android/vendor/tula-auth-android (.kt)',
      'native/android/tula-auth-compose/src/main/kotlin → android/vendor/tula-auth-compose (.kt)',
    ])
  })

  test('only files of the one extension, and what was there before is replaced', async () => {
    const { repository, pack } = await tree()
    await put(repository, 'native/swift/Sources/One/A.swift')
    await put(repository, 'native/swift/Sources/One/Views/B.swift')
    await put(repository, 'native/swift/Sources/One/notes.md')
    await put(repository, 'native/android/two/src/main/kotlin/dev/C.kt')
    await put(repository, 'native/android/two/src/main/kotlin/dev/C.swift')
    await put(pack, 'ios/vendor/One/Stale.swift')

    expect(await vendor(repository, pack, ONE)).toBe(3)
    expect(await listed(pack)).toEqual([
      'android/vendor/two/dev/C.kt',
      'ios/vendor/One/A.swift',
      'ios/vendor/One/Views/B.swift',
    ])
  })
})

describe('a symbolic link is never followed', () => {
  // Each row puts one link in an otherwise good tree. Nothing may be copied, and the copy
  // that was in the package before the run must still be there: the roots are judged
  // before the first removal.
  const rows: [string, (t: Awaited<ReturnType<typeof tree>>) => Promise<void>, string][] = [
    [
      'the root of a source',
      async ({ repository, elsewhere }) => {
        await rm(join(repository, 'native/swift/Sources/One'), { recursive: true })
        await symlink(elsewhere, join(repository, 'native/swift/Sources/One'))
      },
      'vendor-native: native/swift/Sources/One is a symbolic link: nothing was copied',
    ],
    [
      'a directory above a source',
      async ({ repository, elsewhere }) => {
        await rm(join(repository, 'native/swift'), { recursive: true })
        await symlink(elsewhere, join(repository, 'native/swift'))
      },
      'vendor-native: native/swift is a symbolic link: nothing was copied',
    ],
    [
      'the root of a later source',
      async ({ repository, elsewhere }) => {
        await rm(join(repository, 'native/android/two/src/main/kotlin'), { recursive: true })
        await symlink(elsewhere, join(repository, 'native/android/two/src/main/kotlin'))
      },
      'vendor-native: native/android/two/src/main/kotlin is a symbolic link: nothing was copied',
    ],
    [
      'a file under a later source',
      async ({ repository, elsewhere }) => {
        await symlink(
          join(elsewhere, 'Stranger.kt'),
          join(repository, 'native/android/two/src/main/kotlin/Linked.kt')
        )
      },
      'vendor-native: native/android/two/src/main/kotlin/Linked.kt is a symbolic link',
    ],
    [
      'a directory above a target',
      async ({ pack, elsewhere }) => {
        await rm(join(pack, 'android'), { recursive: true, force: true })
        await symlink(elsewhere, join(pack, 'android'))
      },
      'vendor-native: android is a symbolic link: nothing was copied',
    ],
    [
      'the root of a target',
      async ({ pack, elsewhere }) => {
        await mkdir(join(pack, 'android/vendor'), { recursive: true })
        await symlink(elsewhere, join(pack, 'android/vendor/two'))
      },
      'vendor-native: android/vendor/two is a symbolic link: nothing was copied',
    ],
  ]

  test.each(rows)('%s', async (_name, link, sentence) => {
    const t = await tree()
    await put(t.repository, 'native/swift/Sources/One/A.swift')
    await put(t.repository, 'native/android/two/src/main/kotlin/C.kt')
    await put(t.elsewhere, 'Stranger.kt', '// a stranger\n')
    await put(t.elsewhere, 'Stranger.swift', '// a stranger\n')
    await put(t.pack, 'ios/vendor/One/Before.swift')
    await link(t)

    await expect(vendor(t.repository, t.pack, ONE)).rejects.toThrow(sentence)
    // The earlier copy is untouched, and nothing of the stranger's arrived or went.
    expect(await listed(join(t.pack, 'ios'))).toEqual(['vendor/One/Before.swift'])
    expect(await listed(t.elsewhere)).toEqual(['Stranger.kt', 'Stranger.swift'])
  })

  test('a source that is not there stops the run, as a link does', async () => {
    const { repository, pack } = await tree()
    await put(repository, 'native/swift/Sources/One/A.swift')
    await expect(vendor(repository, pack, ONE)).rejects.toThrow(
      'vendor-native: native/android does not exist: nothing was copied'
    )
    expect(await listed(pack)).toEqual([])
  })
})

describe('directoryProblem', () => {
  test('a path that climbs or names nothing is refused before anything is asked', async () => {
    const { repository } = await tree()
    for (const path of ['../outside', 'a//b', './a', 'a/..']) {
      expect(await directoryProblem(repository, path, false)).toBe(
        `${path} is not a path of plain names`
      )
    }
  })

  test('a file where a directory should be', async () => {
    const { repository } = await tree()
    await put(repository, 'native/file')
    expect(await directoryProblem(repository, 'native/file/below', true)).toBe(
      'native/file is not a directory'
    )
  })

  test('a real directory has no problem, and a target that is not there yet has none', async () => {
    const { repository } = await tree()
    await mkdir(join(repository, 'a/b'), { recursive: true })
    expect(await directoryProblem(repository, 'a/b', true)).toBeUndefined()
    expect(await directoryProblem(repository, 'a/b/c', false)).toBeUndefined()
  })
})
