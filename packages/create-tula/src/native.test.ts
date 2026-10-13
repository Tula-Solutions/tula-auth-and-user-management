import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { expectedTemplate, TEMPLATE_SOURCES } from '../scripts/sync-templates'
import { FRAMEWORKS, type Framework, main, needsTulaRepo, scaffold } from './index'
import { ScaffoldError } from './scaffold'

// The three native templates: the Expo, SwiftUI and Compose example apps, each in a directory
// of its own beside the server's files. What every template shares (the secrets, the
// `.gitignore`, the refusals) is tested in scaffold.test.ts on the web ones; this file holds
// what is the native templates' own, and that the shared rules hold for them too.

const repo = join(import.meta.dir, '..', '..', '..')
const NATIVE = ['expo', 'swiftui', 'compose'] as const satisfies readonly Framework[]

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'create-tula-native-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function tree(root: string): Promise<string[]> {
  const found: string[] = []
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        await walk(child)
      } else {
        found.push(relative(root, child))
      }
    }
  }
  await walk(root)
  return found.sort()
}

/** Scaffold a native template the way its framework needs: with the checkout where one is needed. */
function make(framework: Framework, name = 'shop', extra: { force?: boolean } = {}) {
  return scaffold({
    cwd: dir,
    name,
    framework,
    ...(needsTulaRepo(framework) ? { tulaRepo: repo } : {}),
    ...extra,
  })
}

const SERVER_FILES = [
  '.env',
  '.env.example',
  '.gitignore',
  'README.md',
  'compose.yaml',
  'docker/postgres/init.sh',
  'package.json',
  'tula.config.ts',
]

describe('the native templates', () => {
  test('there are three, after the two web ones', () => {
    expect(FRAMEWORKS).toEqual(['react-vite', 'nextjs', ...NATIVE])
    expect(Object.keys(TEMPLATE_SOURCES)).toEqual([...FRAMEWORKS])
    expect(FRAMEWORKS.filter(needsTulaRepo)).toEqual(['swiftui', 'compose'])
  })

  test('expo: the server’s files at the root and the app, with its own manifest, in app/', async () => {
    const { directory, appUrl, start } = await make('expo')
    expect(await tree(directory)).toEqual(
      [
        ...SERVER_FILES,
        'app/.env.example',
        'app/.gitignore',
        'app/App.tsx',
        'app/app.config.ts',
        'app/app.json',
        'app/index.ts',
        'app/package.json',
        'app/src/screens.tsx',
        'app/src/setup.ts',
        'app/src/tula.ts',
        'app/src/ui.tsx',
        'app/src/ways.tsx',
        'app/tsconfig.json',
      ].sort()
    )
    expect(appUrl).toBeNull()
    expect(start.map(([command]) => command)).toContain('bunx expo run:ios')
    // The project's own manifest is tooling only: Expo and React Native are the app's.
    const project = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    expect(project.name).toBe('shop')
    expect(project.dependencies).toEqual({})
    expect(Object.keys(project.devDependencies)).toEqual([
      '@tula/cli',
      '@tula/config',
      'typescript',
    ])
    const app = JSON.parse(await readFile(join(directory, 'app/package.json'), 'utf8'))
    expect(app.name).toBe('shop-app')
    expect(app.main).toBe('index.ts')
    expect(app.dependencies['@tula/expo']).toBe('0.0.0')
    expect(app.dependencies['@tula/core']).toBe('0.0.0')
    expect(app.dependencies.expo).toMatch(/^~\d/)
    // Nothing of the repository's own layout is left: no path to a tarball of a checkout.
    expect(JSON.stringify(app)).not.toContain('.release')
    expect(app.overrides).toBeUndefined()
  })

  test('expo: local tarballs reach the app’s own manifest too', async () => {
    const tarballs = join(dir, 'release')
    await mkdir(tarballs)
    for (const name of [
      'contract',
      'core',
      'react',
      'nextjs',
      'expo',
      'admin',
      'config',
      'mcp',
      'cli',
    ]) {
      await writeFile(join(tarballs, `tula-${name}-0.0.0.tgz`), '')
    }
    const { directory } = await scaffold({
      cwd: dir,
      name: 'shop',
      framework: 'expo',
      tulaPackages: 'release',
    })
    const app = JSON.parse(await readFile(join(directory, 'app/package.json'), 'utf8'))
    expect(app.dependencies['@tula/expo']).toBe(`file:${join(tarballs, 'tula-expo-0.0.0.tgz')}`)
    // @tula/expo depends on @tula/core by version: that has to come from the directory too.
    expect(app.overrides['@tula/core']).toBe(`file:${join(tarballs, 'tula-core-0.0.0.tgz')}`)
  })

  test('swiftui: the Xcode project names the Swift package by a path into the checkout', async () => {
    const { directory, start } = await make('swiftui')
    expect(await tree(directory)).toEqual(
      [
        ...SERVER_FILES,
        'ios/.gitignore',
        'ios/Info.plist',
        'ios/TulaExample.xcodeproj/project.pbxproj',
        'ios/TulaExample.xcodeproj/xcshareddata/xcschemes/TulaExample.xcscheme',
        'ios/TulaExample/SessionView.swift',
        'ios/TulaExample/SetupView.swift',
        'ios/TulaExample/TulaExampleApp.swift',
        'ios/TulaExampleUITests/AuthScreensUITests.swift',
        'ios/TulaExampleUITests/SecondStepAndAccountUITests.swift',
        'ios/TulaExampleUITests/Support.swift',
      ].sort()
    )
    expect(start[0]?.[0]).toBe('open ios/TulaExample.xcodeproj')
    const project = await readFile(
      join(directory, 'ios/TulaExample.xcodeproj/project.pbxproj'),
      'utf8'
    )
    const path = /relativePath = "([^"]+)";/.exec(project)?.[1] as string
    // The temporary directory is reached through a symbolic link on macOS: the path is worked
    // out from real paths, or it would lead somewhere else.
    expect(resolve(await realpath(join(directory, 'ios')), path)).toBe(
      await realpath(join(repo, 'native/swift'))
    )
    expect(project.split(path).length - 1).toBe(3)
    // Apart from that path, the project file is the example's.
    const example = await readFile(
      join(repo, 'examples/swiftui/TulaExample.xcodeproj/project.pbxproj'),
      'utf8'
    )
    expect(project.replaceAll(`"${path}"`, '../../native/swift')).toBe(
      example.replaceAll('"../../native/swift"', '../../native/swift')
    )
    expect(await readFile(join(directory, 'README.md'), 'utf8')).toContain(path)
  })

  test('compose: a Gradle build of its own that takes the SDK’s modules from the checkout', async () => {
    const { directory, start } = await make('compose')
    expect(await tree(directory)).toEqual(
      [
        ...SERVER_FILES,
        'android/.gitignore',
        'android/app/.gitignore',
        'android/app/build.gradle.kts',
        'android/app/src/debug/kotlin/dev/tula/example/compose/ExampleSheets.kt',
        'android/app/src/main/AndroidManifest.xml',
        'android/app/src/main/kotlin/dev/tula/example/compose/MainActivity.kt',
        'android/app/src/main/res/drawable/ic_launcher.xml',
        'android/app/src/main/res/values/strings.xml',
        'android/app/src/main/res/xml/backup_rules.xml',
        'android/app/src/main/res/xml/data_extraction_rules.xml',
        'android/app/src/main/res/xml/network_security_config.xml',
        'android/app/src/release/kotlin/dev/tula/example/compose/ExampleSheets.kt',
        'android/build.gradle.kts',
        'android/gradle.properties',
        'android/settings.gradle.kts',
      ].sort()
    )
    expect(start[0]?.[0]).toContain('gradlew -p android :app:installDebug')
    const properties = await readFile(join(directory, 'android/gradle.properties'), 'utf8')
    const path = /^tulaRepo=(.+)$/m.exec(properties)?.[1] as string
    expect(resolve(await realpath(join(directory, 'android')), path)).toBe(await realpath(repo))
    // The SDK build's own properties come first, unchanged.
    expect(
      properties.startsWith(await readFile(join(repo, 'native/android/gradle.properties'), 'utf8'))
    ).toBe(true)
    const settings = await readFile(join(directory, 'android/settings.gradle.kts'), 'utf8')
    expect(settings).toContain('rootProject.name = "shop"')
    expect(settings).toContain('include(":app")')
    // Every module the app's build file asks for is one the settings include.
    const build = await readFile(join(directory, 'android/app/build.gradle.kts'), 'utf8')
    for (const [, module] of build.matchAll(/project\(":([a-z-]+)"\)/g)) {
      expect(settings).toContain(`"${module}"`)
    }
    // And the settings name only modules the checkout has.
    for (const module of /listOf\(([^)]+)\)/.exec(settings)?.[1]?.match(/[a-z-]+/g) ?? []) {
      expect((await stat(join(repo, 'native/android', module, 'build.gradle.kts'))).isFile()).toBe(
        true
      )
    }
    // The README's command reaches the checkout's wrapper from the project's root.
    const readme = await readFile(join(directory, 'README.md'), 'utf8')
    const wrapper = /(\S+)\/native\/android\/gradlew -p android/.exec(readme)?.[1] as string
    expect(resolve(await realpath(directory), wrapper)).toBe(await realpath(repo))
  })

  test('no registry, coordinate or package address is invented for an SDK that is not published', async () => {
    for (const framework of ['swiftui', 'compose'] as const) {
      const { directory } = await make(framework, framework)
      for (const file of await tree(directory)) {
        const text = await readFile(join(directory, file), 'utf8')
        // A Maven coordinate of the SDK, a Swift package by address, a registry of ours.
        expect(`${file}: ${/["'(]dev\.tula[\w.]*:[\w-]+/.test(text)}`).toBe(`${file}: false`)
        expect(`${file}: ${/XCRemoteSwiftPackageReference|repositoryURL/.test(text)}`).toBe(
          `${file}: false`
        )
        expect(`${file}: ${/maven\s*\{|maven\(/.test(text)}`).toBe(`${file}: false`)
      }
    }
  })

  test.each<Framework>([...NATIVE])(
    '%s: every file but a template is the example’s, byte for byte, and no placeholder is left',
    async (framework) => {
      const { directory } = await make(framework)
      const template = await expectedTemplate(framework)
      let copied = 0
      for (const [path, contents] of template) {
        if (!path.startsWith('app/') || path.endsWith('.tmpl') || path.endsWith('/package.json')) {
          continue
        }
        const written = path
          .slice('app/'.length)
          .replace(/(^|\/)_(gitignore|env\.example)$/, '$1.$2')
        expect(
          Buffer.from(await readFile(join(directory, written))).equals(Buffer.from(contents))
        ).toBe(true)
        copied += 1
      }
      expect(copied).toBeGreaterThan(5)
      for (const file of await tree(directory)) {
        const text = await readFile(join(directory, file), 'utf8')
        expect(`${file}: ${/\{\{\w+\}\}/.test(text)}`).toBe(`${file}: false`)
      }
    }
  )

  test.each<Framework>([...NATIVE])(
    '%s: holds no key, and the only secrets are the generated ones in .env',
    async (framework) => {
      const { directory } = await make(framework)
      for (const file of await tree(directory)) {
        const text = await readFile(join(directory, file), 'utf8')
        expect(`${file}: ${/tula_(sk|pk|ak)_[a-z]+_[A-Za-z0-9_-]{8,}/.test(text)}`).toBe(
          `${file}: false`
        )
        if (file !== '.env') {
          expect(`${file}: ${/^[A-Z_]*(KEY|TOKEN|PASSWORD|SECRET)[A-Z_]*=\S+/m.test(text)}`).toBe(
            `${file}: false`
          )
        }
      }
      expect((await stat(join(directory, '.env'))).mode & 0o777).toBe(0o600)
    }
  )

  test.each<Framework>([...NATIVE])(
    '%s: .gitignore is written first and .env last, and the app’s own files are covered',
    async (framework) => {
      const { directory, files } = await make(framework)
      expect(files[0]).toBe('.gitignore')
      expect(files.at(-1)).toBe('.env')
      const ignore = await readFile(join(directory, '.gitignore'), 'utf8')
      // No leading slash: the pattern covers the app's own .env.local as well.
      expect(ignore).toContain('\n.env.*\n')
    }
  )

  test.each<Framework>([...NATIVE])(
    '%s: an existing .env is kept with --force, and a link where the app goes is refused',
    async (framework) => {
      await mkdir(join(dir, 'kept'))
      await writeFile(join(dir, 'kept', '.env'), 'TULA_MASTER_KEY=mine\n')
      const kept = await make(framework, 'kept', { force: true })
      expect(kept.keptEnv).toBe(true)
      expect(await readFile(join(dir, 'kept', '.env'), 'utf8')).toBe('TULA_MASTER_KEY=mine\n')

      const elsewhere = join(dir, 'elsewhere')
      await mkdir(elsewhere)
      await mkdir(join(dir, 'linked'))
      const appDirectory = (
        { expo: 'app', swiftui: 'ios', compose: 'android' } as Record<string, string>
      )[framework] as string
      await symlink(elsewhere, join(dir, 'linked', appDirectory))
      await expect(make(framework, 'linked', { force: true })).rejects.toThrow(ScaffoldError)
      expect(await readdir(elsewhere)).toEqual([])
      expect(await readdir(join(dir, 'linked'))).toEqual([appDirectory])
    }
  )
})

describe('--tula-repo', () => {
  test.each<Framework>(['swiftui', 'compose'])(
    '%s without it is refused, with why, and nothing is written',
    async (framework) => {
      const refused = scaffold({ cwd: dir, name: 'shop', framework })
      await expect(refused).rejects.toThrow(ScaffoldError)
      await expect(refused).rejects.toThrow(/--tula-repo <directory>.*not published/)
      expect(await readdir(dir)).toEqual([])
    }
  )

  test.each<Framework>(['react-vite', 'nextjs', 'expo'])(
    '%s with it is refused: it would be ignored',
    async (framework) => {
      await expect(scaffold({ cwd: dir, name: 'shop', framework, tulaRepo: repo })).rejects.toThrow(
        /--tula-repo is for swiftui and compose/
      )
      expect(await readdir(dir)).toEqual([])
    }
  )

  test('a directory that is not a checkout, or does not exist, is refused before anything is written', async () => {
    await mkdir(join(dir, 'empty'))
    for (const tulaRepo of ['empty', 'missing']) {
      for (const framework of ['swiftui', 'compose'] as const) {
        await expect(scaffold({ cwd: dir, name: 'shop', framework, tulaRepo })).rejects.toThrow(
          /does not lead to a checkout of the Tula repository/
        )
      }
    }
    expect(await readdir(dir)).toEqual(['empty'])
  })

  test('a checkout of one SDK only is enough for that SDK, and not for the other', async () => {
    await mkdir(join(dir, 'half/native/swift'), { recursive: true })
    await writeFile(join(dir, 'half/native/swift/Package.swift'), '')
    const made = await scaffold({ cwd: dir, name: 'shop', framework: 'swiftui', tulaRepo: 'half' })
    const project = await readFile(
      join(made.directory, 'ios/TulaExample.xcodeproj/project.pbxproj'),
      'utf8'
    )
    expect(project).toContain('relativePath = "../../half/native/swift";')
    await expect(
      scaffold({ cwd: dir, name: 'other', framework: 'compose', tulaRepo: 'half' })
    ).rejects.toThrow(/there is no native\/android\/settings\.gradle\.kts there/)
  })

  test.each([
    ['a quote', 'che"ckout'],
    ['a dollar sign', 'che$ckout'],
    ['an asterisk', 'che*ckout'],
    ['a letter outside ASCII', 'chéckout'],
  ])(
    'a path with %s cannot be written into a project file as it is, and is refused',
    async (_what, name) => {
      await mkdir(join(dir, name, 'native/swift'), { recursive: true })
      await mkdir(join(dir, name, 'native/android'), { recursive: true })
      await writeFile(join(dir, name, 'native/swift/Package.swift'), '')
      await writeFile(join(dir, name, 'native/android/settings.gradle.kts'), '')
      for (const framework of ['swiftui', 'compose'] as const) {
        await expect(
          scaffold({ cwd: dir, name: 'shop', framework, tulaRepo: name })
        ).rejects.toThrow(/has a character that cannot be written/)
      }
      expect(await readdir(dir)).toEqual([name])
    }
  )

  // The Compose project's start command and its README print the path in a shell line,
  // unquoted, and nobody built a project whose checkout sits under a name with a space.
  test('a checkout in a directory with a space is refused, the value not repeated, and nothing is written', async () => {
    await mkdir(join(dir, 'my checkout/native/swift'), { recursive: true })
    await mkdir(join(dir, 'my checkout/native/android'), { recursive: true })
    await writeFile(join(dir, 'my checkout/native/swift/Package.swift'), '')
    await writeFile(join(dir, 'my checkout/native/android/settings.gradle.kts'), '')
    for (const framework of ['swiftui', 'compose'] as const) {
      const refused = scaffold({ cwd: dir, name: 'shop', framework, tulaRepo: 'my checkout' })
      await expect(refused).rejects.toThrow(ScaffoldError)
      await expect(refused).rejects.toThrow(/has a character that cannot be written/)
      const message = await refused.then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : '')
      )
      expect(message).not.toContain('my checkout')
      expect(message).not.toContain('spaces')
    }
    expect(await readdir(dir)).toEqual(['my checkout'])
  })

  test('a space above the project is no part of the path, which climbs with `..`', async () => {
    const cwd = join(dir, 'my work')
    await mkdir(cwd)
    await mkdir(join(dir, 'checkout/native/swift'), { recursive: true })
    await writeFile(join(dir, 'checkout/native/swift/Package.swift'), '')
    const { directory } = await scaffold({
      cwd,
      name: 'shop',
      framework: 'swiftui',
      tulaRepo: '../checkout',
    })
    expect(
      await readFile(join(directory, 'ios/TulaExample.xcodeproj/project.pbxproj'), 'utf8')
    ).toContain('relativePath = "../../../checkout/native/swift";')
  })
})

describe('create-tula (the command), for a native app', () => {
  async function run(args: string[]) {
    let stdout = ''
    let stderr = ''
    const code = await main(args, {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      cwd: dir,
      isTTY: false,
    })
    return { code, stdout, stderr }
  }

  test('expo: says how the app is started, and names no web address', async () => {
    const result = await run(['shop', '--framework', 'expo'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Created shop (expo)')
    expect(result.stdout).toContain('bunx tula dev')
    expect(result.stdout).toContain('cd app && bun install')
    expect(result.stdout).not.toContain('bun run dev')
    expect(result.stdout).not.toContain('null')
    expect(result.stdout).toContain('an Apple, Google or Tailscale account of your own')
  })

  test('swiftui and compose take --tula-repo, and say so when it is missing', async () => {
    const missing = await run(['shop', '--framework', 'swiftui'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('--tula-repo <directory>')
    expect(await readdir(dir)).toEqual([])
    const swift = await run(['ios-app', '--framework', 'swiftui', '--tula-repo', repo])
    expect(swift.code).toBe(0)
    expect(swift.stdout).toContain('open ios/TulaExample.xcodeproj')
    const compose = await run(['android-app', '--framework=compose', `--tula-repo=${repo}`])
    expect(compose.code).toBe(0)
    expect(compose.stdout).toContain('gradlew -p android :app:installDebug')
  })

  test('--help names the five frameworks and what --tula-repo is for', async () => {
    const help = await run(['--help'])
    for (const framework of FRAMEWORKS) {
      expect(help.stdout).toContain(framework)
    }
    expect(help.stdout).toContain('--tula-repo <dir>')
    expect(help.stdout).toContain('not published')
  })
})
