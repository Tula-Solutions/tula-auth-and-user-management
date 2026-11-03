import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { changesetPackages } from './changeset-check'

// The release pull request (.github/workflows/release-pr.yml): what is decided and built when a
// push to `develop` has changesets pending. `release.yml` never runs `changeset version` and
// no person has to either: this script does, on a branch, and the workflow opens the PR.
//
// The decisions are pure functions, tested in `.claude/hooks/release-pr.test.ts`, which also
// runs the whole `prepare` step against a throwaway clone. Only the `plan` and `prepare`
// commands at the end read git or the disk.

/** The branch the release pull request is made from. Rebuilt from `develop` every time. */
export const RELEASE_BRANCH = 'release/next'

/** What a push to `develop` should do about the release pull request. */
export type ReleaseAction =
  /** Changesets are pending: build the version commit and open or update the pull request. */
  | 'release'
  /** Changesets are pending but a release has consumed some of them and `develop` has not got it back yet. */
  | 'wait'
  /** Nothing is pending: close a stale release pull request, if one is open. */
  | 'none'

/**
 * Decide what to do about the release pull request.
 *
 * `consumed` matters because a release is not on `develop` until the back-merge lands: after
 * the release pull request is merged into `main`, `develop` still holds the changeset files
 * that the release deleted. Building a second release from them would propose the same
 * version again. This is asked of `main`'s history and not by "is `main` an ancestor of
 * `develop`", so that a squash-merged back-merge does not stall releases for ever.
 *
 * @param pending - The changeset files on `develop`.
 * @param consumed - The subset of `pending` that a commit on `main` has deleted.
 * @returns `none` for no changesets, `wait` when any was consumed, `release` otherwise.
 */
export function plan(pending: readonly string[], consumed: readonly string[]): ReleaseAction {
  if (pending.length === 0) {
    return 'none'
  }
  return consumed.length > 0 ? 'wait' : 'release'
}

/**
 * The pending changeset files of a checkout.
 *
 * @param root - The repository root.
 * @returns The names of the Markdown files in `.changeset/` that name a package of the fixed
 *   group (`.changeset/config.json`), without the folder's README. An empty changeset
 *   (`changeset --empty`), one for a private package only and a malformed one release
 *   nothing: counting them would open a release pull request that proposes the version that
 *   is already out.
 */
export function pendingChangesets(root: string): string[] {
  const config = JSON.parse(readFileSync(join(root, '.changeset', 'config.json'), 'utf8')) as {
    fixed?: string[][]
  }
  const group = new Set((config.fixed ?? []).flat())
  return readdirSync(join(root, '.changeset'))
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .filter((name) =>
      changesetPackages(readFileSync(join(root, '.changeset', name), 'utf8')).some((pkg) =>
        group.has(pkg)
      )
    )
    .sort()
}

/** The title of the release pull request. */
export function releaseTitle(version: string): string {
  return `release: v${version}`
}

/** The hand-kept version places of docs/releasing.md ("First release", step 3), by file. */
export const HAND_KEPT_CONSTANTS: readonly string[] = [
  'packages/cli/src/version.ts',
  'packages/create-tula/src/scaffold.ts',
  'packages/mcp/src/server.ts',
]

/** Changesets ignores this package, so its version is moved here. */
export const API_MANIFEST = 'apps/api/package.json'

/**
 * Move the places that hold the release's version by hand to the version `changeset version`
 * just wrote. `release-versions.test.ts` fails for a place left behind, so without this the
 * release pull request would fail its own `verify`.
 *
 * The constant's line moves, and so do the comment lines that name the old version (the
 * `@example` above it); the API's manifest moves its `version` field. Any other line that
 * holds the old version (a range, a pin) is not rewritten silently: it throws, because
 * whether it should move is a person's call.
 *
 * @param root - The repository root.
 * @param version - The new version, plain `1.2.3`.
 * @returns The files that changed.
 * @throws Error when a constant is not found, the version is not plain, or the old version
 *   appears on a line that is neither the constant nor a comment.
 */
export function syncHandKeptVersions(root: string, version: string): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`not a plain version: ${version}`)
  }
  const changed: string[] = []
  for (const file of HAND_KEPT_CONSTANTS) {
    const path = join(root, file)
    const text = readFileSync(path, 'utf8')
    const old = /\b(?:MCP_)?VERSION = '([^']+)'/.exec(text)?.[1]
    if (old === undefined) {
      throw new Error(`${file}: no VERSION constant found`)
    }
    if (old !== version) {
      const lines = text.split('\n').map((line) => {
        if (!line.includes(old)) {
          return line
        }
        const isConstant = /\b(?:MCP_)?VERSION = '/.test(line)
        const isComment = /^\s*(\*|\/\/|\/\*)/.test(line)
        if (!isConstant && !isComment) {
          throw new Error(
            `${file}: ${old} appears on a line other than the constant: ${line.trim()}`
          )
        }
        return line.split(old).join(version)
      })
      writeFileSync(path, lines.join('\n'))
      changed.push(file)
    }
  }
  const manifest = join(root, API_MANIFEST)
  const text = readFileSync(manifest, 'utf8')
  const field = /"version":\s*"([^"]+)"/.exec(text)
  if (field?.[1] === undefined) {
    throw new Error(`${API_MANIFEST}: no version field`)
  }
  if (field[1] !== version) {
    writeFileSync(manifest, text.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`))
    changed.push(API_MANIFEST)
  }
  return changed
}

/**
 * The entries Changesets writes for a workspace dependency that moved with the group: "Updated
 * dependencies", and a bare `- @tula-tech/core@0.2.0` line in a private package's changelog.
 */
const DEPENDENCY_ENTRY = /^- (Updated dependencies|@?[\w./-]+@\d+\.\d+\.\d+\s*$)/

/** The kinds of change a CHANGELOG groups its entries under, largest first. */
const GROUPS = ['Major', 'Minor', 'Patch'] as const

/**
 * The changelog entries a version commit adds, read from the unified diff of the packages'
 * `CHANGELOG.md` files.
 *
 * The eleven packages share one version, so one changeset appears in the changelog of every
 * package it names: entries are de-duplicated by text. The "Updated dependencies" entries
 * Changesets writes for the group are dropped; they say nothing a reader needs.
 *
 * @param diff - `git diff` output restricted to `CHANGELOG.md` files.
 * @returns Entries by group, each entry as the Markdown it was written in.
 */
export function changelogEntries(diff: string): Record<(typeof GROUPS)[number], string[]> {
  const result: Record<(typeof GROUPS)[number], string[]> = { Major: [], Minor: [], Patch: [] }
  let group: (typeof GROUPS)[number] | undefined
  let current: string[] | undefined
  const flush = (): void => {
    if (group !== undefined && current !== undefined) {
      // The commit hash Changesets prefixes an entry with names a commit on `develop`; the
      // release PR lists what changed, not where.
      const entry = current
        .join('\n')
        .trimEnd()
        .replace(/^- [0-9a-f]{7,40}: /, '- ')
      if (entry !== '' && !DEPENDENCY_ENTRY.test(entry) && !result[group].includes(entry)) {
        result[group].push(entry)
      }
    }
    current = undefined
  }
  for (const raw of diff.split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) {
      continue
    }
    const line = raw.slice(1)
    const heading = /^### (Major|Minor|Patch) Changes\s*$/.exec(line)
    if (heading?.[1] !== undefined) {
      flush()
      group = heading[1] as (typeof GROUPS)[number]
    } else if (/^#{1,3} /.test(line)) {
      flush()
      group = undefined
    } else if (line.startsWith('- ')) {
      flush()
      current = [line]
    } else if (line.trim() === '') {
      if (current !== undefined) {
        current.push('')
      }
    } else if (/^\s/.test(line) && current !== undefined) {
      current.push(line)
    }
  }
  flush()
  return result
}

/** GitHub refuses a pull request body longer than this; the entries are cut well before it. */
const BODY_LIMIT = 60_000

/**
 * The release pull request's body.
 *
 * @param version - The release's version.
 * @param entries - The changelog entries, from {@link changelogEntries}.
 * @returns Markdown: what the release contains, and what merging it does.
 */
export function releaseBody(version: string, entries: ReturnType<typeof changelogEntries>): string {
  const sections: string[] = []
  for (const group of GROUPS) {
    if (entries[group].length > 0) {
      sections.push(`### ${group} changes\n\n${entries[group].join('\n\n')}`)
    }
  }
  let changes = sections.join('\n\n')
  if (changes.length > BODY_LIMIT) {
    changes = `${changes.slice(0, BODY_LIMIT)}\n\n_The list is cut here; each package's CHANGELOG.md has all of it._`
  }
  return [
    `Version ${version} of the eleven packages of the fixed group, made by \`bunx changeset version\` from the changesets on \`develop\`. Opened and kept up to date by \`.github/workflows/release-pr.yml\`; the branch \`${RELEASE_BRANCH}\` is rebuilt from \`develop\` on every push there, so do not commit to it.`,
    '',
    '## What merging this does',
    '',
    '1. The documentation site is rebuilt and the released docs updated.',
    '2. `release.yml` builds and checks the packages and publishes them to npm (environment `npm-publish`, trusted publishing, no further approval).',
    '3. `github-packages.yml` copies the released packages to GitHub Packages.',
    '4. `back-merge.yml` opens a pull request from `main` back into `develop` (merge it with a merge commit).',
    '',
    '## Changes',
    '',
    changes === '' ? '_The changesets carry no entries._' : changes,
    '',
  ].join('\n')
}

/** Run a command, return its output, throw with its stderr when it fails. */
function run(command: string[], cwd: string, timeout = 300_000): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe', timeout })
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

/** Append `name=value` to the file GitHub Actions reads step outputs from, or print it. */
function output(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (file === undefined) {
    console.log(`${name}=${value}`)
  } else {
    appendFileSync(file, `${name}=${value}\n`)
  }
}

/**
 * `plan`: print `action=release|wait|none`. Run on `develop` with `origin/main` fetched.
 *
 * @param root - The repository root.
 * @param mainRef - The ref of `main`'s history.
 */
export function planCommand(root: string, mainRef = 'origin/main'): ReleaseAction {
  const pending = pendingChangesets(root)
  const consumed = pending.filter(
    (name) =>
      run(
        ['git', 'log', mainRef, '--diff-filter=D', '--format=%H', '-1', '--', `.changeset/${name}`],
        root
      ).trim() !== ''
  )
  const action = plan(pending, consumed)
  output('action', action)
  output('pending', String(pending.length))
  return action
}

/** The commands of `prepare` that need the installed workspace. */
export interface PrepareSteps {
  /** Apply the pending changesets: versions and CHANGELOGs. */
  changesetVersion: (root: string) => void
  /** Bring `bun.lock` to the new versions. */
  lockfile: (root: string) => void
}

const DEFAULT_STEPS: PrepareSteps = {
  changesetVersion: (root) => {
    run(['bunx', 'changeset', 'version'], root)
  },
  lockfile: (root) => {
    run(['bun', 'install', '--lockfile-only'], root)
  },
}

/**
 * `prepare`: on a branch cut from `develop`, apply the changesets, move the hand-kept
 * versions and the lockfile, and commit. Prints the title; the body goes to `bodyFile`.
 *
 * @param root - The repository root, with a clean tree.
 * @param bodyFile - Where the pull request body is written.
 * @param steps - The two commands that need the installed workspace; replaced in tests.
 * @returns The new version.
 * @throws Error when the tree is not clean, or when `changeset version` did not move the
 *   version (a pull request for the version already released would only fail `release.yml`).
 */
export function prepareCommand(
  root: string,
  bodyFile: string,
  steps: PrepareSteps = DEFAULT_STEPS
): string {
  if (run(['git', 'status', '--porcelain'], root).trim() !== '') {
    throw new Error('the working tree is not clean')
  }
  const readVersion = (): string =>
    (
      JSON.parse(readFileSync(join(root, 'packages/contract/package.json'), 'utf8')) as {
        version: string
      }
    ).version
  const released = readVersion()
  steps.changesetVersion(root)
  const version = readVersion()
  if (version === released) {
    throw new Error(`changeset version did not move the version (still ${released})`)
  }
  syncHandKeptVersions(root, version)
  // The lockfile records every workspace package's version; without this `bun install
  // --frozen-lockfile` would refuse the release commit.
  steps.lockfile(root)
  run(['git', 'add', '-A'], root)
  const diff = run(['git', 'diff', '--cached', '-U0', '--', '*CHANGELOG.md'], root)
  writeFileSync(bodyFile, releaseBody(version, changelogEntries(diff)))
  run(
    [
      'git',
      '-c',
      'user.name=github-actions[bot]',
      '-c',
      'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit',
      '-m',
      `chore(release): ${version}\n\nchangeset version, the hand-kept versions and the lockfile (scripts/release-pr.ts).`,
    ],
    root
  )
  output('version', version)
  output('title', releaseTitle(version))
  return version
}

if (import.meta.main) {
  const [command, argument] = process.argv.slice(2)
  if (command === 'plan') {
    planCommand(process.cwd(), argument)
  } else if (command === 'prepare' && argument !== undefined) {
    prepareCommand(process.cwd(), argument)
  } else {
    throw new Error('usage: release-pr.ts plan [main-ref] | prepare <body-file>')
  }
}
