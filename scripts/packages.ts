import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  HELD_PACKAGES,
  leakedPackedFiles,
  type Manifest,
  missingPackedFiles,
  PUBLISHABLE_PACKAGES,
  privateStateProblems,
  publishManifest,
  RELEASED_PACKAGES,
  releaseState,
  stagedManifestProblems,
  unreleasedRuntimeDependencies,
} from './publish-manifest'
import {
  chooseChannel,
  type Fetcher,
  otpProblems,
  parseReleaseArgs,
  planRelease,
  printableCommand,
  refusals,
  registryStates,
  releaseReport,
  type StagedPackage,
  type TreeState,
  uploadCommands,
  uploadOrder,
} from './release'

// Builds, packs and checks the packages built for npm, exactly as they would be published,
// and publishes the released ones. Modes:
//
//   bun run packages:check     build → stage → pack → publint → attw          (part of verify)
//   bun run packages:states    only: is every package's `private` field what its state says
//   bun run release:dry-run    packages:check, then report what a release would publish
//   bun run release:publish    the same, then upload              (`release --publish`)
//   bun run release:publish --otp <code>    the same, handing the publish command a one-time
//                              password: for a session with no terminal to be asked in
//
// Eleven packages are built and checked (`PUBLISHABLE_PACKAGES`); the release publishes nine
// of them (`RELEASED_PACKAGES`) and holds two back (`HELD_PACKAGES`), which stay private.
//
// AN UPLOAD HAPPENS IN ONE PLACE, the loop at the end of `main`, over what `uploadCommands`
// (scripts/release.ts) returns: nothing without the explicit `--publish`, nothing while a
// single refusal stands, and only ever a staged tarball from `.release/`. The script holds
// no credential and reads none: the package manager it spawns uses its own login. A one-time
// password given as an argument is passed on to that command and written nowhere.
// docs/releasing.md is the runbook.

const root = resolve(import.meta.dir, '..')
/** Staging area: one directory per package holding exactly what its tarball contains. */
const outDir = join(root, '.release')

/** How long a package manager may take to upload one tarball, a person's second factor included. */
const UPLOAD_TIMEOUT_MS = 15 * 60_000

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

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Every workspace package (the root's `workspaces`), and the root itself. */
async function workspaceManifests(): Promise<{ dir: string; manifest: Manifest }[]> {
  const rootManifest = await readManifest(root)
  const found = [{ dir: '.', manifest: rootManifest }]
  for (const pattern of (rootManifest.workspaces as string[] | undefined) ?? []) {
    const group = pattern.replace(/\/\*$/, '')
    if (group === pattern) {
      throw new Error(`the workspace pattern ${pattern} is not of the form <directory>/*`)
    }
    for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
      const dir = `${group}/${entry.name}`
      if (entry.isDirectory() && (await exists(join(root, dir, 'package.json')))) {
        found.push({ dir, manifest: await readManifest(join(root, dir)) })
      }
    }
  }
  return found
}

interface Packed {
  dir: string
  name: string
  version: string
  tarball: string
  files: number
  bytes: number
  sha256: string
  /** `sha512-<base64>`: what the registry states as `dist.integrity` of a published tarball. */
  integrity: string
  /** The package.json read back out of the tarball: what npm would serve. */
  packed: Manifest
  /** Entry points that are not modules (a stylesheet): they have no types to check. */
  assets: string[]
}

/** The `exports` subpaths of a published manifest that point at a stylesheet. */
function assetEntryPoints(manifest: Manifest): string[] {
  const published = (manifest.publishConfig?.exports ?? {}) as Record<string, unknown>
  return Object.entries(published)
    .filter(([, target]) => typeof target === 'string' && target.endsWith('.css'))
    .map(([subpath]) => subpath.replace(/^\.\//, ''))
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

async function integrity(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha512')
  hasher.update(await Bun.file(path).arrayBuffer())
  return `sha512-${hasher.digest('base64')}`
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
  // One licence for the whole repository: a package without its own copy ships the root's.
  if (!(await exists(join(staged, 'LICENSE')))) {
    await cp(join(root, 'LICENSE'), join(staged, 'LICENSE'))
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
  const missing = missingPackedFiles(manifest.name, listing)
  if (missing.length > 0) {
    throw new Error(`${manifest.name}: the tarball does not hold ${missing.join(', ')}`)
  }
  const leaked = leakedPackedFiles(listing)
  if (leaked.length > 0) {
    throw new Error(`${manifest.name}: the tarball holds what must not ship: ${leaked.join(', ')}`)
  }
  return {
    dir,
    name: manifest.name,
    version: manifest.version,
    tarball,
    files: listing.trim().split('\n').length,
    bytes: Bun.file(tarball).size,
    sha256: await sha256(tarball),
    integrity: await integrity(tarball),
    // Read from the tarball, not from the staging directory: the tarball is what is uploaded.
    packed: JSON.parse(
      await run(['tar', '-xzOf', tarball, 'package/package.json'], root)
    ) as Manifest,
    assets: assetEntryPoints(manifest),
  }
}

async function check(packed: Packed): Promise<void> {
  // publint: the manifest's entry points exist, have types, and follow npm's rules.
  await run(['bunx', 'publint', 'run', packed.tarball, '--strict'], root)
  // Are the types wrong: every entry point resolves to types under each module resolution
  // mode. The packages are ESM-only on purpose, so CommonJS `require` is out of scope.
  // A stylesheet entry point resolves to no types by nature; publint above has already checked
  // that its file exists in the tarball.
  const skipped = packed.assets.length > 0 ? ['--exclude-entrypoints', ...packed.assets] : []
  await run(
    ['bunx', 'attw', packed.tarball, '--profile', 'esm-only', '--no-emoji', ...skipped],
    root
  )
}

/** The commit the tree is at and whether anything in it is uncommitted (untracked files count). */
async function treeState(): Promise<TreeState> {
  return {
    head: (await run(['git', 'rev-parse', 'HEAD'], root)).trim(),
    clean: (await run(['git', 'status', '--porcelain'], root)).trim() === '',
  }
}

/** What `npm --version` prints, or `null` where there is no npm. */
async function npmVersion(): Promise<string | null> {
  try {
    const child = Bun.spawn(['npm', '--version'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 30_000,
    })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return code === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}

/**
 * Fail unless every workspace package's `private` field is what its state says. It runs in
 * every mode, so `bun run verify` stops a package that became publishable by one edit.
 */
async function assertStates(print: boolean): Promise<void> {
  const workspace = await workspaceManifests()
  if (print) {
    for (const { dir, manifest } of workspace) {
      process.stdout.write(
        `${releaseState(dir).padEnd(8)} ${manifest.private === true ? 'private' : 'public '}  ${dir} (${manifest.name})\n`
      )
    }
  }
  const problems = privateStateProblems(workspace)
  if (problems.length > 0) {
    throw new Error(
      `a package's "private" field does not match its release state (scripts/publish-manifest.ts, docs/releasing.md):\n  ${problems.join('\n  ')}`
    )
  }
  const released = new Set(
    workspace
      .filter(({ dir }) => releaseState(dir) === 'released')
      .map((entry) => entry.manifest.name)
  )
  const names = new Set(workspace.map((entry) => entry.manifest.name))
  for (const { dir, manifest } of workspace) {
    if (releaseState(dir) !== 'released') {
      continue
    }
    const unreleased = unreleasedRuntimeDependencies(manifest, released, names)
    if (unreleased.length > 0) {
      throw new Error(
        `${manifest.name} is released and depends at run time on what is not: ${unreleased.join(', ')}. A consumer could not install it. Release the dependency too, or remove it.`
      )
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv
  if (mode !== 'check' && mode !== 'release' && mode !== 'states') {
    process.stderr.write(
      'usage: bun run scripts/packages.ts <check | states | release [--dry-run | --publish [--otp <code>]]>\n'
    )
    return 2
  }
  // Before anything is built: an argument that is not understood must never mean "default".
  const args = mode === 'release' ? parseReleaseArgs(rest) : { publish: false, otp: null }
  if (mode !== 'release' && rest.length > 0) {
    throw new Error(`${mode} takes no argument`)
  }

  await assertStates(mode === 'states')
  if (mode === 'states') {
    return 0
  }

  const before = mode === 'release' ? await treeState() : null

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
    const state = releaseState(dir)
    if (state === 'released') {
      const problems = stagedManifestProblems(packed.packed)
      if (problems.length > 0) {
        throw new Error(`the packed manifest cannot be published:\n  ${problems.join('\n  ')}`)
      }
    }
    packages.push(packed)
    process.stdout.write(
      `ok   ${packed.name}@${packed.version}: built, packed (${packed.files} files), publint and attw clean` +
        `${state === 'held' ? ' [held back: never published]' : ''}\n`
    )
  }

  if (before === null) {
    return 0
  }

  const staged: StagedPackage[] = uploadOrder(
    RELEASED_PACKAGES.map((dir) => {
      const packed = packages.find((entry) => entry.dir === dir)
      if (!packed) {
        throw new Error(`${dir} is released and was not packed`)
      }
      const { name, version, tarball, bytes, files, sha256: sum, packed: manifest } = packed
      return {
        name,
        version,
        tarball,
        bytes,
        files,
        sha256: sum,
        integrity: packed.integrity,
        manifest,
      }
    })
  )
  const after = await treeState()
  const channel = chooseChannel(
    process.env,
    process.env.GITHUB_ACTIONS === 'true' ? await npmVersion() : null
  )
  const plan = planRelease(
    staged,
    await registryStates(staged, fetch as unknown as Fetcher),
    channel,
    refusals({ packages: staged, before, after, problems: otpProblems(args, process.env) })
  )
  process.stdout.write(releaseReport(args, plan, { head: after.head, root }))
  process.stdout.write(
    `${args.publish ? 'RELEASE' : 'DRY RUN'}: held back, built and checked but not published: ${HELD_PACKAGES.map(
      (dir) => packages.find((entry) => entry.dir === dir)?.name ?? dir
    ).join(', ')}\n`
  )
  if (args.publish && plan.refusals.length > 0) {
    return 1
  }

  // Said when an upload fails; worked out here so that the loop itself never reads the code.
  const withNewCode =
    args.otp === null ? '' : ', with a new --otp code (one that was refused is used up or expired)'

  // THE ONLY UPLOAD. `uploadCommands` is empty for a dry run and for a refused run.
  const published: string[] = []
  for (const { pkg, command } of uploadCommands(args, plan, outDir)) {
    const now = await treeState()
    if (now.head !== before.head || !now.clean || (await sha256(pkg.tarball)) !== pkg.sha256) {
      throw new Error(
        `stopped before ${pkg.name}: the tree or the tarball changed since it was checked. Published in this run: ${published.join(', ') || 'nothing'}. Run it again from this commit: what is on the registry is compared and skipped.`
      )
    }
    process.stdout.write(
      `RELEASE: publishing ${pkg.name}@${pkg.version}: ${printableCommand(command)}\n`
    )
    // Without a code the terminal is the package manager's while it runs: it asks for the
    // second factor itself. With one it is given no input at all, so a code that is refused
    // (used up, or expired) ends the command instead of leaving it waiting for another.
    // Nothing it prints is captured, and nothing is passed to it but the tarball and flags.
    const child = Bun.spawn(command, {
      cwd: root,
      stdin: args.otp === null ? 'inherit' : 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
      timeout: UPLOAD_TIMEOUT_MS,
    })
    const code = await child.exited
    if (code !== 0) {
      throw new Error(
        `\`${printableCommand(command)}\` failed (exit ${code}). Published in this run: ${published.join(', ') || 'nothing'}. Fix the cause and run it again from this commit${withNewCode}: what is on the registry is compared and skipped.`
      )
    }
    published.push(`${pkg.name}@${pkg.version}`)
  }
  if (args.publish) {
    process.stdout.write(
      `RELEASE: published ${published.length} package${published.length === 1 ? '' : 's'}${published.length > 0 ? `: ${published.join(', ')}` : ' (everything was already on the registry)'}\n`
    )
  }
  return 0
}

try {
  process.exit(await main(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : 'unexpected failure'}\n`)
  process.exit(1)
}
