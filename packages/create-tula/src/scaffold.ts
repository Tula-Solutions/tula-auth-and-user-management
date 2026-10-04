import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * This package's version, and the version the scaffolded project's `@tula/*` dependencies are
 * pinned to: the Tula packages are released together. A test holds it equal to `package.json`.
 *
 * @example
 * ```ts
 * `create-tula ${VERSION}` // 'create-tula 0.0.0'
 * ```
 */
export const VERSION = '0.0.0'

/**
 * The frameworks a project can be scaffolded for. Each has a template made from an example app
 * of the Tula repository (`scripts/sync-templates.ts`).
 *
 * @example
 * ```ts
 * FRAMEWORKS.includes('nextjs') // true
 * ```
 */
export const FRAMEWORKS = ['react-vite', 'nextjs'] as const

/**
 * A scaffoldable framework.
 *
 * @example
 * ```ts
 * const framework: Framework = 'react-vite'
 * ```
 */
export type Framework = (typeof FRAMEWORKS)[number]

/**
 * The image reference a new project's `.env` names by default: the tag the Tula repository's
 * own Compose file builds. Nothing is published to a registry yet, so the default is a local
 * tag, and `apiImage` (`--api-image`) overrides it.
 *
 * @example
 * ```ts
 * await scaffold({ cwd, name: 'shop', framework: 'nextjs', apiImage: DEFAULT_API_IMAGE })
 * ```
 */
export const DEFAULT_API_IMAGE = 'tula-api:local'

const FRAMEWORK_DETAILS: Record<Framework, { label: string; appUrl: string }> = {
  'react-vite': { label: 'Vite + React', appUrl: 'http://localhost:5174' },
  nextjs: { label: 'Next.js', appUrl: 'http://localhost:3000' },
}

/** Every Tula package a project can depend on, directly or through another. */
const TULA_PACKAGES = ['contract', 'core', 'react', 'nextjs', 'admin', 'config', 'cli'] as const

/** Never written over, whatever `force` says: they hold secrets that data depends on. */
const NEVER_REPLACED: ReadonlySet<string> = new Set(['.env', '.env.local'])

const RESERVED_NAMES: ReadonlySet<string> = new Set(['node_modules', 'favicon.ico'])

/**
 * A scaffold request that cannot be honoured: an unusable name, a directory that is not empty,
 * a missing tarball. Its message says what to do; it never contains a secret.
 *
 * @example
 * ```ts
 * throw new ScaffoldError('The directory "shop" is not empty.')
 * ```
 */
export class ScaffoldError extends Error {
  /** @param message - What was wrong, and what to do instead. */
  constructor(message: string) {
    super(message)
    this.name = 'ScaffoldError'
  }
}

/**
 * Check a project name. It becomes a directory, the `name` of a `package.json` and a Compose
 * project name, so it has to be valid as all three: lowercase letters, digits, dashes and
 * underscores, starting with a letter or a digit, at most 63 characters. That also rules out
 * anything that could leave the current directory (`..`, a slash).
 *
 * @param name - The name to check.
 * @returns `null` when it is usable, otherwise why not.
 *
 * @example
 * ```ts
 * validateProjectName('my-app')  // null
 * validateProjectName('../evil') // 'A project name is …'
 * ```
 */
export function validateProjectName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name) || RESERVED_NAMES.has(name)) {
    return 'A project name is lowercase letters, digits, dashes and underscores, starts with a letter or a digit, and is at most 63 characters (e.g. my-app). It names the directory, the package and the Compose project.'
  }
  return null
}

/**
 * What to scaffold.
 *
 * @example
 * ```ts
 * const options: ScaffoldOptions = { cwd: process.cwd(), name: 'shop', framework: 'react-vite' }
 * ```
 */
export interface ScaffoldOptions {
  /** The directory the project's directory is created in. */
  cwd: string
  /** The project's name: its directory, its package name and its Compose project name. */
  name: string
  /** The example app to start from. */
  framework: Framework
  /** The Tula API image reference written to `.env`. Default: {@link DEFAULT_API_IMAGE}. */
  apiImage?: string
  /** The host port the API is published on. Default 3003. */
  apiPort?: number
  /** The host port Mailpit's inbox is published on. Default 8025. */
  mailpitPort?: number
  /**
   * A directory of packed Tula tarballs (`tula-react-<version>.tgz`, …, as
   * `bun run packages:check` leaves them in `.release/`). The project then installs every
   * `@tula/*` package from there instead of a registry: the way to try a project while
   * nothing is published.
   */
  tulaPackages?: string
  /** Write into a directory that is not empty. `.env` and `.env.local` are still never replaced. */
  force?: boolean
  /** Random bytes. Default: `crypto.getRandomValues`. */
  random?: (bytes: number) => Uint8Array
}

/**
 * What was scaffolded.
 *
 * @example
 * ```ts
 * const { directory, keptEnv } = await scaffold(options)
 * ```
 */
export interface ScaffoldResult {
  /** The project's directory. */
  directory: string
  /** The files written, relative to the directory. */
  files: string[]
  /** Whether an existing `.env` was kept instead of generating one (`force` only). */
  keptEnv: boolean
  /** Where the app is served once it runs. */
  appUrl: string
}

/**
 * Find this package's `templates` directory from the directory of the running module: beside
 * `src/` in the repository, and one or two levels above a chunk in the published `dist/`.
 *
 * @param from - The directory to start from.
 * @returns The absolute path of `templates`.
 * @throws Error when the package has none (a broken install).
 *
 * @example
 * ```ts
 * findTemplates(import.meta.dirname)
 * ```
 */
export function findTemplates(from: string): string {
  let directory = from
  for (let level = 0; level < 4; level += 1) {
    const candidate = join(directory, 'templates')
    if (existsSync(join(candidate, 'base', 'compose.yaml'))) {
      return candidate
    }
    directory = dirname(directory)
  }
  throw new Error('create-tula cannot find its templates directory: the install is incomplete')
}

const templatesRoot = findTemplates(dirname(fileURLToPath(import.meta.url)))

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name)
    found.push(...(entry.isDirectory() ? await filesUnder(child) : [child]))
  }
  return found.sort()
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

function hex(random: (bytes: number) => Uint8Array, bytes: number): string {
  return Buffer.from(random(bytes)).toString('hex')
}

/** Replace each `{{name}}` with its value. An unknown name is a bug in a template: it throws. */
function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined
    if (value === undefined) {
      throw new Error(`template placeholder {{${name}}} has no value`)
    }
    return value
  })
}

function port(value: number | undefined, fallback: number, option: string): number {
  const chosen = value ?? fallback
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > 65_535) {
    throw new ScaffoldError(`${option} must be a port number from 1 to 65535.`)
  }
  return chosen
}

/** How each Tula package is installed: this release from the registry, or a local tarball. */
async function tulaSpecs(tulaPackages: string | undefined, cwd: string) {
  const specs = new Map<string, string>()
  if (tulaPackages === undefined) {
    for (const name of TULA_PACKAGES) {
      specs.set(`@tula/${name}`, VERSION)
    }
    return { specs, local: false }
  }
  const directory = resolve(cwd, tulaPackages)
  const missing: string[] = []
  for (const name of TULA_PACKAGES) {
    const file = `tula-${name}-${VERSION}.tgz`
    if (await exists(join(directory, file))) {
      specs.set(`@tula/${name}`, `file:${join(directory, file)}`)
    } else {
      missing.push(file)
    }
  }
  if (missing.length > 0) {
    throw new ScaffoldError(
      `--tula-packages needs a tarball of every Tula package, and these are not in that directory: ${missing.join(', ')}. In the Tula repository, \`bun run packages:check\` writes them to .release/.`
    )
  }
  return { specs, local: true }
}

/**
 * Scaffold a Tula project: a Compose file with pinned service images, a `.env` with a freshly
 * generated master key, instance admin token and database passwords (readable by its owner
 * only, and ignored by the project's `.gitignore`), a `tula.config.ts`, a README and the
 * example app of the chosen framework.
 *
 * Nothing is written unless everything can be: the name, the options and the tarballs are
 * checked first. A directory that has files is refused unless `force` is set, and even then
 * an existing `.env` or `.env.local` is kept: replacing a master key would orphan the data
 * sealed with it.
 *
 * @param options - What to scaffold and where.
 * @returns The directory and the files written.
 * @throws ScaffoldError for an unusable name or option, a directory that is not empty, or a
 *   missing tarball.
 *
 * @example
 * ```ts
 * const { directory } = await scaffold({ cwd: process.cwd(), name: 'shop', framework: 'nextjs' })
 * ```
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const problem = validateProjectName(options.name)
  if (problem !== null) {
    throw new ScaffoldError(problem)
  }
  if (!FRAMEWORKS.includes(options.framework)) {
    throw new ScaffoldError(`The framework is one of: ${FRAMEWORKS.join(', ')}.`)
  }
  const apiImage = options.apiImage ?? DEFAULT_API_IMAGE
  // A Docker image reference: no spaces, quotes or shell characters reach .env or the README.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(apiImage)) {
    throw new ScaffoldError('--api-image must be a Docker image reference, e.g. tula-api:local.')
  }
  const apiPort = port(options.apiPort, 3003, '--api-port')
  const mailpitPort = port(options.mailpitPort, 8025, '--mailpit-port')
  const { specs, local } = await tulaSpecs(options.tulaPackages, options.cwd)

  const directory = join(options.cwd, options.name)
  // The name was validated, so this cannot be anywhere but directly inside `cwd`.
  if (relative(options.cwd, directory) !== options.name) {
    throw new ScaffoldError('The project directory must be directly inside the current one.')
  }
  const present = await readdir(directory).catch(() => [] as string[])
  if (present.length > 0 && options.force !== true) {
    throw new ScaffoldError(
      `The directory "${options.name}" is not empty. Choose another name, or pass --force to write into it (an existing .env is always kept).`
    )
  }

  const details = FRAMEWORK_DETAILS[options.framework]
  const values = {
    name: options.name,
    displayName: options.name,
    apiImage,
    apiPort: String(apiPort),
    mailpitPort: String(mailpitPort),
    frameworkLabel: details.label,
    appUrl: details.appUrl,
  }
  const random =
    options.random ?? ((bytes: number) => crypto.getRandomValues(new Uint8Array(bytes)))

  /** Path in the project → contents and mode. Built completely before anything is written. */
  const output = new Map<string, { contents: Uint8Array | string; mode: number }>()
  const add = async (source: string, target: string) => {
    const templated = target.endsWith('.tmpl')
    const path = (templated ? target.slice(0, -'.tmpl'.length) : target).replace(
      /(^|\/)_(gitignore|env\.example)$/,
      '$1.$2'
    )
    const contents = templated
      ? fill(await readFile(source, 'utf8'), values)
      : await readFile(source)
    output.set(path, { contents, mode: path.endsWith('.sh') ? 0o755 : 0o644 })
  }
  const frameworkRoot = join(templatesRoot, options.framework)
  for (const [root, strip] of [
    [join(templatesRoot, 'base'), join(templatesRoot, 'base')],
    [join(frameworkRoot, 'app'), join(frameworkRoot, 'app')],
    [join(frameworkRoot, 'overlay'), join(frameworkRoot, 'overlay')],
  ] as const) {
    for (const file of await filesUnder(root)) {
      await add(file, relative(strip, file))
    }
  }

  const manifest = JSON.parse(await readFile(join(frameworkRoot, 'package.json'), 'utf8')) as {
    name: string
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    overrides?: Record<string, string>
  }
  manifest.name = options.name
  for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith('@tula/')) {
        dependencies[name] = specs.get(name) ?? VERSION
      }
    }
  }
  if (local) {
    // Tula packages depend on each other by version; with nothing published, those have to
    // resolve to the tarballs too.
    manifest.overrides = Object.fromEntries(specs)
  }
  output.set('package.json', { contents: `${JSON.stringify(manifest, null, 2)}\n`, mode: 0o644 })

  const keptEnv = await exists(join(directory, '.env'))
  if (!keptEnv) {
    output.set('.env', {
      mode: 0o600,
      contents: [
        '# Generated by create-tula for this project. Never commit this file (.gitignore covers it).',
        '# Back up TULA_MASTER_KEY: the stored signing keys and provider credentials are sealed with',
        '# it and cannot be opened without it.',
        `COMPOSE_PROJECT_NAME=${options.name}`,
        `TULA_API_IMAGE=${apiImage}`,
        `TULA_MASTER_KEY=${hex(random, 32)}`,
        '# The instance admin token: `tula doctor` and, later, the dashboard sign in with it.',
        `TULA_ADMIN_TOKEN=${hex(random, 32)}`,
        '# Database passwords. They are set when the volume is first created: changing them here',
        '# afterwards needs `tula dev down --volumes`.',
        `POSTGRES_PASSWORD=${hex(random, 24)}`,
        `TULA_API_DB_PASSWORD=${hex(random, 24)}`,
        `API_PORT=${apiPort}`,
        `MAILPIT_UI_PORT=${mailpitPort}`,
        '',
      ].join('\n'),
    })
  }

  const written: string[] = []
  for (const [path, file] of [...output].sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(directory, path)
    if (NEVER_REPLACED.has(path) && (await exists(target))) {
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.contents, { mode: file.mode })
    // `mode` only applies to a file that is created: make it hold for one that was replaced.
    await chmod(target, file.mode)
    written.push(path)
  }
  return { directory, files: written, keptEnv, appUrl: details.appUrl }
}
