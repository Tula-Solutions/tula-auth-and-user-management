import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type Manifest, PUBLISHABLE_PACKAGES, publishManifest } from './publish-manifest'

// Builds, packs and checks the packages that will be published to npm, exactly as they would
// be published. Two modes:
//
//   bun run packages:check     build → stage → pack → publint → attw        (part of verify)
//   bun run release:dry-run    the same, then report what a release would publish
//
// NOTHING HERE PUBLISHES. The licence and the npm scope are undecided (docs/releasing.md), so
// this script has no code path that uploads a package: `release` ends by describing the
// tarballs. Publishing for real takes three deliberate edits, listed in docs/releasing.md:
// remove `"private": true` from the package, add a publish step here, and give the release
// workflow its npm credentials.

const root = resolve(import.meta.dir, '..')
/** Staging area: one directory per package holding exactly what its tarball contains. */
const outDir = join(root, '.release')

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) {
    process.stderr.write(`${stdout}${stderr}`)
    throw new Error(`\`${command.join(' ')}\` failed in ${cwd} (exit ${code})`)
  }
  return `${stdout}${stderr}`
}

async function readManifest(dir: string): Promise<Manifest> {
  return (await Bun.file(join(dir, 'package.json')).json()) as Manifest
}

interface Packed {
  name: string
  version: string
  private: boolean
  tarball: string
  files: number
}

async function stageAndPack(dir: string, versions: ReadonlyMap<string, string>): Promise<Packed> {
  const source = join(root, dir)
  const manifest = await readManifest(source)
  const staged = join(outDir, manifest.name.replace('/', '__'))

  await run(['bun', 'run', 'build'], source)
  await rm(staged, { recursive: true, force: true })
  await mkdir(staged, { recursive: true })
  for (const entry of [...(manifest.files ?? []), 'README.md', 'LICENSE']) {
    if (await exists(join(source, entry))) {
      await cp(join(source, entry), join(staged, entry), { recursive: true })
    }
  }
  await Bun.write(
    join(staged, 'package.json'),
    `${JSON.stringify(publishManifest(manifest, versions), null, 2)}\n`
  )

  await run(['bun', 'pm', 'pack', '--destination', outDir], staged)
  const tarball = join(
    outDir,
    `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
  )
  if (!(await Bun.file(tarball).exists())) {
    throw new Error(`expected ${tarball} after packing ${manifest.name}`)
  }
  const listing = await run(['tar', '-tzf', tarball], root)
  return {
    name: manifest.name,
    version: manifest.version,
    private: manifest.private === true,
    tarball,
    files: listing.trim().split('\n').length,
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function check(packed: Packed): Promise<void> {
  // publint: the manifest's entry points exist, have types, and follow npm's rules.
  await run(['bunx', 'publint', 'run', packed.tarball, '--strict'], root)
  // Are the types wrong: every entry point resolves to types under each module resolution
  // mode. The packages are ESM-only on purpose, so CommonJS `require` is out of scope.
  await run(['bunx', 'attw', packed.tarball, '--profile', 'esm-only', '--no-emoji'], root)
}

const mode = process.argv[2]
if (mode !== 'check' && mode !== 'release') {
  process.stderr.write('usage: bun run scripts/packages.ts <check|release>\n')
  process.exit(2)
}

const versions = new Map<string, string>()
for (const dir of PUBLISHABLE_PACKAGES) {
  const manifest = await readManifest(join(root, dir))
  versions.set(manifest.name, manifest.version)
}

await rm(outDir, { recursive: true, force: true })
const packages: Packed[] = []
for (const dir of PUBLISHABLE_PACKAGES) {
  const packed = await stageAndPack(dir, versions)
  await check(packed)
  packages.push(packed)
  process.stdout.write(
    `ok   ${packed.name}@${packed.version}: built, packed (${packed.files} files), publint and attw clean\n`
  )
}

if (mode === 'release') {
  for (const packed of packages) {
    process.stdout.write(
      `DRY RUN: would publish ${packed.name}@${packed.version} from ${packed.tarball.slice(root.length + 1)}` +
        `${packed.private ? ' (the package is still "private": npm would refuse it)' : ''}\n`
    )
  }
  process.stdout.write('DRY RUN: nothing was published. See docs/releasing.md.\n')
}
