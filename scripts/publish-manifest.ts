/** Publishable packages, dependencies first. Everything else in the workspace stays private. */
export const PUBLISHABLE_PACKAGES = [
  'packages/contract',
  'packages/core',
  'packages/react',
  'packages/nextjs',
  'packages/expo',
  'packages/admin',
  'packages/config',
  'packages/mcp',
  'packages/cli',
  'packages/create-tula',
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

/**
 * Files a package's tarball must hold, by package name, as paths inside the package.
 *
 * `@tula/expo` ships copies of the native SDKs' sources that only its build makes
 * (`packages/expo/scripts/vendor-native.ts`; they are in no commit). A tarball packed without
 * them has every entry point publint and attw look at and compiles on neither platform, so
 * one known file of each copied directory is asked for by name: the two Swift libraries and
 * the four Android modules (ADR 0063).
 */
export const REQUIRED_PACKED_FILES: Readonly<Record<string, readonly string[]>> = {
  '@tula/expo': [
    'ios/vendor/TulaAuth/TulaClient.swift',
    'ios/vendor/TulaAuthUI/TulaAuthModel.swift',
    'android/vendor/tula-auth/dev/tula/auth/TulaClient.kt',
    'android/vendor/tula-auth-ui/dev/tula/auth/ui/TulaAuthModel.kt',
    'android/vendor/tula-auth-android/dev/tula/auth/android/KeystoreTokenStorage.kt',
    'android/vendor/tula-auth-compose/dev/tula/auth/compose/TulaAuth.kt',
  ],
}

/**
 * The required files a tarball does not hold.
 *
 * @param name - The package's name.
 * @param listing - What `tar -tzf` printed for its tarball: a path a line, each under
 *   `package/`.
 * @returns The missing paths, as written in {@link REQUIRED_PACKED_FILES}; none for a package
 *   with no required file.
 */
export function missingPackedFiles(name: string, listing: string): string[] {
  const required = Object.hasOwn(REQUIRED_PACKED_FILES, name) ? REQUIRED_PACKED_FILES[name] : []
  const held = new Set(listing.split('\n').map((line) => line.trim()))
  return (required ?? []).filter((path) => !held.has(`package/${path}`))
}
