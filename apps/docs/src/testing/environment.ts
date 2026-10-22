import type { LinkEnvironment } from '../lib/links'

/**
 * A repository in memory, for the resolver's and the renderer's tests.
 *
 * @param files - Repository path to its anchors (`null` for a file that is not Markdown).
 * @param directories - Paths that are directories.
 * @param routes - The pages of the site: file to route.
 * @param base - The path the site is served under.
 * @returns An environment over those.
 */
export function fakeEnvironment(
  files: Record<string, ReadonlySet<string> | null>,
  directories: readonly string[] = [],
  routes: Record<string, string> = {},
  base = '/'
): LinkEnvironment {
  return {
    routes: new Map(Object.entries(routes)),
    base,
    kind: (path) => (directories.includes(path) ? 'directory' : path in files ? 'file' : null),
    anchorsOf: (file) => files[file] ?? null,
  }
}
