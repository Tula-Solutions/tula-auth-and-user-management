import { posix } from 'node:path'
import { REPO_BRANCH, REPO_URL } from './config'

/** What the resolver needs to know about the repository: injected, so it is tested without disk. */
export interface LinkEnvironment {
  /** Every page of the site: the file from the repository root, and its route. */
  routes: ReadonlyMap<string, string>
  /** The path the site is served under (`/`, or `/docs/`). */
  base: string
  /**
   * What a repository path is.
   *
   * @param path - From the repository root.
   * @returns `file`, `directory`, or `null` when nothing is there.
   */
  kind(path: string): 'file' | 'directory' | null
  /**
   * The anchors a Markdown file offers.
   *
   * @param file - A Markdown file, from the repository root.
   * @returns Its heading ids and explicit anchors, or `null` when it is not Markdown.
   */
  anchorsOf(file: string): ReadonlySet<string> | null
}

/** Where a link ends up. */
export type Resolved =
  | { kind: 'external'; href: string }
  | { kind: 'page'; href: string }
  | { kind: 'repository'; href: string }
  | { kind: 'asset'; file: string }

/** A link or an anchor the site cannot resolve: the build stops on it. */
export class LinkError extends Error {
  constructor(from: string, target: string, reason: string) {
    super(`${from}: link "${target}" ${reason}`)
    this.name = 'LinkError'
  }
}

const SCHEME = /^([a-z][a-z0-9+.-]*:|\/\/)/i

/**
 * Whether a link target leaves the repository (a URL with a scheme, or protocol-relative).
 *
 * @param target - The raw target of a link.
 * @returns True for `https://…`, `mailto:…` and `//host/…`.
 */
export function isExternal(target: string): boolean {
  return SCHEME.test(target)
}

function decode(from: string, target: string, value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new LinkError(from, target, 'is not a valid URL')
  }
}

/**
 * Resolve a link of a Markdown file.
 *
 * A link to a file that is a page of the site becomes the page's route; a link to any other
 * file or directory of the repository (an ADR, a package README, a source file) becomes its
 * address on GitHub, because the site is built from `docs/` alone. A link that points at
 * nothing, or at an anchor the target does not have, is an error: the build fails.
 *
 * @param from - The file the link is in, from the repository root.
 * @param target - The link target as written (`methods/password.md#policy`, `#top`).
 * @param environment - What exists in the repository.
 * @returns Where the link goes. An `asset` is a file the site must copy (for an image).
 * @throws LinkError when the file or the anchor does not exist, or the path leaves the repository.
 */
export function resolveLink(from: string, target: string, environment: LinkEnvironment): Resolved {
  if (isExternal(target)) {
    return { kind: 'external', href: target }
  }
  const hashAt = target.indexOf('#')
  const rawPath = hashAt === -1 ? target : target.slice(0, hashAt)
  const rawFragment = hashAt === -1 ? '' : target.slice(hashAt + 1)
  const fragment = decode(from, target, rawFragment)
  const path = decode(from, target, rawPath.split('?')[0] as string)
  const resolved =
    path === '' ? from : posix.normalize(posix.join(posix.dirname(from), path)).replace(/\/$/, '')
  if (resolved.startsWith('..') || posix.isAbsolute(resolved)) {
    throw new LinkError(from, target, 'leaves the repository')
  }
  const kind = environment.kind(resolved)
  if (kind === null) {
    throw new LinkError(from, target, 'points at a file that does not exist')
  }

  // A directory is its README when that is a page; otherwise the directory on GitHub.
  if (kind === 'directory') {
    const index = posix.join(resolved, 'README.md')
    const route = environment.routes.get(index)
    if (route !== undefined) {
      return page(from, target, index, route, fragment, environment)
    }
    return { kind: 'repository', href: `${REPO_URL}/tree/${REPO_BRANCH}/${resolved}` }
  }

  const route = environment.routes.get(resolved)
  if (route !== undefined) {
    return page(from, target, resolved, route, fragment, environment)
  }
  if (!resolved.endsWith('.md')) {
    return fragment === '' && IMAGE.test(resolved)
      ? { kind: 'asset', file: resolved }
      : { kind: 'repository', href: repositoryHref(resolved, fragment) }
  }
  // A Markdown file the site does not render: its anchors are still checked.
  checkAnchor(from, target, resolved, fragment, environment)
  return { kind: 'repository', href: repositoryHref(resolved, fragment) }
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i

function repositoryHref(file: string, fragment: string): string {
  return `${REPO_URL}/blob/${REPO_BRANCH}/${file}${fragment === '' ? '' : `#${fragment}`}`
}

function page(
  from: string,
  target: string,
  file: string,
  route: string,
  fragment: string,
  environment: LinkEnvironment
): Resolved {
  checkAnchor(from, target, file, fragment, environment)
  const href = `${environment.base.replace(/\/$/, '')}${route}`
  return { kind: 'page', href: fragment === '' ? href : `${href}#${fragment}` }
}

function checkAnchor(
  from: string,
  target: string,
  file: string,
  fragment: string,
  environment: LinkEnvironment
): void {
  if (fragment === '' || fragment === 'top') {
    return
  }
  const anchors = environment.anchorsOf(file)
  if (anchors !== null && !anchors.has(fragment)) {
    throw new LinkError(
      from,
      target,
      `points at an anchor "#${fragment}" that ${file} does not have`
    )
  }
}
