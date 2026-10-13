/**
 * Every package built for npm, dependencies first: `packages:check` builds, stages, packs and
 * checks each of them (publint, arethetypeswrong) in this order. Whether one is also
 * published is {@link HELD_PACKAGES}' business. Everything else in the workspace stays
 * private for good.
 */
export const PUBLISHABLE_PACKAGES = [
  'packages/contract',
  'packages/core',
  'packages/react',
  'packages/nextjs',
  'packages/expo',
  'packages/expo-screens',
  'packages/admin',
  'packages/config',
  'packages/mcp',
  'packages/cli',
  'packages/create-tula',
] as const

/** The directory of a package built for npm. */
export type PublishableDir = (typeof PUBLISHABLE_PACKAGES)[number]

/**
 * Publishable packages that are held back: built and checked like the others, never
 * published, and `"private": true` so that npm itself refuses them. The two Expo packages
 * have never been run on a device (docs/releasing.md).
 *
 * Releasing one is deleting its line here, removing `"private": true` from its manifest and
 * taking its name out of `create-tula`'s `UNRELEASED_TULA_PACKAGES`; the guardrail test
 * (`.claude/hooks/release.test.ts`) fails until the three agree.
 */
export const HELD_PACKAGES: readonly PublishableDir[] = ['packages/expo', 'packages/expo-screens']

/**
 * The packages a release publishes, dependencies first: the publishable ones that are not
 * held back. Derived, so a package is in exactly one of the two states.
 */
export const RELEASED_PACKAGES: readonly PublishableDir[] = PUBLISHABLE_PACKAGES.filter(
  (dir) => !HELD_PACKAGES.includes(dir)
)

/**
 * What the release tooling does with a workspace package: `released` (built, checked and
 * published), `held` (built and checked, never published) or `private` (neither).
 */
export type ReleaseState = 'released' | 'held' | 'private'

/**
 * The state of a workspace package.
 *
 * @param dir - The package's directory from the repository's root, e.g. `packages/core`.
 * @returns Its state; `private` for anything that is not built for npm.
 */
export function releaseState(dir: string): ReleaseState {
  if ((HELD_PACKAGES as readonly string[]).includes(dir)) {
    return 'held'
  }
  return (RELEASED_PACKAGES as readonly string[]).includes(dir) ? 'released' : 'private'
}

/** The fields of a package.json this tooling reads. */
export type Manifest = Record<string, unknown> & {
  name: string
  version: string
  private?: boolean
  files?: string[]
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  publishConfig?: Record<string, unknown>
}

/** The fields that name what a consumer's install has to fetch. `devDependencies` is not one. */
const RUNTIME_DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

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
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const resolved = resolveWorkspaceRanges(manifest[field], versions)
    if (resolved) {
      published[field] = resolved
    }
  }
  return published
}

/**
 * Whether each workspace package's `private` field is what its state says: a released
 * package is not private, and everything else is. This is the first thing that stops a
 * package from reaching npm (npm refuses a private one), so a held or private package that
 * loses the field is a failure, not a warning.
 *
 * @param manifests - Every workspace package: its directory and its package.json.
 * @returns One sentence a mismatch; none when every package is in its state.
 */
export function privateStateProblems(
  manifests: readonly { dir: string; manifest: Manifest }[]
): string[] {
  const problems: string[] = []
  for (const { dir, manifest } of manifests) {
    const state = releaseState(dir)
    const isPrivate = manifest.private === true
    if (state === 'released' && isPrivate) {
      problems.push(
        `${dir} (${manifest.name}) is in RELEASED_PACKAGES and is "private": true: npm would refuse it`
      )
    }
    if (state !== 'released' && !isPrivate) {
      problems.push(
        `${dir} (${manifest.name}) is ${state === 'held' ? 'held back' : 'not a released package'} and is not "private": true`
      )
    }
  }
  for (const dir of RELEASED_PACKAGES) {
    if (!manifests.some((entry) => entry.dir === dir)) {
      problems.push(`${dir} is in RELEASED_PACKAGES and has no package.json`)
    }
  }
  return problems
}

/**
 * The workspace packages a released package needs at run time that are not released
 * themselves: a held-back one, the API, the database package, an example. Installing the
 * released package would then fail, or pull something that was never meant to leave the
 * repository. A dependency is caught by its name whatever its range says, so a held package
 * named by a version (`"@tula/expo": "^0.1.0"`) is refused like one named by `workspace:*`.
 * `devDependencies` do not count: the published manifest drops them.
 *
 * @param manifest - A released package's package.json, as it is in the repository.
 * @param released - The names of the released packages.
 * @param workspace - The names of every workspace package.
 * @returns The offending dependencies, each with the field it is in; none when there are none.
 */
export function unreleasedRuntimeDependencies(
  manifest: Manifest,
  released: ReadonlySet<string>,
  workspace: ReadonlySet<string>
): string[] {
  const found: string[] = []
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      const local = workspace.has(name) || range.startsWith('workspace:')
      if (local && !released.has(name)) {
        found.push(`${name} (${field})`)
      }
    }
  }
  return found
}

/** Every string in a value, however deep: the targets of `exports` and `bin`. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(stringsOf)
  }
  return []
}

/**
 * What is wrong with a manifest for a consumer: the package.json a tarball holds, which is
 * what npm serves. A released package's must be publishable as it is.
 *
 * @param manifest - The package.json read back from the tarball.
 * @returns One sentence a problem: still private, a `workspace:` range left, repository-only
 *   fields left, an entry point that is not in `dist/`. None for a manifest that can go out.
 */
export function stagedManifestProblems(manifest: Manifest): string[] {
  const problems: string[] = []
  if (manifest.private !== undefined) {
    problems.push(`${manifest.name}: the packed manifest has "private": ${manifest.private}`)
  }
  for (const field of [...RUNTIME_DEPENDENCY_FIELDS, 'devDependencies'] as const) {
    const ranges = (manifest[field] as Record<string, unknown> | undefined) ?? {}
    for (const [name, range] of Object.entries(ranges)) {
      if (String(range).startsWith('workspace:')) {
        problems.push(`${manifest.name}: ${field}.${name} is still "${range}"`)
      }
    }
  }
  for (const field of ['scripts', 'devDependencies', 'publishConfig']) {
    if (manifest[field] !== undefined) {
      problems.push(`${manifest.name}: the packed manifest still has "${field}"`)
    }
  }
  for (const target of [...stringsOf(manifest.exports), ...stringsOf(manifest.bin)]) {
    const shipped = target === './package.json' || target === './openapi.json'
    if (!shipped && !target.startsWith('./dist/')) {
      problems.push(`${manifest.name}: the entry point ${target} is not in dist/`)
    }
  }
  return problems
}

/**
 * The paths in a tarball that must not reach a consumer: the package's own sources, a test
 * in the build output, installed dependencies, an environment file or an npm configuration
 * (which can hold a token). `create-tula`'s templates are example apps and keep their own
 * `src/` and UI tests, so only the package's top level and its `dist/` are judged for those.
 *
 * @param listing - What `tar -tzf` printed for the tarball: a path a line.
 * @returns The offending paths; none for a clean tarball.
 */
export function leakedPackedFiles(listing: string): string[] {
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((path) => path !== '')
    .filter(
      (path) =>
        !path.startsWith('package/') ||
        path.startsWith('package/src/') ||
        /^package\/dist\/.*\.(test|spec)\.(d\.)?[cm]?[jt]sx?$/.test(path) ||
        /(^|\/)node_modules\//.test(path) ||
        /(^|\/)\.npmrc$/.test(path) ||
        // `.env.example` is the one environment file that is meant to travel.
        (/(^|\/)\.env(\.|$)/.test(path) && !/(^|\/)\.env\.example$/.test(path))
    )
}

/**
 * Files a package's tarball must hold, by package name, as paths inside the package.
 *
 * `@tula/expo-screens` ships copies of the native SDKs' sources that only its build makes
 * (`packages/expo-screens/scripts/vendor-native.ts`; they are in no commit). A tarball packed without
 * them has every entry point publint and attw look at and compiles on neither platform, so
 * one known file of each copied directory is asked for by name: the two Swift libraries and
 * the four Android modules (ADR 0063).
 */
export const REQUIRED_PACKED_FILES: Readonly<Record<string, readonly string[]>> = {
  '@tula/expo-screens': [
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
