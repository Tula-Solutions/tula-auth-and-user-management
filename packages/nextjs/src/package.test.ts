import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The built package, as it would be published: what each entry point's one file contains.

const root = join(import.meta.dir, '..')
// Inside the package and relative (bunup refuses anything else), and ignored by git.
const OUT_DIR = 'node_modules/.cache/tula-nextjs-build'
const out = join(root, OUT_DIR)
const built = (file: string) => Bun.file(join(out, file)).text()

beforeAll(async () => {
  const build = Bun.spawnSync(['bunx', 'bunup', '--out-dir', OUT_DIR, '--no-dts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    // `spawnSync` blocks the thread the runner's own timeout runs on.
    timeout: 60_000,
  })
  if (build.exitCode !== 0) {
    throw new Error(`bunup failed: ${build.stderr.toString()}`)
  }
  // `bunx` and then a build: more than the default five seconds of a hook on a slow runner.
}, 90_000)

afterAll(async () => {
  await rm(out, { recursive: true, force: true })
})

/** Markers of the server configuration: none may reach a file a browser loads. */
const SERVER_ONLY_MARKERS = ['secretKey', 'TULA_SECRET_KEY', 'tula_sk_', 'TULA_API_URL', 'jose']

describe('the built package', () => {
  test('has one file per entry point and no shared chunk', async () => {
    const files = (await readdir(out)).filter((file) => file.endsWith('.js')).sort()
    expect(files).toEqual(['handlers.js', 'index.js', 'middleware.js', 'server.js'])
  })

  test('the client entry starts with the use client directive', async () => {
    expect((await built('index.js')).trimStart().startsWith('"use client"')).toBe(true)
  })

  test('the client entry has no reference to the secret key or the server configuration', async () => {
    const code = await built('index.js')
    for (const marker of SERVER_ONLY_MARKERS) {
      expect(code).not.toContain(marker)
    }
    // And it imports none of the server entries.
    expect(code).not.toMatch(/from\s*["']\.\//)
    expect(code).not.toContain('next/headers')
    expect(code).not.toContain('server-only')
  })

  test('the server entry is guarded by server-only', async () => {
    const code = await built('server.js')
    expect(code).toMatch(/import\s*["']server-only["']/)
    expect(code.trimStart().startsWith('"use client"')).toBe(false)
  })

  test('the middleware and the handlers use no Node or Bun API and bring no schema library', async () => {
    for (const file of ['middleware.js', 'handlers.js']) {
      const code = await built(file)
      for (const marker of ['node:', 'require(', 'Bun.', 'Buffer.', 'ZodType', 'safeParse']) {
        expect(code).not.toContain(marker)
      }
      expect(code).not.toContain('"use client"')
      expect(code).not.toContain('next/headers')
    }
  })

  test('dependencies stay imports: nothing of Next.js, React, jose or Tula is bundled in', async () => {
    const code = await built('middleware.js')
    expect(code).toMatch(/from\s*["']next\/server["']/)
    expect(code).toMatch(/from\s*["']jose["']/)
    expect(code).toMatch(/from\s*["']@tula\/contract\/issuer["']/)
  })
})

describe('the sources of the client entry', () => {
  test.each(['index.ts', 'provider.tsx'])('%s is marked use client', async (file) => {
    const source = await Bun.file(join(import.meta.dir, file)).text()
    expect(source.startsWith("'use client'")).toBe(true)
  })

  test('paths.ts, which both halves import, reads no configuration', async () => {
    const source = await Bun.file(join(import.meta.dir, 'paths.ts')).text()
    expect(source).not.toMatch(/^import /m)
    expect(source).not.toContain('process')
  })
})
