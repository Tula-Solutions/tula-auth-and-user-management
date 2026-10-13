import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registryTags } from './api-image'
import { type Manifest, RELEASED_PACKAGES } from './publish-manifest'

// The copy of a release on GitHub Packages (.github/workflows/github-packages.yml): the
// tarballs `bun run packages:check` wrote to `.release/`, the ones npm gets, published a
// second time to GitHub's npm registry so that they are listed on the repository's page.
//
// A COPY, UNDER ANOTHER NAME. GitHub's npm registry takes a package only under the scope of
// the account that owns it, so `@tula-tech/core` is `@tula-solutions/core` there and
// `create-tula` is `@tula-solutions/create-tula`. Nothing else changes: the files are the
// tarball's, and a copy's dependencies keep their `@tula-tech/*` names, which resolve from
// npm. npm stays the registry a project installs from, and every copy's README says so first.
//
// It is not the release: `scripts/packages.ts` is, and nothing here can reach npmjs.com (the
// registry is an argument of every upload, and a manifest that names another is refused).
// The decisions are pure functions, tested in `.claude/hooks/github-packages.test.ts`.

/** GitHub's npm registry: the only place this script uploads to. */
export const GITHUB_REGISTRY = 'https://npm.pkg.github.com'

/** The scope GitHub accepts from this repository: its owner's name. */
export const MIRROR_SCOPE = '@tula-solutions'

/** A release's version: plain, as the release script publishes it. */
const VERSION = /^\d+\.\d+\.\d+$/

/**
 * Whether a version is copied: a plain release, and never the unreleased `0.0.0`.
 *
 * A pre-release on `main` is left out with a line that says so, not refused: the copy is a
 * listing, and a run that failed for every alpha would only teach people to ignore it.
 *
 * @param version - The package's version.
 * @returns `true` for `0.1.1`, `false` for `0.2.0-alpha.1` and `0.0.0`.
 */
export function copiedVersion(version: string): boolean {
  return VERSION.test(version) && version !== '0.0.0'
}

/**
 * The name a released package has on GitHub Packages.
 *
 * @param name - The package's name on npm.
 * @returns `@tula-solutions/core` for `@tula-tech/core`, `@tula-solutions/create-tula` for `create-tula`.
 * @throws Error for any other name: only this repository's packages are copied.
 */
export function mirrorName(name: string): string {
  const match = /^(?:@tula-tech\/([a-z][a-z-]*)|(create-tula))$/.exec(name)
  if (match === null) {
    throw new Error(`"${name}" is not a package of this repository's release`)
  }
  return `${MIRROR_SCOPE}/${match[1] ?? match[2]}`
}

/**
 * The manifest of a copy: the packed manifest with the copy's name and GitHub's registry.
 *
 * @param packed - The `package.json` out of a release tarball.
 * @returns The same manifest under {@link mirrorName}, pinned to {@link GITHUB_REGISTRY}.
 * @throws Error when the manifest is private, is not at a plain version, or was packed with
 *   a registry of its own: none of those is a released package's tarball.
 */
export function mirrorManifest(packed: Manifest): Manifest {
  if (packed.private === true) {
    throw new Error(`${packed.name}: the packed manifest is private, so it was not released`)
  }
  if (!copiedVersion(packed.version)) {
    throw new Error(`${packed.name}: the version ${packed.version} is not a plain release (1.2.3)`)
  }
  if (packed.publishConfig !== undefined) {
    throw new Error(`${packed.name}: the packed manifest has a publishConfig of its own`)
  }
  return { ...packed, name: mirrorName(packed.name), publishConfig: { registry: GITHUB_REGISTRY } }
}

/**
 * A copy's README: the package's own, under a note that says where to install it from.
 *
 * @param name - The package's name on npm.
 * @param readme - The README from the tarball.
 * @returns The README a reader of the GitHub Packages page sees.
 */
export function mirrorReadme(name: string, readme: string): string {
  return [
    `> **This is a copy.** \`${mirrorName(name)}\` on GitHub Packages holds the same files as`,
    `> [\`${name}\` on npm](https://www.npmjs.com/package/${name}), which is the one to install:`,
    '> everything below, and every other Tula package, names it by its npm name.',
    '',
    readme,
  ].join('\n')
}

/**
 * The API path that lists a copy's versions.
 *
 * @param name - The package's name on npm.
 * @returns The path `gh api` is given.
 */
export function versionsPath(name: string): string {
  const [scope, bare] = mirrorName(name).split('/') as [string, string]
  return `/orgs/${scope.slice(1)}/packages/npm/${bare}/versions`
}

/**
 * The tarball `scripts/packages.ts` writes for a package.
 *
 * @param manifest - The package's name and version.
 * @returns The file's name inside `.release/`.
 */
export function tarballName(manifest: Pick<Manifest, 'name' | 'version'>): string {
  return `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
}

/**
 * The command that uploads one copy.
 *
 * @param directory - The unpacked, renamed package.
 * @returns An argument vector: the registry is named in it, whatever npm is configured with.
 */
export function uploadCommand(directory: string): string[] {
  return ['npm', 'publish', directory, '--registry', GITHUB_REGISTRY, '--access', 'public']
}

function run(command: string[], cwd: string): { exitCode: number | null; out: string } {
  const child = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 })
  return { exitCode: child.exitCode, out: `${child.stdout.toString()}${child.stderr.toString()}` }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--publish' && arg !== '--dry-run') || args.length > 1) {
    throw new Error('usage: bun run scripts/github-packages.ts [--dry-run | --publish]')
  }
  const publish = args[0] === '--publish'
  const root = join(import.meta.dir, '..')
  const work = await mkdtemp(join(tmpdir(), 'tula-github-packages-'))
  const say = (line: string) => process.stdout.write(`${publish ? '' : 'DRY RUN: '}${line}\n`)
  try {
    for (const dir of RELEASED_PACKAGES) {
      const source = (await Bun.file(join(root, dir, 'package.json')).json()) as Manifest
      const copy = `${mirrorName(source.name)}@${source.version}`
      if (!copiedVersion(source.version)) {
        say(`skip    ${copy} (only a plain version is copied)`)
        continue
      }
      const listed = Bun.spawnSync(
        ['gh', 'api', '--paginate', versionsPath(source.name), '--jq', '.[].name'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 }
      )
      // Thrown for anything but an answer or "no such package": a version is never
      // uploaded because the question about it went unanswered.
      const versions = registryTags({
        exitCode: listed.exitCode,
        stdout: listed.stdout.toString(),
        stderr: listed.stderr.toString(),
      })
      if (versions.includes(source.version)) {
        say(`skip    ${copy} (already on GitHub Packages)`)
        continue
      }
      const tarball = join(root, '.release', tarballName(source))
      if (!(await Bun.file(tarball).exists())) {
        throw new Error(`${tarball} is missing: run \`bun run packages:check\` first`)
      }
      const target = join(work, dir.replaceAll('/', '__'))
      await mkdir(target, { recursive: true })
      const unpacked = run(['tar', '-xzf', tarball, '-C', target], root)
      if (unpacked.exitCode !== 0) {
        throw new Error(`${tarball} could not be unpacked: ${unpacked.out.trim()}`)
      }
      const directory = join(target, 'package')
      const packed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
      if (packed.name !== source.name || packed.version !== source.version) {
        throw new Error(`${tarball} holds ${packed.name}@${packed.version}, not ${source.name}`)
      }
      await writeFile(
        join(directory, 'package.json'),
        `${JSON.stringify(mirrorManifest(packed), null, 2)}\n`
      )
      const readme = join(directory, 'README.md')
      await writeFile(readme, mirrorReadme(source.name, await readFile(readme, 'utf8')))
      if (!publish) {
        say(`publish ${copy}  from ${tarballName(source)}`)
        continue
      }
      const uploaded = run(uploadCommand(directory), directory)
      if (uploaded.exitCode !== 0) {
        throw new Error(
          `${copy} was not published (exit ${uploaded.exitCode}): ${uploaded.out.trim()}`
        )
      }
      say(`published ${copy}`)
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
