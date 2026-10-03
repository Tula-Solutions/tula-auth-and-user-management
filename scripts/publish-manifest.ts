/** Publishable packages, dependencies first. Everything else in the workspace stays private. */
export const PUBLISHABLE_PACKAGES = [
  'packages/contract',
  'packages/core',
  'packages/react',
] as const

/** The fields of a package.json this tooling reads. */
export type Manifest = Record<string, unknown> & {
  name: string
  version: string
  private?: boolean
  files?: string[]
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  publishConfig?: Record<string, unknown>
}

/** `workspace:*` → the exact version being released; `workspace:^` / `workspace:~` → that range. */
function resolveWorkspaceRanges(
  dependencies: Record<string, string> | undefined,
  versions: ReadonlyMap<string, string>
): Record<string, string> | undefined {
  if (!dependencies) {
    return undefined
  }
  const resolved: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (!range.startsWith('workspace:')) {
      resolved[name] = range
      continue
    }
    const version = versions.get(name)
    if (!version) {
      throw new Error(`${name} is a workspace dependency but not a publishable package`)
    }
    const prefix = range.slice('workspace:'.length)
    resolved[name] = prefix === '^' || prefix === '~' ? `${prefix}${version}` : version
  }
  return resolved
}

/**
 * The manifest a package is published with.
 *
 * In the repository `exports` points at the TypeScript sources, so every tool in the monorepo
 * (Bun, tsc, tests, the Docker image) resolves a workspace package without a build. The
 * published manifest takes `publishConfig`'s fields instead (the built `dist/`), drops what
 * only the repository needs, and replaces `workspace:` ranges with real versions.
 *
 * @param manifest - The package's package.json.
 * @param versions - Version of every publishable package, by name.
 * @returns The manifest to publish.
 */
export function publishManifest(
  manifest: Manifest,
  versions: ReadonlyMap<string, string>
): Manifest {
  const { publishConfig, scripts: _scripts, devDependencies: _dev, ...kept } = manifest
  const published: Manifest = { ...kept, ...publishConfig }
  for (const field of ['dependencies', 'peerDependencies'] as const) {
    const resolved = resolveWorkspaceRanges(manifest[field], versions)
    if (resolved) {
      published[field] = resolved
    }
  }
  return published
}
