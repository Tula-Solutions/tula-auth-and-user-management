import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

// What the `API image` workflow (.github/workflows/image.yml) decides before it builds: the
// version the image is tagged with, the moving tag beside it, and whether the registry has
// that version already. The decisions are pure functions, tested in
// `.claude/hooks/api-image.test.ts`; only `main` reads a file and asks the registry.
//
// A VERSION TAG IS WRITTEN ONCE. A push to `main` that does not change the version finds
// its tag on the registry and builds nothing, so the image a project pulled as
// `…:0.1.0-alpha.2` yesterday is the one it pulls tomorrow. And when the registry cannot be
// asked, the plan fails: "could not tell" is never read as "not there".

/** The image a release is pushed to, and the one `create-tula` names in a new project. */
export const IMAGE = 'ghcr.io/tula-solutions/tula-api'

/** The version every package has before `changeset version` has ever run: never an image. */
const UNRELEASED_VERSION = '0.0.0'

/** A release's version: `1.2.3`, or `1.2.3-alpha.4` with the channel it is released under. */
const VERSION = /^\d+\.\d+\.\d+(?:-([a-z]+)\.\d+)?$/

/** What the workflow does for a commit. */
export interface ImagePlan {
  /** The tag that is written once and never moved. */
  version: string
  /** The tag that follows the newest release of its kind: `alpha`, or `latest` for a stable one. */
  channel: string
  /** Whether to build and push: `false` when the registry already has `version`. */
  publish: boolean
}

/**
 * The moving tag a version is released under: its pre-release name, or `latest`.
 *
 * @param version - The API's version, from `apps/api/package.json`.
 * @returns `alpha` for `0.1.0-alpha.2`, `latest` for `1.0.0`.
 * @throws Error when the version is `0.0.0` or not a release's version: neither may become a tag.
 */
export function imageChannel(version: string): string {
  const match = VERSION.exec(version)
  if (match === null || version === UNRELEASED_VERSION) {
    throw new Error(`"${version}" is not a version an image is published under`)
  }
  return match[1] ?? 'latest'
}

/**
 * The tags the registry holds, from what `gh api` answered.
 *
 * A package that does not exist yet (the first release) is answered with a 404 and holds
 * none. Every other failure is thrown: an image is never pushed over a tag because the
 * question about it went unanswered.
 *
 * @param result - The exit code and output of the `gh api` call that lists the versions.
 * @returns Every tag of every version, one each.
 * @throws Error when the call failed for a reason other than "no such package".
 */
export function registryTags(result: {
  exitCode: number | null
  stdout: string
  stderr: string
}): string[] {
  if (result.exitCode === 0) {
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }
  // GitHub's answer for a package that is not there: `gh: Package not found. (HTTP 404)`.
  // A package that exists and that this token cannot see reads the same; the push that
  // follows is then refused by the registry, so a tag is still never replaced.
  if (/\(HTTP 404\)/.test(result.stderr)) {
    return []
  }
  throw new Error(
    `the registry could not be asked which versions it holds (exit ${result.exitCode}): ${result.stderr.trim()}`
  )
}

/**
 * What to do for a version, given the tags the registry holds.
 *
 * @param version - The API's version.
 * @param tags - The tags on the registry ({@link registryTags}).
 * @returns The two tags and whether to build.
 * @throws Error for a version that may not become a tag ({@link imageChannel}).
 */
export function planImage(version: string, tags: readonly string[]): ImagePlan {
  return { version, channel: imageChannel(version), publish: !tags.includes(version) }
}

/**
 * The API path that lists an image's versions, from its reference.
 *
 * @param image - `ghcr.io/<owner>/<name>`.
 * @returns The path `gh api` is given.
 * @throws Error when the reference is not on `ghcr.io` with one owner and one name.
 */
export function versionsPath(image: string): string {
  const match = /^ghcr\.io\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(image)
  if (match === null) {
    throw new Error(`"${image}" is not an image of ghcr.io/<owner>/<name>`)
  }
  return `/orgs/${match[1]}/packages/container/${match[2]}/versions`
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, '..')
  const manifest = (await Bun.file(join(root, 'apps/api/package.json')).json()) as {
    version: string
  }
  // Refused before the registry is asked: a version that is no tag needs no answer.
  imageChannel(manifest.version)
  const listed = Bun.spawnSync(
    ['gh', 'api', '--paginate', versionsPath(IMAGE), '--jq', '.[].metadata.container.tags[]'],
    { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 }
  )
  const plan = planImage(
    manifest.version,
    registryTags({
      exitCode: listed.exitCode,
      stdout: listed.stdout.toString(),
      stderr: listed.stderr.toString(),
    })
  )
  const lines = [
    `version=${plan.version}`,
    `channel=${plan.channel}`,
    `publish=${plan.publish}`,
  ].join('\n')
  const verdict = plan.publish
    ? 'is not on the registry: it will be built and pushed.'
    : 'is on the registry already: nothing is built.'
  process.stdout.write(`${lines}\n${IMAGE}:${plan.version} ${verdict}\n`)
  const output = process.env.GITHUB_OUTPUT
  if (output !== undefined && output !== '') {
    appendFileSync(output, `${lines}\n`)
  }
}

if (import.meta.main) {
  await main()
}
