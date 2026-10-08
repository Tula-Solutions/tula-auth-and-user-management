import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import manifest from '../package.json'

const root = join(import.meta.dir, '..')

/** The subpaths that are code: everything but the JSON snapshot and the manifest itself. */
function modules(exports: Record<string, unknown>): string[] {
  return Object.keys(exports)
    .filter((subpath) => !subpath.endsWith('.json'))
    .sort()
}

/** `./error-codes` → `src/error-codes.ts`; `.` → `src/index.ts`. */
function sourceOf(subpath: string): string {
  return subpath === '.' ? 'src/index.ts' : `src/${subpath.slice(2)}.ts`
}

/** Every bare module specifier the entry point's code imports, directly or not. */
async function externalImports(entry: string): Promise<string[]> {
  const built = await Bun.build({
    entrypoints: [join(root, entry)],
    packages: 'external',
    target: 'browser',
  })
  expect(built.success).toBe(true)
  const code = (await built.outputs[0]?.text()) ?? ''
  return new Bun.Transpiler().scanImports(code).map((found) => found.path)
}

describe('the entry points of @tula/contract', () => {
  const subpaths = modules(manifest.exports)

  test('are the same in `exports`, `publishConfig.exports` and the build', async () => {
    expect(modules(manifest.publishConfig.exports)).toEqual(subpaths)
    // Loaded by path so that the build's configuration stays out of this package's typecheck.
    const build = (await import(join(root, 'bunup.config.ts'))) as { default: { entry: string[] } }
    expect([...build.default.entry].sort()).toEqual(subpaths.map(sourceOf).sort())
    for (const subpath of subpaths) {
      expect(manifest.exports[subpath as keyof typeof manifest.exports]).toBe(
        `./${sourceOf(subpath)}`
      )
    }
  })

  test('include the event type names', () => {
    expect(subpaths).toContain('./event-types')
  })

  // An SDK loads these at run time: one import of Zod here puts a schema library in every
  // application's bundle (AGENTS.md, "Publishable packages").
  test.each(subpaths.filter((subpath) => subpath !== '.'))(
    '%s imports no Zod and nothing else from outside the package',
    async (subpath) => {
      expect(await externalImports(sourceOf(subpath))).toEqual([])
    }
  )

  test('the index does import Zod: the check above can tell', async () => {
    expect(await externalImports('src/index.ts')).toContain('zod')
  })
})
