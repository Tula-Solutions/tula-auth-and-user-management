import { basename, dirname, resolve } from 'node:path'
import type { Manifest } from './publish-manifest'

// The decisions of a release, as pure functions: what `scripts/packages.ts release` refuses,
// what it skips, which command uploads a tarball and what it prints first. Nothing here
// spawns a process, reads a file or touches the network by itself (the registry is asked
// through a `fetch` the caller passes), so every rule is unit-tested in
// `.claude/hooks/release.test.ts`.
//
// NO CREDENTIAL PASSES THROUGH THIS FILE OR ITS CALLER. The upload is done by a package
// manager's own command with that command's own login (`bun publish` on a person's machine,
// `npm publish` with GitHub's OIDC identity in the release workflow). The script never reads
// `.npmrc`, never takes a token or a one-time password as an argument, and looks at the
// environment only to ask WHETHER a variable is set, never for its value.

/** The npm dist-tag a release is published under. `latest` is never moved by this script. */
export const DIST_TAG = 'alpha'

/** The registry that is asked which versions exist. The upload goes where the CLI's own configuration says. */
export const REGISTRY = 'https://registry.npmjs.org'

/** The version every package has before `changeset version` has ever run: never published. */
export const UNRELEASED_VERSION = '0.0.0'

/** The first npm that can publish through trusted publishing (OIDC, no token). */
export const MIN_NPM_FOR_TRUSTED_PUBLISHING = '11.5.1'

/** A released package as it was staged and packed in this run. */
export interface StagedPackage {
  /** The package's name, e.g. `@tula/core`. */
  name: string
  /** The version being released. */
  version: string
  /** The tarball's absolute path, directly inside the staging directory. */
  tarball: string
  /** The tarball's size in bytes. */
  bytes: number
  /** How many files the tarball holds. */
  files: number
  /** The tarball's SHA-256, hex: what is uploaded is what was checked. */
  sha256: string
  /** The package.json read back out of the tarball. */
  manifest: Manifest
}

/** What `release` was asked to do. */
export interface ReleaseArgs {
  /** Upload for real. False is the dry run, which is the default. */
  publish: boolean
}

/**
 * Read the arguments after `release`. The dry run is the default and needs no flag; an
 * upload happens only with `--publish`, spelled out. Anything else is refused rather than
 * ignored, so that a typo (`--publsh`) is never read as "the default".
 *
 * @param argv - The arguments after the mode.
 * @returns Whether to upload.
 * @throws Error for an unknown argument, and for `--dry-run` together with `--publish`.
 */
export function parseReleaseArgs(argv: readonly string[]): ReleaseArgs {
  const unknown = argv.filter((argument) => argument !== '--dry-run' && argument !== '--publish')
  if (unknown.length > 0) {
    throw new Error(
      `unknown argument ${unknown.map((argument) => JSON.stringify(argument)).join(', ')}: release takes --dry-run (the default) or --publish`
    )
  }
  if (argv.includes('--dry-run') && argv.includes('--publish')) {
    throw new Error('--dry-run and --publish were both given: choose one')
  }
  return { publish: argv.includes('--publish') }
}

/**
 * Whether the packages are in an order that can be published one after another: a package
 * that depends on another of the release comes after it, so a run that stops half-way never
 * leaves a published package whose dependency does not exist.
 *
 * @param packages - The staged packages, in the order they would be published.
 * @returns One sentence a dependency that comes too late; none for a sound order.
 */
export function orderProblems(packages: readonly StagedPackage[]): string[] {
  const position = new Map(packages.map((pkg, index) => [pkg.name, index]))
  const problems: string[] = []
  packages.forEach((pkg, index) => {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(pkg.manifest[field] ?? {})) {
        const at = position.get(name)
        if (at !== undefined && at >= index) {
          problems.push(`${pkg.name} depends on ${name}, which would be published after it`)
        }
      }
    }
  })
  return problems
}

/** The commit the working tree is at, and whether it has anything uncommitted. */
export interface TreeState {
  /** `git rev-parse HEAD`. */
  head: string
  /** Whether `git status --porcelain` printed nothing. */
  clean: boolean
}

/**
 * Why this run must not upload. Every reason is listed, not only the first, so that a dry
 * run tells a person all of what stands between them and a release.
 *
 * @param input - The staged packages in publish order, the tree before the build and after
 *   it, and problems found elsewhere (the manifests' `private` fields, the tarballs).
 * @returns The reasons; none when the run may upload.
 */
export function refusals(input: {
  packages: readonly StagedPackage[]
  before: TreeState
  after: TreeState
  problems?: readonly string[]
}): string[] {
  const { packages, before, after } = input
  const reasons: string[] = [...(input.problems ?? [])]
  if (packages.length === 0) {
    reasons.push('there is no package to release')
  }
  const versions = [...new Set(packages.map((pkg) => pkg.version))]
  if (versions.length > 1) {
    reasons.push(
      `the released packages are a fixed group and must share one version, not ${versions.join(', ')}`
    )
  }
  for (const version of versions) {
    if (version === UNRELEASED_VERSION) {
      reasons.push(
        `the version is ${UNRELEASED_VERSION}: run \`bunx changeset version\` on the release branch first`
      )
    } else if (!new RegExp(`^\\d+\\.\\d+\\.\\d+-${DIST_TAG}\\.\\d+$`).test(version)) {
      reasons.push(
        `the version ${version} is not an ${DIST_TAG} prerelease, and this script publishes under the dist-tag "${DIST_TAG}" only`
      )
    }
  }
  if (!before.clean) {
    reasons.push('the git tree had uncommitted changes when the build started')
  }
  if (!after.clean) {
    reasons.push('the git tree has uncommitted changes after the build')
  }
  if (before.head !== after.head) {
    reasons.push(
      `HEAD moved during the run (${before.head.slice(0, 12)} → ${after.head.slice(0, 12)}): the tarballs are not of the current commit`
    )
  }
  for (const pkg of packages) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const [name, range] of Object.entries(pkg.manifest[field] ?? {})) {
        const sibling = packages.find((other) => other.name === name)
        if (sibling && range.replace(/^[\^~]/, '') !== sibling.version) {
          reasons.push(
            `${pkg.name} asks for ${name}@${range}, and this release publishes ${sibling.version}`
          )
        }
      }
    }
  }
  reasons.push(...orderProblems(packages))
  return reasons
}

/** Whether a version of a package is on the registry; `unknown` when the registry did not say. */
export type RegistryState = 'published' | 'absent' | 'unknown'

/**
 * The address that answers whether one version of a package exists: 200 when it does, 404
 * when it does not. A scoped name keeps its `@` and has its slash encoded.
 *
 * @param name - The package's name.
 * @param version - The version.
 * @returns The URL of a plain, unauthenticated GET.
 */
export function registryUrl(name: string, version: string): string {
  return `${REGISTRY}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`
}

/** As much of `fetch` as the registry check uses, so a test can pass its own. */
export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }
) => Promise<{ status: number }>

/**
 * Ask the registry which of the packages' versions already exist, so that a run that failed
 * half-way can be run again: what is there is skipped. The request carries no credential
 * (a plain GET of public metadata), follows no redirect and has a deadline. Only 200 means
 * "published" and only 404 "absent"; anything else, a failure included, is `unknown`, which
 * an upload refuses to guess about.
 *
 * @param packages - The staged packages.
 * @param fetcher - `fetch`, or a test's stand-in.
 * @param timeoutMs - The deadline of each request.
 * @returns Each package's name with what the registry said.
 */
export async function registryStates(
  packages: readonly StagedPackage[],
  fetcher: Fetcher,
  timeoutMs = 15_000
): Promise<Map<string, RegistryState>> {
  const states = new Map<string, RegistryState>()
  for (const pkg of packages) {
    let state: RegistryState = 'unknown'
    try {
      const response = await fetcher(registryUrl(pkg.name, pkg.version), {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      state = response.status === 200 ? 'published' : response.status === 404 ? 'absent' : 'unknown'
    } catch {
      // No answer is not "absent": the caller decides what an unknown stops.
    }
    states.set(pkg.name, state)
  }
  return states
}

/** The command line that uploads, and why it is that one. */
export interface Channel {
  /**
   * `bun` on a person's machine. `npm` in the release workflow, the one exception to the
   * repository's Bun-only rule: `bun publish` (1.4) has no provenance and no trusted
   * publishing, and npm's needs npm itself (docs/releasing.md, "Which CLI uploads").
   */
  cli: 'bun' | 'npm'
  /** Whether the upload carries a provenance attestation. */
  provenance: boolean
  /** A sentence for the report. */
  note: string
  /** Why this environment must not upload at all; none when it may. */
  problems: string[]
}

/** Whether a variable is set to something. The value itself is never kept, compared or printed. */
function isSet(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  return (env[name] ?? '') !== ''
}

/**
 * Choose how to upload from where the script runs. In GitHub Actions with an OIDC identity
 * (`id-token: write`) it is npm with `--provenance`, authenticated by trusted publishing:
 * no token exists. Anywhere else it is `bun publish` with the login of whoever runs it, and
 * no provenance, which cannot be made outside a supported CI.
 *
 * It refuses two things outright: a GitHub Actions job without the OIDC identity (it could
 * only publish with a long-lived token, which this release does not use), and one that has
 * such a token in its environment anyway.
 *
 * @param env - The process's environment. Only the presence of five variables is looked at.
 * @param npmVersion - What `npm --version` printed, or `null` when npm is not there. Only
 *   read when npm is the CLI.
 * @returns The CLI, whether provenance is attached, and anything that forbids the upload.
 */
export function chooseChannel(
  env: Readonly<Record<string, string | undefined>>,
  npmVersion: string | null
): Channel {
  if (env.GITHUB_ACTIONS !== 'true') {
    return {
      cli: 'bun',
      provenance: false,
      note: 'bun publish, with the login of this machine and WITHOUT provenance: an attestation can only be made in the release workflow (GitHub Actions with id-token: write).',
      problems: [],
    }
  }
  const problems: string[] = []
  const oidc =
    isSet(env, 'ACTIONS_ID_TOKEN_REQUEST_URL') && isSet(env, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN')
  if (!oidc) {
    problems.push(
      'this GitHub Actions job has no OIDC identity (permissions: id-token: write): trusted publishing is the only way this workflow uploads'
    )
  }
  for (const name of ['NPM_TOKEN', 'NODE_AUTH_TOKEN']) {
    if (isSet(env, name)) {
      problems.push(
        `${name} is set: the workflow publishes through trusted publishing and must hold no long-lived token`
      )
    }
  }
  if (npmVersion === null) {
    problems.push('npm is not installed in this job')
  } else if (!atLeast(npmVersion, MIN_NPM_FOR_TRUSTED_PUBLISHING)) {
    problems.push(
      `npm ${npmVersion} is older than ${MIN_NPM_FOR_TRUSTED_PUBLISHING}, the first that can publish through trusted publishing`
    )
  }
  return {
    cli: 'npm',
    provenance: oidc,
    note: 'npm publish with --provenance, authenticated by npm trusted publishing (GitHub OIDC): no token.',
    problems,
  }
}

/** Whether a `major.minor.patch` version is at least another. Anything unreadable is not. */
function atLeast(version: string, minimum: string): boolean {
  const parse = (text: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(text.trim())?.slice(1).map(Number)
  const [have, need] = [parse(version), parse(minimum)]
  if (!have || !need) {
    return false
  }
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) {
      return (have[index] as number) > (need[index] as number)
    }
  }
  return true
}

/**
 * The command that uploads one package: always a staged tarball, never a package directory.
 * A package's own directory has the repository's manifest, whose `exports` point at
 * TypeScript sources that are not in `files`; only the staged tarball is what was checked.
 *
 * @param pkg - The staged package.
 * @param stagingDir - The staging directory (`.release`), absolute.
 * @param channel - Which CLI uploads, and whether with provenance.
 * @returns The argument vector: the CLI, `publish`, the tarball, `--access public` and the
 *   dist-tag, and `--provenance` where the channel has it.
 * @throws Error when the path is not a `.tgz` directly inside the staging directory.
 */
export function publishCommand(pkg: StagedPackage, stagingDir: string, channel: Channel): string[] {
  const tarball = resolve(pkg.tarball)
  if (!tarball.endsWith('.tgz') || dirname(tarball) !== resolve(stagingDir)) {
    throw new Error(
      `${pkg.name}: refusing to publish ${pkg.tarball}: only a staged tarball in ${basename(stagingDir)}/ is published, never a package directory`
    )
  }
  return [
    channel.cli,
    'publish',
    tarball,
    '--access',
    'public',
    '--tag',
    DIST_TAG,
    ...(channel.provenance ? ['--provenance'] : []),
  ]
}

/** One package of a release with what will happen to it. */
export interface PlannedPackage {
  /** The staged package. */
  pkg: StagedPackage
  /** What the registry said of its version. */
  registry: RegistryState
  /** `publish` it, or `skip` it because the version is already there. */
  action: 'publish' | 'skip'
}

/** Everything a release run decided before uploading anything. */
export interface ReleasePlan {
  /** The packages, in publish order. */
  packages: PlannedPackage[]
  /** How the upload is done. */
  channel: Channel
  /** Why nothing may be uploaded; empty when the run may go ahead. */
  refusals: string[]
}

/**
 * Put the decisions together: skip what the registry already has, publish the rest, and
 * refuse the whole run when the registry could not say of any package (an upload over an
 * existing version fails, and the script does not guess).
 *
 * @param packages - The staged packages, in publish order.
 * @param states - What the registry said of each.
 * @param channel - How the upload is done.
 * @param reasons - The refusals found so far ({@link refusals}).
 * @returns The plan.
 */
export function planRelease(
  packages: readonly StagedPackage[],
  states: ReadonlyMap<string, RegistryState>,
  channel: Channel,
  reasons: readonly string[]
): ReleasePlan {
  const planned = packages.map((pkg): PlannedPackage => {
    const registry = states.get(pkg.name) ?? 'unknown'
    return { pkg, registry, action: registry === 'published' ? 'skip' : 'publish' }
  })
  const unknown = planned.filter((entry) => entry.registry === 'unknown')
  return {
    packages: planned,
    channel,
    refusals: [
      ...reasons,
      ...channel.problems,
      ...(unknown.length > 0
        ? [
            `the registry did not say whether ${unknown.map((entry) => `${entry.pkg.name}@${entry.pkg.version}`).join(', ')} exist`,
          ]
        : []),
    ],
  }
}

/**
 * The commands a run executes to upload, in order. This is the one gate: without the
 * explicit `--publish`, or with a single refusal, it is empty, and the caller runs nothing
 * else that could upload.
 *
 * @param args - What the run was asked to do.
 * @param plan - The plan.
 * @param stagingDir - The staging directory, absolute.
 * @returns One argument vector a package to publish; none for a dry run or a refused run.
 */
export function uploadCommands(
  args: ReleaseArgs,
  plan: ReleasePlan,
  stagingDir: string
): { pkg: StagedPackage; command: string[] }[] {
  if (args.publish !== true || plan.refusals.length > 0) {
    return []
  }
  return plan.packages
    .filter((entry) => entry.action === 'publish')
    .map((entry) => ({
      pkg: entry.pkg,
      command: publishCommand(entry.pkg, stagingDir, plan.channel),
    }))
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`
}

/**
 * What a person reads before anything is uploaded: each package with its version, tarball,
 * size, file count, checksum and dist-tag, what the registry already has, how the upload
 * would be done, and every reason the run would be refused.
 *
 * @param args - What the run was asked to do.
 * @param plan - The plan.
 * @param context - The commit the tarballs were built from, and the repository's root (the
 *   tarballs are printed relative to it).
 * @returns The report, a line each, ending in a newline.
 */
export function releaseReport(
  args: ReleaseArgs,
  plan: ReleasePlan,
  context: { head: string; root: string }
): string {
  const label = args.publish ? 'RELEASE' : 'DRY RUN'
  const lines = [
    `${label}: commit ${context.head.slice(0, 12)}, dist-tag "${DIST_TAG}", access public`,
    `${label}: ${plan.channel.note}`,
  ]
  for (const { pkg, registry, action } of plan.packages) {
    const tarball = pkg.tarball.startsWith(`${context.root}/`)
      ? pkg.tarball.slice(context.root.length + 1)
      : pkg.tarball
    const id = `${pkg.name}@${pkg.version}`
    lines.push(
      action === 'skip'
        ? `${label}: skip    ${id} (already on the registry)`
        : `${label}: publish ${id}${registry === 'unknown' ? ' (the registry did not answer)' : ''}  ${tarball}  ${kilobytes(pkg.bytes)}, ${pkg.files} files, tag ${DIST_TAG}, sha256 ${pkg.sha256.slice(0, 16)}…`
    )
  }
  for (const reason of plan.refusals) {
    lines.push(`${label}: ${args.publish ? 'REFUSED' : 'a publish would be refused'}: ${reason}`)
  }
  const count = plan.packages.filter((entry) => entry.action === 'publish').length
  if (!args.publish) {
    lines.push(
      `DRY RUN: nothing was published. ${count} package${count === 1 ? '' : 's'} would be; uploading takes \`bun run release:publish\` (docs/releasing.md).`
    )
  } else if (plan.refusals.length > 0) {
    lines.push('RELEASE: nothing was published.')
  }
  return `${lines.join('\n')}\n`
}
