import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ToolError } from './errors'

/**
 * The frameworks the scaffold tools know.
 *
 * @example
 * ```ts
 * const framework: ScaffoldFramework = 'nextjs'
 * ```
 */
export const SCAFFOLD_FRAMEWORKS = ['nextjs', 'react-vite'] as const

/**
 * A framework a scaffold can be made for.
 *
 * @example
 * ```ts
 * const framework: ScaffoldFramework = 'react-vite'
 * ```
 */
export type ScaffoldFramework = (typeof SCAFFOLD_FRAMEWORKS)[number]

/**
 * What `detect_framework` found.
 *
 * @example
 * ```ts
 * const found: DetectedFramework = { directory: '.', framework: 'nextjs', supported: true, tulaPackages: [] }
 * ```
 */
export interface DetectedFramework {
  /** The directory that was looked at, relative to the server's working directory. */
  directory: string
  /** The framework, or `unknown`. */
  framework: ScaffoldFramework | 'unknown'
  /** Whether the scaffold tools have files for it. */
  supported: boolean
  /** Which Tula packages the project already depends on. */
  tulaPackages: string[]
}

/** The largest `package.json` that is read. */
const MAX_MANIFEST_BYTES = 1_000_000

/** The Tula packages worth reporting. Only these names can appear in the answer. */
const TULA_PACKAGES = ['@tula/nextjs', '@tula/react', '@tula/core', '@tula/admin', '@tula/cli']

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

const OUTSIDE = new ToolError(
  'path.outside_root',
  'That directory is outside the directory this server was started in.'
)

/**
 * Work out which framework a project uses from its `package.json`, and nothing else.
 *
 * The directory must be inside `root` (the server's working directory), both as written and
 * after symbolic links are followed, and `package.json` must be a regular file there. Only
 * that one file is read, and nothing of it is returned but the framework and which Tula
 * packages it names.
 *
 * @param root - The server's working directory.
 * @param directory - The project directory, relative to `root` (or absolute, inside it).
 * @returns What was found.
 * @throws ToolError `path.outside_root`, `path.not_found` or `package.invalid`.
 *
 * @example
 * ```ts
 * const { framework } = await detectFramework(process.cwd(), 'apps/web')
 * ```
 */
export async function detectFramework(root: string, directory: string): Promise<DetectedFramework> {
  if (directory.includes('\0')) {
    throw OUTSIDE
  }
  const rootReal = await realpath(root)
  // As written: `..`, or an absolute path elsewhere, is refused before the disk is touched.
  const lexical = resolve(rootReal, directory)
  if (!inside(rootReal, lexical) && !inside(resolve(root), resolve(root, directory))) {
    throw OUTSIDE
  }
  const real = await realpath(inside(rootReal, lexical) ? lexical : resolve(root, directory)).catch(
    () => {
      throw new ToolError('path.not_found', 'There is no such directory.')
    }
  )
  // After links are followed: a link that leads out of the root is refused.
  if (!inside(rootReal, real)) {
    throw OUTSIDE
  }
  const manifest = join(real, 'package.json')
  const stats = await lstat(manifest).catch(() => {
    throw new ToolError('path.not_found', 'There is no package.json in that directory.')
  })
  if (stats.isSymbolicLink()) {
    throw OUTSIDE
  }
  if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) {
    throw new ToolError('package.invalid', 'The package.json there is not a readable file.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifest, 'utf8'))
  } catch {
    throw new ToolError('package.invalid', 'The package.json there is not valid JSON.')
  }
  const names = new Set<string>()
  if (typeof parsed === 'object' && parsed !== null) {
    for (const field of ['dependencies', 'devDependencies'] as const) {
      const section = (parsed as Record<string, unknown>)[field]
      if (typeof section === 'object' && section !== null && !Array.isArray(section)) {
        for (const name of Object.keys(section)) {
          names.add(name)
        }
      }
    }
  }
  const framework: DetectedFramework['framework'] = names.has('next')
    ? 'nextjs'
    : names.has('vite') && names.has('react')
      ? 'react-vite'
      : 'unknown'
  return {
    directory: relative(rootReal, real).split(sep).join('/') || '.',
    framework,
    supported: framework !== 'unknown',
    tulaPackages: TULA_PACKAGES.filter((name) => names.has(name)),
  }
}
