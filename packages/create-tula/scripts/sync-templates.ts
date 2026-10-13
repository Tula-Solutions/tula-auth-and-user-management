import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

// The example apps in `examples/` are the one source of the scaffolded apps. This script
// copies their sources into `templates/<framework>/app` and derives each template's
// package.json from the example's own, so a scaffolded app is the example, minus what only
// makes sense inside this repository. `--check` fails instead of writing when the templates
// are out of date (part of `bun run verify`, and a test).

const root = join(import.meta.dir, '..')
const repo = join(root, '..', '..')

/** A framework's template: where it comes from and which of its files are the app. */
export interface TemplateSource {
  /** The example's directory, from the repository root. */
  example: string
  /** Files and directories of the example that are copied as they are. */
  include: readonly string[]
  /**
   * The directory of the project the example's files go to. Left out, the project's root: a
   * web app is the project. A native app gets a directory of its own beside the server's
   * files (`app`, `ios`, `android/app`).
   */
  into?: string
  /** Other files of the repository copied as they are: path in the project to path in the repository. */
  copies?: Readonly<Record<string, string>>
  /**
   * Files made from a file of the repository by a function: path in the project to the
   * source and what is done to it. A derived file may be a `.tmpl`; a copied one never is.
   */
  derived?: Readonly<Record<string, { from: string; make: (text: string) => string }>>
  /**
   * Where the project's own `package.json` comes from: the example's manifest (a web app
   * is the project), or only the tooling a project needs (`tula` and the config's types).
   */
  manifest: 'example' | 'tooling'
}

/** The directory of the Swift package inside the repository, as the example's project names it. */
const SWIFT_PACKAGE_IN_REPOSITORY = '../../native/swift'

/** Exactly `count` occurrences of `find` replaced, or the example is not what was expected. */
function replaceExactly(text: string, find: string, replacement: string, count: number): string {
  const parts = text.split(find)
  if (parts.length - 1 !== count) {
    throw new Error(
      `expected ${count} occurrences of ${JSON.stringify(find)} and found ${parts.length - 1}: the example changed, and the template's derivation has to follow`
    )
  }
  return parts.join(replacement)
}

/** A file that becomes a template must not already hold something that reads as a placeholder. */
function withoutPlaceholders(text: string): string {
  if (/\{\{\w+\}\}/.test(text)) {
    throw new Error('a file that becomes a template already holds a {{placeholder}}')
  }
  return text
}

/**
 * The example's Xcode project with the one thing a scaffolded project cannot keep: the path
 * to the Swift package, which in the repository is two directories up. Nothing is published,
 * so the path stays a path, to a checkout the developer names (`--tula-repo`).
 */
function xcodeProject(text: string): string {
  const named = replaceExactly(
    withoutPlaceholders(text),
    `XCLocalSwiftPackageReference "${SWIFT_PACKAGE_IN_REPOSITORY}"`,
    'XCLocalSwiftPackageReference "{{tulaSwiftPackage}}"',
    2
  )
  return replaceExactly(
    named,
    `relativePath = ${SWIFT_PACKAGE_IN_REPOSITORY};`,
    'relativePath = "{{tulaSwiftPackage}}";',
    1
  )
}

/** The Kotlin SDK's own Gradle properties, and where its build is (a checkout: `--tula-repo`). */
function gradleProperties(text: string): string {
  return [
    withoutPlaceholders(text).replace(/\n$/, ''),
    '# Where the Tula repository is checked out, from this directory. The Kotlin SDK is not',
    '# published: settings.gradle.kts takes its modules and its version catalog from there.',
    'tulaRepo={{tulaRepoFromAndroid}}',
    '',
  ].join('\n')
}

/** The Expo example's manifest as a scaffolded app has it: Tula packages marked for pinning. */
function expoManifest(text: string): string {
  const manifest = JSON.parse(text) as {
    main?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const dependencies: Record<string, string> = {}
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    // The example installs this checkout's packed packages by path; `*` marks a Tula package
    // and create-tula pins it when it scaffolds.
    dependencies[name] = name.startsWith('@tula-tech/') ? '*' : range
  }
  const derived = {
    name: 'tula-app',
    version: '0.0.0',
    private: true,
    main: manifest.main,
    scripts: manifest.scripts,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
    ),
    devDependencies: manifest.devDependencies,
  }
  return `${JSON.stringify(derived, null, 2)}\n`
}

/** The scaffoldable frameworks and the example each one is made from. */
export const TEMPLATE_SOURCES: Readonly<Record<string, TemplateSource>> = {
  'react-vite': {
    example: 'examples/react-vite',
    include: ['index.html', 'vite.config.ts', 'src'],
    manifest: 'example',
  },
  nextjs: {
    example: 'examples/nextjs-app-router',
    include: ['app', 'proxy.ts', 'types.d.ts'],
    manifest: 'example',
  },
  // The three native examples. None is a workspace package, and each gets a directory of its
  // own in the project, beside the server's files.
  expo: {
    example: 'examples/expo/app',
    include: [
      '.env.example',
      '.gitignore',
      'App.tsx',
      'app.config.ts',
      'app.json',
      'index.ts',
      'src',
      'tsconfig.json',
    ],
    into: 'app',
    derived: { 'app/package.json': { from: 'examples/expo/app/package.json', make: expoManifest } },
    manifest: 'tooling',
  },
  swiftui: {
    example: 'examples/swiftui',
    // The UI tests come along because the project file names their target: they run only
    // against the repository's fixture, and the template's README says so.
    include: [
      '.gitignore',
      'Info.plist',
      'TulaExample',
      'TulaExample.xcodeproj/xcshareddata',
      'TulaExampleUITests',
    ],
    into: 'ios',
    derived: {
      'ios/TulaExample.xcodeproj/project.pbxproj.tmpl': {
        from: 'examples/swiftui/TulaExample.xcodeproj/project.pbxproj',
        make: xcodeProject,
      },
    },
    manifest: 'tooling',
  },
  compose: {
    example: 'examples/compose',
    // `src/androidTest` drives the app against the repository's own fixture
    // (native/android/fixture): it is not something a project can run, and Gradle needs no
    // file to name it, so it is left out. `src/debug` and `src/release` are not: each holds
    // the `ExampleSheets` its build variant compiles `MainActivity` against.
    include: ['.gitignore', 'build.gradle.kts', 'src/debug', 'src/main', 'src/release'],
    into: 'android/app',
    // The plugins of the Kotlin SDK's build, at the versions its catalog pins.
    copies: { 'android/build.gradle.kts': 'native/android/build.gradle.kts' },
    derived: {
      'android/gradle.properties.tmpl': {
        from: 'native/android/gradle.properties',
        make: gradleProperties,
      },
    },
    manifest: 'tooling',
  },
}

/** Tooling a scaffolded project has that the example gets from the workspace. */
const PROJECT_DEV_DEPENDENCIES = ['@tula-tech/cli', '@tula-tech/config']

/**
 * A file's name as a template carries it. npm leaves a `.gitignore` out of a package, so the
 * templates spell the two dot files with an underscore and create-tula puts the dot back.
 */
function templatePath(path: string): string {
  return path.replace(/(^|\/)\.(gitignore|env\.example)$/, '$1_$2')
}

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
  if (entries === null) {
    return [path]
  }
  const found: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name)
    found.push(...(entry.isDirectory() ? await filesUnder(child) : [child]))
  }
  return found
}

function withoutWorkspace(dependencies: Record<string, string> | undefined) {
  const kept: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies ?? {})) {
    if (name === '@tula-tech/tsconfig') {
      continue
    }
    // `*` marks a Tula package: create-tula pins it when it scaffolds.
    kept[name] = range.startsWith('workspace:') ? '*' : range
  }
  return kept
}

/** The project's own `package.json`, before create-tula names it and pins the Tula packages. */
async function projectManifest(source: TemplateSource): Promise<string> {
  const rootManifest = (await Bun.file(join(repo, 'package.json')).json()) as {
    devDependencies?: Record<string, string>
  }
  const manifest: {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  } =
    source.manifest === 'example'
      ? await Bun.file(join(repo, source.example, 'package.json')).json()
      : {}
  const devDependencies = withoutWorkspace(manifest.devDependencies)
  for (const name of PROJECT_DEV_DEPENDENCIES) {
    devDependencies[name] = '*'
  }
  devDependencies.typescript = rootManifest.devDependencies?.typescript ?? '*'
  const { typecheck: _typecheck, ...scripts } = manifest.scripts ?? {}
  const derived = {
    name: 'tula-app',
    version: '0.0.0',
    private: true,
    type: 'module',
    // A native project's root holds no TypeScript of an app: only `tula.config.ts`, which
    // `tula diff` loads and checks.
    scripts:
      source.manifest === 'example' ? { ...scripts, typecheck: 'tsc --noEmit -p .' } : scripts,
    dependencies: withoutWorkspace(manifest.dependencies),
    devDependencies: Object.fromEntries(
      Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))
    ),
  }
  return `${JSON.stringify(derived, null, 2)}\n`
}

/**
 * What a framework's template should contain, by path relative to `templates/<framework>`.
 *
 * @param framework - The framework's name.
 * @returns Each file's contents.
 */
export async function expectedTemplate(framework: string): Promise<Map<string, Uint8Array>> {
  const source = TEMPLATE_SOURCES[framework]
  if (!source) {
    throw new Error(`unknown framework ${framework}`)
  }
  const example = join(repo, source.example)
  const files = new Map<string, Uint8Array>()
  const put = (path: string, contents: Uint8Array) => {
    const target = join('app', templatePath(path))
    if (files.has(target)) {
      throw new Error(`${framework}: two sources for ${path}`)
    }
    files.set(target, contents)
  }
  for (const entry of source.include) {
    for (const file of await filesUnder(join(example, entry))) {
      if (file.endsWith('.tmpl')) {
        // create-tula fills placeholders in `.tmpl` files only, and a copy is never filled.
        throw new Error(`${framework}: ${relative(repo, file)} would be read as a template`)
      }
      put(join(source.into ?? '', relative(example, file)), await Bun.file(file).bytes())
    }
  }
  for (const [path, from] of Object.entries(source.copies ?? {})) {
    put(path, await Bun.file(join(repo, from)).bytes())
  }
  for (const [path, { from, make }] of Object.entries(source.derived ?? {})) {
    put(path, new TextEncoder().encode(make(await Bun.file(join(repo, from)).text())))
  }
  files.set('package.json', new TextEncoder().encode(await projectManifest(source)))
  return files
}

/**
 * The files of `templates/<framework>` that the sync owns (everything but `overlay/`).
 *
 * @param framework - The framework's name.
 * @returns Paths relative to `templates/<framework>`.
 */
export async function syncedFiles(framework: string): Promise<string[]> {
  const base = join(root, 'templates', framework)
  const found = [
    ...(await filesUnder(join(base, 'app'))),
    ...((await Bun.file(join(base, 'package.json')).exists()) ? [join(base, 'package.json')] : []),
  ]
  return found.filter((file) => file !== join(base, 'app')).map((file) => relative(base, file))
}

/**
 * Compare the committed templates with what the examples say they should be.
 *
 * @returns The paths that differ, are missing or should not be there; empty when in sync.
 */
export async function templateDrift(): Promise<string[]> {
  const drift: string[] = []
  for (const framework of Object.keys(TEMPLATE_SOURCES)) {
    const expected = await expectedTemplate(framework)
    const base = join(root, 'templates', framework)
    for (const [path, contents] of expected) {
      const file = Bun.file(join(base, path))
      if (
        !(await file.exists()) ||
        !Buffer.from(await file.bytes()).equals(Buffer.from(contents))
      ) {
        drift.push(`${framework}/${path}`)
      }
    }
    for (const path of await syncedFiles(framework)) {
      if (!expected.has(path)) {
        drift.push(`${framework}/${path} (not in the example)`)
      }
    }
  }
  return drift
}

async function write(): Promise<void> {
  for (const framework of Object.keys(TEMPLATE_SOURCES)) {
    const base = join(root, 'templates', framework)
    await rm(join(base, 'app'), { recursive: true, force: true })
    for (const [path, contents] of await expectedTemplate(framework)) {
      await mkdir(dirname(join(base, path)), { recursive: true })
      await Bun.write(join(base, path), contents)
    }
  }
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const drift = await templateDrift()
    if (drift.length > 0) {
      process.stderr.write(
        `create-tula templates are out of date: run \`bun run --filter create-tula templates:sync\`\n${drift.map((path) => `  ${path}`).join('\n')}\n`
      )
      process.exit(1)
    }
    process.stdout.write('create-tula templates are up to date\n')
  } else {
    await write()
    process.stdout.write('wrote packages/create-tula/templates\n')
  }
}
