import { type PathEnvironment, resolveBase } from './paths'

// Which docs a build is. The deployed site holds two builds: the docs of the latest release at
// its root, and the development branch's under `next/`. This file reads the three variables the
// workflow sets (`DOCS_CHANNEL`, `DOCS_VERSION`, `DOCS_ORIGIN`) in the way `resolveBase` reads
// `DOCS_BASE`: taken exactly as written and checked, never tidied. Like `paths.ts`, it uses no
// Bun API and imports nothing of the site.

/**
 * Which docs a build is: the latest release's (`release`), the development branch's under
 * `next/` (`next`), or the development branch's at the site root because no release carries the
 * docs site yet (`unreleased`).
 */
export type Channel = 'release' | 'next' | 'unreleased'

/** What a versioned build knows about itself. */
export interface ReleaseInfo {
  channel: Channel
  /** The released version (`0.1.2`) the root shows, or the one `next` links to; may be unknown. */
  version: string | null
  /** The site's origin (`https://host`), for canonical addresses; `null` writes none. */
  origin: string | null
}

const CHANNELS: readonly Channel[] = ['release', 'next', 'unreleased']

/** A plain release version: the repository publishes `1.2.3` and nothing else. */
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

/** `https://host` with an optional port and no path, query or credentials. */
const ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/

/** The segment the development docs are served under, below the released docs. */
export const NEXT_SEGMENT = 'next/'

/**
 * The version and channel of the docs being built, from `DOCS_CHANNEL`, `DOCS_VERSION` and
 * `DOCS_ORIGIN`.
 *
 * With no `DOCS_CHANNEL` the site is not versioned (a local build): there is no marker, banner
 * or canonical address, and `DOCS_VERSION` and `DOCS_ORIGIN` are refused rather than ignored.
 * The `release` channel needs a plain version and the `unreleased` one must have none. The
 * `next` channel is served below the released docs, so its base must end with `/next/`.
 *
 * @param env - The environment; `process.env` by default.
 * @param base - The base the site is built for; `DOCS_BASE` by default.
 * @returns The release information, or `null` when `DOCS_CHANNEL` is unset or empty.
 * @throws Error naming the variable for any value outside what it accepts.
 */
export function resolveRelease(
  env: PathEnvironment = process.env,
  base: string = resolveBase(env)
): ReleaseInfo | null {
  const channel = env.DOCS_CHANNEL
  const version = env.DOCS_VERSION === '' ? undefined : env.DOCS_VERSION
  const origin = env.DOCS_ORIGIN === '' ? undefined : env.DOCS_ORIGIN
  if (channel === undefined || channel === '') {
    if (version !== undefined || origin !== undefined) {
      throw new Error(
        'DOCS_VERSION and DOCS_ORIGIN need DOCS_CHANNEL (release, next or unreleased)'
      )
    }
    return null
  }
  if (!CHANNELS.includes(channel as Channel)) {
    throw new Error(
      `DOCS_CHANNEL must be release, next or unreleased (got ${JSON.stringify(channel.slice(0, 40))})`
    )
  }
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    throw new Error(
      `DOCS_VERSION must be a plain version such as 0.1.2 (got ${JSON.stringify(version.slice(0, 40))})`
    )
  }
  if (origin !== undefined && !ORIGIN_PATTERN.test(origin)) {
    throw new Error(
      `DOCS_ORIGIN must be an https origin without a path, such as https://example.github.io (got ${JSON.stringify(origin.slice(0, 80))})`
    )
  }
  if (channel === 'release' && version === undefined) {
    throw new Error('DOCS_VERSION is required when DOCS_CHANNEL is release')
  }
  if (channel === 'unreleased' && version !== undefined) {
    throw new Error(
      'DOCS_VERSION must be unset when DOCS_CHANNEL is unreleased: no release has these docs'
    )
  }
  if (channel === 'next' && !base.endsWith(`/${NEXT_SEGMENT}`)) {
    throw new Error(
      `DOCS_BASE must end with /${NEXT_SEGMENT} when DOCS_CHANNEL is next (got ${base})`
    )
  }
  return { channel: channel as Channel, version: version ?? null, origin: origin ?? null }
}

/** Where the released docs and the development docs are served, both under the site's root. */
export interface VersionBases {
  releasedBase: string
  nextBase: string
  /** The base of the other docs: the one a page's version links lead to. */
  siblingBase: string
}

/**
 * The two bases of a versioned site, from the base this build is served under.
 *
 * @param release - The build's channel.
 * @param base - The base this build is served under.
 * @returns The released docs' base and the development docs' base.
 * @throws Error when the `next` channel's base does not end with `next/`.
 */
export function versionBases(release: ReleaseInfo, base: string): VersionBases {
  if (release.channel === 'next') {
    if (!base.endsWith(`/${NEXT_SEGMENT}`)) {
      throw new Error(`the next docs are served below ${NEXT_SEGMENT}, not at ${base}`)
    }
    const releasedBase = base.slice(0, -NEXT_SEGMENT.length)
    return { releasedBase, nextBase: base, siblingBase: releasedBase }
  }
  const nextBase = `${base}${NEXT_SEGMENT}`
  return { releasedBase: base, nextBase, siblingBase: nextBase }
}

/**
 * The address of a route under a base.
 *
 * @param base - A base with a leading and trailing slash.
 * @param route - A route with a leading and trailing slash.
 * @returns The path, `base` itself for `/`.
 */
export function addressOf(base: string, route: string): string {
  return `${base.slice(0, -1)}${route}`
}

/**
 * The canonical address of a page: itself where the docs are the ones a reader should land on
 * (the released docs, or the root before any release carries the site), and none for the
 * development docs, which are `noindex` instead: a canonical to another page beside `noindex`
 * gives search engines two answers.
 *
 * @param release - The build's channel, or `null` for an unversioned build.
 * @param base - The base the build is served under.
 * @param route - The page's route.
 * @returns An absolute address, or `null` where none is written.
 */
export function canonicalOf(
  release: ReleaseInfo | null,
  base: string,
  route: string
): string | null {
  if (
    release === null ||
    release.origin === null ||
    release.channel === 'next' ||
    route === '/404'
  ) {
    return null
  }
  return `${release.origin}${addressOf(base, route)}`
}
