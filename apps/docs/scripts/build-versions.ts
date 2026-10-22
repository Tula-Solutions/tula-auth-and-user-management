import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBase, resolveOutDir } from '../src/lib/paths'
import { NEXT_SEGMENT } from '../src/lib/release'

// Builds the site the way it is deployed, from this one checkout: the docs of "the latest
// release" at the root (`dist/`) and the development docs under `dist/next/`. The browser tests
// serve the result, so that they open the version marker, the banner and `/next/` as a reader
// does. The deploy workflow builds the two from two checkouts instead (a release's own commit
// and `develop`), with the same variables; see `.github/workflows/docs-pages.yml`.
//
//   bun run build:versions     (DOCS_BASE as for `build`; the root is labelled with the contract package's version)

const root = join(import.meta.dir, '..')
const base = resolveBase()
// The release the root is labelled as: the version this checkout's packages carry.
const version = (
  (await Bun.file(join(root, '../../packages/contract/package.json')).json()) as {
    version: string
  }
).version
const outDir = resolveOutDir()

async function build(env: Record<string, string>): Promise<void> {
  const child = Bun.spawn(['bun', 'run', 'scripts/build.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
    timeout: 600_000,
  })
  if ((await child.exited) !== 0) {
    throw new Error(`the build failed for ${JSON.stringify(env)}`)
  }
}

// The development docs go to a temporary directory first: building the root empties `dist/`.
const staging = await mkdtemp(join(tmpdir(), 'docs-next-'))
try {
  await build({
    DOCS_BASE: `${base}${NEXT_SEGMENT}`,
    DOCS_CHANNEL: 'next',
    DOCS_VERSION: version,
    DOCS_OUT_DIR: staging,
  })
  await build({ DOCS_BASE: base, DOCS_CHANNEL: 'release', DOCS_VERSION: version })
  await cp(staging, join(outDir, NEXT_SEGMENT), { recursive: true })
} finally {
  await rm(staging, { recursive: true, force: true })
}
console.log(`docs site: released docs at ${base}, development docs at ${base}${NEXT_SEGMENT}`)
