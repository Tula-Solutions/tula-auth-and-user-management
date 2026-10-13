import { basename, dirname, resolve } from 'node:path'
import type { Manifest } from './publish-manifest'

// The decisions of a release, as pure functions: what `scripts/packages.ts release` refuses,
// what it skips, which command uploads a tarball and what it prints first. Nothing here
// spawns a process, reads a file or touches the network by itself (the registry is asked
// through a `fetch` the caller passes), so every rule is unit-tested in
// `.claude/hooks/release.test.ts`.
//
// NO STORED CREDENTIAL PASSES THROUGH THIS FILE OR ITS CALLER. The upload is done by a
// package manager's own command with that command's own login (`bun publish` on a person's
// machine, `npm publish` with GitHub's OIDC identity in the release workflow). The script
// never reads `.npmrc`, never takes a token, and looks at the environment only to ask
// WHETHER a variable is set, never for its value.
//
// The one thing a person may hand it is a one-time password (`--otp <code>`), for a session
// with no terminal to be asked in. It is good for seconds and useless without the login; it
// is taken from the arguments only (never a variable or a file), refused in CI, passed on as
// one element of the argument vector and never printed: `printableCommand` strikes it out.

/** The npm dist-tag a release is published under. `latest` is never moved by this script. */
export const DIST_TAG = 'alpha'

/** The registry that is asked which versions exist. The upload goes where the CLI's own configuration says. */
export const REGISTRY = 'https://registry.npmjs.org'

/** The version every package has before `changeset version` has ever run: never published. */
export const UNRELEASED_VERSION = '0.0.0'

/** The first npm that can publish through trusted publishing (OIDC, no token). */
export const MIN_NPM_FOR_TRUSTED_PUBLISHING = '11.5.1'

/** The one-time password of an npm account's second factor: digits, six to eight of them. */
const ONE_TIME_PASSWORD = /^\d{6,8}$/

/** A released package as it was staged and packed in this run. */
export interface StagedPackage {
  /** The package's name, e.g. `@tula-tech/core`. */
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
  /**
   * The tarball's integrity as the registry states it for a published version
   * (`sha512-` and the digest in base64): how a version that is already there is known to
   * be this tarball and not another commit's.
   */
  integrity: string
  /** The package.json read back out of the tarball. */
  manifest: Manifest
}

/** What `release` was asked to do. */
export interface ReleaseArgs {
  /** Upload for real. False is the dry run, which is the default. */
  publish: boolean
  /**
   * The one-time password to hand the publish command, or `null`: then the command asks
   * for the second factor itself. Never printed, never kept anywhere but here.
   */
  otp: string | null
}

/**
 * Read the arguments after `release`. The dry run is the default and needs no flag; an
 * upload happens only with `--publish`, spelled out. Anything else is refused rather than
 * ignored, so that a typo (`--publsh`) is never read as "the default".
 *
 * `--otp <code>` goes with `--publish` only. Whatever follows `--otp` is taken as the code
 * and is never repeated in an error: a mistyped one may be a real code, or something worse
 * pasted by mistake.
 *
 * @param argv - The arguments after the mode.
 * @returns Whether to upload, and the one-time password if one was given.
 * @throws Error for an unknown argument, for `--dry-run` together with `--publish`, and
 *   for an `--otp` that is given twice, is not 6 to 8 digits or comes without `--publish`.
 */
export function parseReleaseArgs(argv: readonly string[]): ReleaseArgs {
  const flags: string[] = []
  const codes: (string | undefined)[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string
    if (argument === '--otp') {
      index += 1
      codes.push(argv[index])
    } else {
      flags.push(argument)
    }
  }
  const unknown = flags.filter((argument) => argument !== '--dry-run' && argument !== '--publish')
  if (unknown.length > 0) {
    throw new Error(
      `unknown argument ${unknown.map((argument) => JSON.stringify(argument.startsWith('--otp') ? '--otp…' : argument)).join(', ')}: release takes --dry-run (the default) or --publish, and with --publish, --otp <code>`
    )
  }
  if (flags.includes('--dry-run') && flags.includes('--publish')) {
    throw new Error('--dry-run and --publish were both given: choose one')
  }
  if (codes.length > 1) {
    throw new Error('--otp was given twice: give one code')
  }
  const [code] = codes
  if (codes.length === 1 && (code === undefined || !ONE_TIME_PASSWORD.test(code))) {
    throw new Error(
      '--otp takes the 6 to 8 digits your authenticator shows, as the next argument (--otp <code>)'
    )
  }
  const publish = flags.includes('--publish')
  if (codes.length === 1 && !publish) {
    throw new Error('--otp is only for --publish: a dry run uploads nothing and needs no code')
  }
  return { publish, otp: code ?? null }
}

/**
 * Why a one-time password must not be used where this runs. A code is typed by a person at
 * their own machine; a job that has one was given it through a variable, a file or a log,
 * which stores the second factor beside the first. The workflow publishes through trusted
 * publishing and needs none.
 *
 * @param args - What the run was asked to do.
 * @param env - The process's environment. Only whether `GITHUB_ACTIONS` and `CI` are set
 *   is looked at.
 * @returns One sentence when a code was given in CI; none otherwise.
 */
export function otpProblems(
  args: ReleaseArgs,
  env: Readonly<Record<string, string | undefined>>
): string[] {
  if (args.otp === null || (!isSet(env, 'GITHUB_ACTIONS') && !isSet(env, 'CI'))) {
    return []
  }
  return [
    '--otp was given in CI: a one-time password is typed by a person, at their own machine, and is never stored where a job can read it',
  ]
}

/**
 * The order the packages are uploaded in: an unscoped one first, the rest as they are
 * (dependencies first, which {@link orderProblems} still checks).
 *
 * A scoped name belongs to the scope's organisation. An unscoped one is anyone's until it
 * is taken, and npm never accepts again a version that once existed while it answers 404
 * for it, so the registry check cannot see such a version. Uploading the unscoped package
 * first means that refusal comes before anything else went out, not after eight packages.
 *
 * @param packages - The staged packages, dependencies first.
 * @returns The same packages, unscoped ones moved to the front in their own order.
 */
export function uploadOrder(packages: readonly StagedPackage[]): StagedPackage[] {
  return [
    ...packages.filter((pkg) => !pkg.name.startsWith('@')),
    ...packages.filter((pkg) => pkg.name.startsWith('@')),
  ]
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

/**
 * Whether a version of a package is on the registry: `published` when it is there and is the
 * tarball this run built, `different` when it is there with other contents (or the registry
 * does not state its integrity), `absent` when it is not, and `unknown` when the registry
 * did not say.
 */
export type RegistryState = 'published' | 'different' | 'absent' | 'unknown'

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
) => Promise<{ status: number; json: () => Promise<unknown> }>

/** The `dist.integrity` of a version's registry document, or `null` when it states none. */
function statedIntegrity(document: unknown): string | null {
  if (typeof document !== 'object' || document === null || !Object.hasOwn(document, 'dist')) {
    return null
  }
  const dist = (document as { dist: unknown }).dist
  if (typeof dist !== 'object' || dist === null || !Object.hasOwn(dist, 'integrity')) {
    return null
  }
  const integrity = (dist as { integrity: unknown }).integrity
  return typeof integrity === 'string' ? integrity : null
}

/**
 * Ask the registry which of the packages' versions already exist, so that a run that failed
 * half-way can be run again: what is there is skipped. The request carries no credential
 * (a plain GET of public metadata), follows no redirect and has a deadline. Only 200 means
 * "there" and only 404 "absent"; anything else, a failure included, is `unknown`, which
 * an upload refuses to guess about.
 *
 * A version that is there is skipped only when the registry's `dist.integrity` for it is
 * the integrity of the tarball this run built. Otherwise it is `different`, which refuses
 * the run: a release that stopped after some packages is finished from the commit it
 * started from, never topped up with the rest from another commit under the same version.
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
      if (response.status === 200) {
        state = statedIntegrity(await response.json()) === pkg.integrity ? 'published' : 'different'
      } else if (response.status === 404) {
        state = 'absent'
      }
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
 * @param otp - A one-time password to hand the CLI, as an argument of its own; `null` or
 *   left out for none. Print the result only through {@link printableCommand}.
 * @returns The argument vector: the CLI, `publish`, the tarball, `--access public` and the
 *   dist-tag, `--provenance` where the channel has it, and `--otp` with the code last.
 * @throws Error when the path is not a `.tgz` directly inside the staging directory.
 */
export function publishCommand(
  pkg: StagedPackage,
  stagingDir: string,
  channel: Channel,
  otp: string | null = null
): string[] {
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
    ...(otp === null ? [] : ['--otp', otp]),
  ]
}

/**
 * A command as it may be printed: the argument after `--otp`, and the value of an
 * `--otp=…`, replaced by asterisks. Every line the script writes about an upload command
 * goes through this.
 *
 * @param command - The argument vector.
 * @returns The arguments joined by spaces, with no one-time password in it.
 */
export function printableCommand(command: readonly string[]): string {
  return command
    .map((argument, index) => {
      if (index > 0 && command[index - 1] === '--otp') {
        return '******'
      }
      return argument.startsWith('--otp=') ? '--otp=******' : argument
    })
    .join(' ')
}

/** One package of a release with what will happen to it. */
export interface PlannedPackage {
  /** The staged package. */
  pkg: StagedPackage
  /** What the registry said of its version. */
  registry: RegistryState
  /**
   * `publish` it, `skip` it because this very tarball is already there, or `refuse`: the
   * version is there with other contents, and the whole run is refused.
   */
  action: 'publish' | 'skip' | 'refuse'
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
 * existing version fails, and the script does not guess) or has a version with other
 * contents than this run built.
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
    const action =
      registry === 'published' ? 'skip' : registry === 'different' ? 'refuse' : 'publish'
    return { pkg, registry, action }
  })
  const unknown = planned.filter((entry) => entry.registry === 'unknown')
  return {
    packages: planned,
    channel,
    refusals: [
      ...reasons,
      ...channel.problems,
      ...planned
        .filter((entry) => entry.action === 'refuse')
        .map(
          (entry) =>
            `${entry.pkg.name}@${entry.pkg.version} is on the registry with other contents than the tarball this run built: a release is finished from the commit it started from, or a new version is cut`
        ),
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
      command: publishCommand(entry.pkg, stagingDir, plan.channel, args.otp),
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
    if (action === 'skip') {
      lines.push(`${label}: skip    ${id} (already on the registry, the same tarball)`)
    } else if (action === 'refuse') {
      lines.push(`${label}: DIFFERS ${id} (on the registry with other contents)`)
    } else {
      lines.push(
        `${label}: publish ${id}${registry === 'unknown' ? ' (the registry did not answer)' : ''}  ${tarball}  ${kilobytes(pkg.bytes)}, ${pkg.files} files, tag ${DIST_TAG}, sha256 ${pkg.sha256.slice(0, 16)}…`
      )
    }
  }
  for (const reason of plan.refusals) {
    // What only the job that uploads has (its OIDC identity, npm) is not a fault of a dry
    // run made somewhere else: said as a note there, and a refusal with `--publish`.
    if (!args.publish && plan.channel.problems.includes(reason)) {
      lines.push(
        `${label}: note, not checked in a dry run (the job that uploads must have it): ${reason}`
      )
    } else {
      lines.push(`${label}: ${args.publish ? 'REFUSED' : 'a publish would be refused'}: ${reason}`)
    }
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
