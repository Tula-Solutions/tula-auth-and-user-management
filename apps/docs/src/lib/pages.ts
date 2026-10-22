import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DOCS_DIR, EXCLUDED_DIRECTORIES, REPO_ROOT } from './config'

/** A Markdown file of `docs/` that has a page. */
export interface SourcePage {
  /** The file, from the repository root, with `/` separators (`docs/methods/password.md`). */
  file: string
  /** The page's route, with a leading and trailing slash and without the base (`/methods/password/`). */
  route: string
}

/**
 * The route of a Markdown file of `docs/`.
 *
 * `docs/quickstart.md` is `/quickstart/`, `docs/methods/password.md` is `/methods/password/`
 * and a `README.md` is its directory's index (`docs/reference/README.md` is `/reference/`).
 * The index of `docs/` itself is `/docs/`: the landing page owns `/`.
 *
 * @param file - The file from the repository root (`docs/…`).
 * @returns The route.
 */
export function routeOf(file: string): string {
  const inside = file.replace(/^docs\//, '').replace(/\.md$/, '')
  if (inside === 'README') {
    return '/docs/'
  }
  return `/${inside.replace(/(^|\/)README$/, '')}/`.replace(/\/\/+/g, '/')
}

/**
 * Whether a file of `docs/` is in the site's scope.
 *
 * @param file - The file from the repository root.
 * @returns True for a Markdown file outside the excluded directories.
 */
export function inScope(file: string): boolean {
  if (!file.startsWith('docs/') || !file.endsWith('.md')) {
    return false
  }
  const [, first] = file.split('/')
  return !(EXCLUDED_DIRECTORIES as readonly string[]).includes(first as string)
}

/**
 * Every Markdown file the site renders, in a stable order.
 *
 * @param directory - The directory to read; the repository's `docs/` by default.
 * @returns The files with their routes, sorted by path.
 */
export function collectPages(directory: string = DOCS_DIR): SourcePage[] {
  const found: SourcePage[] = []
  function walk(current: string): void {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      const file = relative(REPO_ROOT, path).split(sep).join('/')
      if (inScope(file)) {
        found.push({ file, route: routeOf(file) })
      }
    }
  }
  walk(directory)
  return found
}
