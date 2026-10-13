import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A pinned version nothing updates freezes today's vulnerabilities in place. Every build
// manifest the repository tracks is therefore watched by an entry of `.github/dependabot.yml`,
// or is on the short list below with the reason it is not. The Gradle build of the Kotlin
// client arrived without an entry (TULA-38): this is the test that would have said so.

const root = join(import.meta.dir, '..', '..')

type Update = { 'package-ecosystem': string; directory?: string; directories?: string[] }
const { updates } = Bun.YAML.parse(
  readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8')
) as { updates: Update[] }

/** Every file git tracks, from the repository's root. */
function trackedFiles(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, timeout: 30_000 })
  if (listed.exitCode !== 0) {
    throw new Error('git ls-files failed')
  }
  return listed.stdout.toString().split('\0').filter(Boolean)
}

/** The Dependabot ecosystem that updates a file, or `null` for a file that is no manifest. */
function ecosystemOf(file: string): string | null {
  const name = file.split('/').pop() ?? ''
  if (/^Dockerfile(\..+)?$/.test(name)) {
    return 'docker'
  }
  if (/^(docker-)?compose(\..+)?\.ya?ml$/.test(name)) {
    return 'docker-compose'
  }
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) {
    return 'github-actions'
  }
  if (/\.gradle(\.kts)?$/.test(name) || name === 'libs.versions.toml') {
    return 'gradle'
  }
  if (name === 'gradle-wrapper.properties') {
    return 'gradle'
  }
  if (name === 'Package.swift') {
    return 'swift'
  }
  return null
}

/** The directory a manifest is watched from: where its build's root is. */
function watchedFrom(ecosystem: string, file: string): string {
  if (ecosystem === 'github-actions') {
    return '/'
  }
  const directory = `/${file.split('/').slice(0, -1).join('/')}`
  return directory === '/' ? '/' : directory
}

/** Whether an entry of the ecosystem covers the directory, itself or from above. */
function covered(ecosystem: string, directory: string): boolean {
  return updates
    .filter((entry) => entry['package-ecosystem'] === ecosystem)
    .flatMap((entry) => [entry.directory, ...(entry.directories ?? [])])
    .filter((entry): entry is string => typeof entry === 'string')
    .some((entry) => {
      // Gradle is watched from the build's root, which holds its modules and its catalog.
      const above = ecosystem === 'gradle' && directory.startsWith(`${entry}/`)
      return entry === directory || above
    })
}

/** A manifest that pins nothing an update could move, with what makes that true. */
function pinsNothing(ecosystem: string, file: string): boolean {
  const text = readFileSync(join(root, file), 'utf8')
  if (ecosystem === 'docker-compose') {
    // An overlay whose only image is the one this repository builds (the worker check's
    // receiver runs in the API's image): there is no version of somebody else's in it.
    const images = text.match(/^\s*image:.*$/gm) ?? []
    return images.every((line) => /image:\s*\$\{API_IMAGE:-tula-api:local\}\s*$/.test(line))
  }
  if (ecosystem === 'swift') {
    // The Swift package has no third-party dependency (ADR 0051). The day it names one, it
    // needs an entry.
    return !/\.package\s*\(/.test(text)
  }
  return false
}

test('every build manifest the repository tracks is watched by Dependabot', () => {
  const unwatched = trackedFiles()
    .map((file) => ({ file, ecosystem: ecosystemOf(file) }))
    .filter((found): found is { file: string; ecosystem: string } => found.ecosystem !== null)
    .filter(({ file, ecosystem }) => !pinsNothing(ecosystem, file))
    .filter(({ file, ecosystem }) => !covered(ecosystem, watchedFrom(ecosystem, file)))
    .map(({ file, ecosystem }) => `${ecosystem}: ${file}`)
  expect(unwatched).toEqual([])
})

test('the Gradle build of the Kotlin client is watched from its root, like the other entries', () => {
  const gradle = updates.filter((entry) => entry['package-ecosystem'] === 'gradle')
  expect(gradle).toHaveLength(1)
  expect(gradle[0]).toMatchObject({
    directory: '/native/android',
    'target-branch': 'develop',
    schedule: { interval: 'weekly' },
    'commit-message': { prefix: 'build' },
  })
})

test('the scan knows a manifest when it sees one', () => {
  expect(ecosystemOf('native/android/gradle/libs.versions.toml')).toBe('gradle')
  expect(ecosystemOf('native/android/tula-auth/build.gradle.kts')).toBe('gradle')
  expect(ecosystemOf('apps/api/Dockerfile')).toBe('docker')
  expect(ecosystemOf('packages/create-tula/templates/base/compose.yaml')).toBe('docker-compose')
  expect(ecosystemOf('.github/workflows/ci.yml')).toBe('github-actions')
  expect(ecosystemOf('native/swift/Package.swift')).toBe('swift')
  expect(ecosystemOf('packages/core/package.json')).toBeNull()
})
