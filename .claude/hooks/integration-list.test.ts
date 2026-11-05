import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// CI runs integration tests only through each package's `test:integration` script, which names
// its files: a file left out of the list is never run anywhere (runtime-role.integration.ts was).
const root = join(import.meta.dir, '..', '..')

test('every *.integration.ts file is run by its package’s test:integration script', () => {
  const listed = Bun.spawnSync(['git', 'ls-files', '*.integration.ts'], {
    cwd: root,
    timeout: 10_000,
  })
  const files = listed.stdout.toString().trim().split('\n').filter(Boolean)
  expect(files.length).toBeGreaterThan(0)
  const orphans = files.filter((file) => {
    let dir = dirname(file)
    while (!Bun.file(join(root, dir, 'package.json')).size && dir !== '.') {
      dir = dirname(dir)
    }
    const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const script = pkg.scripts?.['test:integration'] ?? ''
    const own = relative(dir, file)
    // A glob of the file's own directory (`./src/*.integration.ts`) counts as naming it.
    const glob = `./${dirname(own)}/*.integration.ts`
    return !script.includes(`./${own}`) && !script.includes(glob)
  })
  expect(orphans).toEqual([])
})
