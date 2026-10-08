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
}

/** The scaffoldable frameworks and the example each one is made from. */
export const TEMPLATE_SOURCES: Readonly<Record<string, TemplateSource>> = {
  'react-vite': {
    example: 'examples/react-vite',
    include: ['index.html', 'vite.config.ts', 'src'],
  },
  nextjs: {
    example: 'examples/nextjs-app-router',
    include: ['app', 'proxy.ts', 'types.d.ts'],
  },
}

/** Tooling a scaffolded project has that the example gets from the workspace. */
const PROJECT_DEV_DEPENDENCIES = ['@tula/cli', '@tula/config']

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
    if (name === '@tula/tsconfig') {
      continue
    }
    // `*` marks a Tula package: create-tula pins it when it scaffolds.
    kept[name] = range.startsWith('workspace:') ? '*' : range
  }
  return kept
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
  for (const entry of source.include) {
    for (const file of await filesUnder(join(example, entry))) {
      files.set(join('app', relative(example, file)), await Bun.file(file).bytes())
    }
  }
  const manifest = (await Bun.file(join(example, 'package.json')).json()) as {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const rootManifest = (await Bun.file(join(repo, 'package.json')).json()) as {
    devDependencies?: Record<string, string>
  }
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
    scripts: { ...scripts, typecheck: 'tsc --noEmit -p .' },
    dependencies: withoutWorkspace(manifest.dependencies),
    devDependencies: Object.fromEntries(
      Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))
    ),
  }
  files.set('package.json', new TextEncoder().encode(`${JSON.stringify(derived, null, 2)}\n`))
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
