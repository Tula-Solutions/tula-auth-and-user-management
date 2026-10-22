import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PUBLISHABLE_PACKAGES } from './publish-manifest'

// The changeset check (.github/workflows/changeset-check.yml): a pull request into `develop`
// that changes what a publishable package ships carries a changeset, or the label
// `no-changeset`. Without it the change would reach `develop` and no release PR would ever
// name it (docs/releasing.md, "The release flow"). The decision is a pure function, tested in
// `.claude/hooks/changeset-check.test.ts`; only `main()` reads git and the working tree.
//
// It is a check and not a required status check: the repository's ruleset does not list it.

/** The label that waives the check: a change that needs no release note (a refactor, a fix to a build script). */
export const NO_CHANGESET_LABEL = 'no-changeset'

/**
 * Branches the automation itself opens into `develop` or `main`: the release PR carries the
 * applied changesets (it deletes them) and the back-merge carries the version bumps, so
 * neither adds a changeset.
 */
export const AUTOMATION_BRANCHES: readonly string[] = ['release/next', 'back-merge/main']

/**
 * The top-level entries of a publishable package's directory that end up in its tarball and
 * are written by hand: `src/` is built into `dist/`, `templates/` is `create-tula`'s, `ios/`
 * and `android/` are `@tula-tech/expo-screens`' native sources. Everything else in a package
 * (`package.json`, `tsconfig*.json`, `bunup.config.ts`, `scripts/`, `turbo.json`,
 * `bunfig.toml`) configures the build and ships nothing a user can see; a dependency bump
 * there is waived with the label.
 */
const SHIPPED_ROOTS: readonly string[] = ['src', 'templates', 'ios', 'android']

/** Single files at a package's root that ship as they are. */
const SHIPPED_FILES: readonly string[] = ['expo-module.config.json', 'openapi.json']

/** A path segment that marks test support: tests, their fixtures and mocks. */
const TEST_SEGMENT = /^(__tests__|__mocks__|__snapshots__|tests?|testing|fixtures?)$/i

/** A file name that is a test: `x.test.ts`, `x.spec.tsx`, `x.integration.ts`, `XTests.swift`, `XTest.kt`. */
const TEST_FILE = /(\.(test|spec|integration)\.[^.]+$)|(Tests?\.(swift|kt)$)/

/** Prose, never code: Markdown and MDX (README, CHANGELOG, docs pages). */
const DOCS_FILE = /\.(md|mdx)$/i

/** A changed file as `git diff --name-status` reports it. */
export interface ChangedFile {
  /** `A` added, `M` modified, `D` deleted. Renames are not reported (`--no-renames`). */
  status: string
  /** Path from the repository root, with `/` separators. */
  path: string
}

/**
 * Whether a file belongs to what a publishable package ships: it is under one of the
 * package's shipped roots and is neither a test nor prose.
 *
 * Why a list of shipped roots and not "anything under the package minus tests": the build
 * configuration of a package changes often and changes nothing for a user, and a rule that
 * cried wolf would teach people to add the label by reflex.
 *
 * @param path - The changed file's path from the repository root.
 * @returns `true` when the change needs a changeset, `false` for tests, docs and build files.
 * @example
 * shipsWithPackage('packages/core/src/session.ts') // true
 * shipsWithPackage('packages/core/src/session.test.ts') // false
 * shipsWithPackage('packages/core/README.md') // false
 */
export function shipsWithPackage(path: string): boolean {
  const dir = PUBLISHABLE_PACKAGES.find((candidate) => path.startsWith(`${candidate}/`))
  if (dir === undefined) {
    return false
  }
  const inside = path.slice(dir.length + 1).split('/')
  const file = inside[inside.length - 1] ?? ''
  if (inside.length === 1) {
    return SHIPPED_FILES.includes(file)
  }
  if (!SHIPPED_ROOTS.includes(inside[0] ?? '')) {
    return false
  }
  if (DOCS_FILE.test(file) || TEST_FILE.test(file)) {
    return false
  }
  return !inside.slice(1, -1).some((segment) => TEST_SEGMENT.test(segment))
}

/**
 * The packages a changeset file names, read from its front matter.
 *
 * @param text - The Markdown file's content.
 * @returns The package names between the `---` lines, `[]` for a file without a front matter.
 */
export function changesetPackages(text: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) {
    return []
  }
  const names: string[] = []
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const named = /^\s*["']?([^"':\s]+)["']?\s*:\s*(major|minor|patch)\s*$/.exec(line)
    if (named?.[1] !== undefined) {
      names.push(named[1])
    }
  }
  return names
}

/** What the check decided. */
export interface Verdict {
  /** `true` when the pull request may pass. */
  ok: boolean
  /** One line saying why, for the job's log. */
  reason: string
  /** The shipped files that asked for a changeset, when `ok` is `false`. */
  needing: string[]
}

/** Inputs of {@link decide}. */
export interface DecideInput {
  /** The pull request's changed files. */
  changed: readonly ChangedFile[]
  /** The pull request's labels. */
  labels: readonly string[]
  /** The pull request's head branch. */
  headRef: string
  /**
   * The packages each added changeset file names, by path. A file that names no package of the
   * fixed group does not count: it would release nothing.
   */
  changesets: Readonly<Record<string, readonly string[]>>
  /** The packages of the fixed group (`.changeset/config.json`). */
  fixedGroup: readonly string[]
  /**
   * Whether the head branch lives in a fork. A fork can name its branch `release/next`, so the
   * exemption by name is for the repository's own branches only. Absent means not a fork.
   */
  fromFork?: boolean
}

/**
 * Decide whether a pull request into `develop` needs a changeset it does not have.
 *
 * @param input - The change, its labels, its head branch and the changesets it adds.
 * @returns The verdict: passes when nothing shipped changed, when the label or an automation
 *   branch waives it, or when the change adds a changeset that names a package of the group.
 */
export function decide(input: DecideInput): Verdict {
  if (input.fromFork !== true && AUTOMATION_BRANCHES.includes(input.headRef)) {
    return { ok: true, reason: `${input.headRef} is opened by the release automation`, needing: [] }
  }
  const needing = input.changed.map((file) => file.path).filter(shipsWithPackage)
  if (needing.length === 0) {
    return { ok: true, reason: 'no file that a published package ships was changed', needing }
  }
  if (input.labels.includes(NO_CHANGESET_LABEL)) {
    return { ok: true, reason: `labelled ${NO_CHANGESET_LABEL}`, needing }
  }
  const group = new Set(input.fixedGroup)
  const counted = input.changed
    .filter((file) => file.status === 'A' && isChangesetPath(file.path))
    .filter((file) => (input.changesets[file.path] ?? []).some((name) => group.has(name)))
  if (counted.length > 0) {
    return { ok: true, reason: `adds ${counted.map((file) => file.path).join(', ')}`, needing }
  }
  return {
    ok: false,
    reason: `${needing.length} shipped file(s) changed and the pull request adds no changeset`,
    needing,
  }
}

/**
 * Whether a path is a changeset file: a Markdown file directly in `.changeset/`, other than the
 * folder's README.
 *
 * @param path - A path from the repository root.
 * @returns `true` for `.changeset/brave-owls.md`, `false` for the README and for subfolders.
 */
export function isChangesetPath(path: string): boolean {
  return /^\.changeset\/[^/]+\.md$/.test(path) && path !== '.changeset/README.md'
}

/**
 * Parse `git diff --name-status --no-renames` output.
 *
 * @param output - The command's standard output.
 * @returns One entry per line.
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const line of output.split('\n')) {
    const [status, ...rest] = line.split('\t')
    if (status !== undefined && status !== '' && rest.length > 0) {
      files.push({ status: status.slice(0, 1), path: rest.join('\t') })
    }
  }
  return files
}

/** The message a failing check prints, so that the way out is in the log. */
export function failureMessage(verdict: Verdict): string {
  return [
    `This pull request changes what a published package ships and adds no changeset.`,
    ``,
    ...verdict.needing.slice(0, 20).map((path) => `  ${path}`),
    verdict.needing.length > 20 ? `  ... and ${verdict.needing.length - 20} more` : '',
    ``,
    `Run \`bunx changeset\`, commit the file it writes in .changeset/, and push.`,
    `If the change needs no release note, a person adds the label \`${NO_CHANGESET_LABEL}\`.`,
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')
}

/** Reads git and the working tree, prints the verdict and sets the exit code. */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const value = (name: string): string => {
    const at = args.indexOf(name)
    return at === -1 ? '' : (args[at + 1] ?? '')
  }
  const base = value('--base')
  const headRef = value('--head-ref')
  const labels = value('--labels')
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '')
  if (base === '') {
    throw new Error('usage: changeset-check.ts --base <ref> [--head-ref <branch>] [--labels a,b]')
  }
  const diff = Bun.spawnSync(['git', 'diff', '--name-status', '--no-renames', `${base}...HEAD`], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed: ${diff.stderr.toString()}`)
  }
  const changed = parseNameStatus(diff.stdout.toString())
  const config = JSON.parse(readFileSync(join('.changeset', 'config.json'), 'utf8')) as {
    fixed: string[][]
  }
  const changesets: Record<string, string[]> = {}
  for (const file of changed) {
    if (file.status === 'A' && isChangesetPath(file.path)) {
      changesets[file.path] = changesetPackages(readFileSync(file.path, 'utf8'))
    }
  }
  const verdict = decide({
    changed,
    labels,
    headRef,
    changesets,
    fixedGroup: config.fixed.flat(),
    fromFork: value('--fork') === 'true',
  })
  console.log(`${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.reason}`)
  if (!verdict.ok) {
    console.log(`\n${failureMessage(verdict)}`)
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
}
