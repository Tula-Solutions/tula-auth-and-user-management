import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { UNRELEASED_TULA_PACKAGES } from '../../packages/create-tula/src/scaffold'
import { VENDORED } from '../../packages/expo-screens/scripts/vendor'
import { UNRELEASED_TULA_PACKAGES as MCP_UNRELEASED } from '../../packages/mcp/src/unreleased'
import {
  HELD_PACKAGES,
  leakedPackedFiles,
  type Manifest,
  missingPackedFiles,
  PUBLISHABLE_PACKAGES,
  privateStateProblems,
  publishManifest,
  RELEASED_PACKAGES,
  REQUIRED_PACKED_FILES,
  releaseState,
  stagedManifestProblems,
  unreleasedRuntimeDependencies,
} from '../../scripts/publish-manifest'

const root = join(import.meta.dir, '..', '..')

const read = (path: string) => Bun.file(join(root, path)).text()
const manifest = async (dir: string) =>
  (await Bun.file(join(root, dir, 'package.json')).json()) as Manifest

// Every workspace package (the root's `workspaces`: a directory with a package.json) and
// the root itself.
const workspaceDirs = [
  '.',
  ...['apps', 'packages', 'examples']
    .filter((group) => existsSync(join(root, group)))
    .flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(group, entry.name))
        .filter((dir) => existsSync(join(root, dir, 'package.json')))
    ),
]

// `actions/upload-artifact` skips hidden files and directories unless told otherwise, so an
// upload from a dot directory (`.release`) finds nothing. The release workflow runs only on
// `main`, where no pull request exercises it: this is the check that runs before a merge.
describe('artifact uploads', () => {
  const workflows = readdirSync(join(root, '.github', 'workflows')).filter((name) =>
    /\.ya?ml$/.test(name)
  )

  // The upload steps of a workflow, without their comment lines.
  const uploadSteps = (workflow: string) =>
    workflow
      .split(/\n\s*- /)
      .filter((step) => step.includes('uses: actions/upload-artifact'))
      .map((step) =>
        step
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
      )

  // A path segment that starts with a dot, with or without anything after it. `./x` and
  // `../x` are not hidden.
  const namesHiddenPath = (step: string) => /(?:^|[\s/'"!])\.[\w-]/m.test(step)

  test.each([
    ['path: .release/*.tgz', true],
    ['path: .release', true],
    ['path: build/.cache/out', true],
    ['path: "!.cache/x"', true],
    ['path: |\n  dist\n  .release/', true],
    ['path: ./dist/*.tgz', false],
    ['path: ../dist', false],
    ['path: e2e/playwright-report', false],
  ])('%j names a hidden path: %p', (step, hidden) => {
    expect(namesHiddenPath(step)).toBe(hidden)
  })

  test.each(workflows)(
    '%s uploads from a dot directory only with hidden files included',
    async (name) => {
      const workflow = await read(join('.github', 'workflows', name))
      for (const step of uploadSteps(workflow)) {
        if (namesHiddenPath(step)) {
          expect(step).toContain('include-hidden-files: true')
        }
      }
    }
  )

  test('the release workflow keeps its tarballs', async () => {
    const [upload, ...others] = uploadSteps(await read('.github/workflows/release.yml'))
    // Exactly one step is found: a re-indented workflow must not make this check empty.
    expect(others).toEqual([])
    expect(upload).toContain('path: .release/*.tgz')
    expect(upload).toContain('include-hidden-files: true')
  })
})

// Nine packages are released to npm and two are held back (docs/releasing.md). These tests
// are the tripwire around that: what may be published, by whom, with which credential and
// from what. Changing any of it means changing a test here on purpose, in the same change.
describe('only the released packages can be published', () => {
  const REPOSITORY = 'git+https://github.com/Tula-Solutions/tula-auth-and-user-management.git'

  test('nine are released and the two Expo packages are held back', () => {
    expect([...HELD_PACKAGES]).toEqual(['packages/expo', 'packages/expo-screens'])
    expect([...RELEASED_PACKAGES]).toEqual([
      'packages/contract',
      'packages/core',
      'packages/react',
      'packages/nextjs',
      'packages/admin',
      'packages/config',
      'packages/mcp',
      'packages/cli',
      'packages/create-tula',
    ])
    // One list is derived from the other two: a package is released or held, never both.
    expect([...RELEASED_PACKAGES, ...HELD_PACKAGES].sort()).toEqual(
      [...PUBLISHABLE_PACKAGES].sort()
    )
    expect(workspaceDirs).toEqual(expect.arrayContaining([...PUBLISHABLE_PACKAGES]))
  })

  // `"private": true` is what makes npm itself refuse a package. Only a released package is
  // without it: a held-back one, the API, the database package, an example and the root
  // all keep it.
  test.each(workspaceDirs)('%s is private unless it is released', async (dir) => {
    expect({ dir, private: (await manifest(dir)).private === true }).toEqual({
      dir,
      private: releaseState(dir) !== 'released',
    })
  })

  test.each([...HELD_PACKAGES])(
    '%s is held back: private, and never in the release',
    async (dir) => {
      expect((await manifest(dir)).private).toBe(true)
      expect(releaseState(dir)).toBe('held')
      expect(RELEASED_PACKAGES as readonly string[]).not.toContain(dir)
    }
  )

  test('privateStateProblems names a held or private package that lost the field, and a released one that has it', () => {
    const entry = (dir: string, isPrivate: boolean) => ({
      dir,
      manifest: { name: dir, version: '1.0.0', ...(isPrivate ? { private: true } : {}) },
    })
    const sound = [
      ...RELEASED_PACKAGES.map((dir) => entry(dir, false)),
      ...HELD_PACKAGES.map((dir) => entry(dir, true)),
      entry('apps/api', true),
      entry('.', true),
    ]
    expect(privateStateProblems(sound)).toEqual([])
    const broken = (dir: string) =>
      privateStateProblems(sound.map((item) => (item.dir === dir ? entry(dir, false) : item)))
    expect(broken('packages/expo')).toEqual([
      'packages/expo (packages/expo) is held back and is not "private": true',
    ])
    expect(broken('apps/api')).toEqual([
      'apps/api (apps/api) is not a released package and is not "private": true',
    ])
    expect(broken('.')).toHaveLength(1)
    expect(
      privateStateProblems(
        sound.map((item) => (item.dir === 'packages/core' ? entry(item.dir, true) : item))
      )
    ).toEqual([
      'packages/core (packages/core) is in RELEASED_PACKAGES and is "private": true: npm would refuse it',
    ])
    expect(privateStateProblems(sound.filter((item) => item.dir !== 'packages/cli'))).toEqual([
      'packages/cli is in RELEASED_PACKAGES and has no package.json',
    ])
  })

  // What a stranger sees on npm, and what provenance is checked against: the attestation
  // names the repository a package was built from, and npm compares it with this field.
  test.each([...RELEASED_PACKAGES])(
    '%s says where it comes from and is Apache-2.0',
    async (dir) => {
      const pkg = await manifest(dir)
      expect(pkg.repository).toEqual({ type: 'git', url: REPOSITORY, directory: dir })
      expect(pkg.homepage).toBe(
        `https://github.com/Tula-Solutions/tula-auth-and-user-management/tree/main/${dir}#readme`
      )
      expect(pkg.bugs).toEqual({
        url: 'https://github.com/Tula-Solutions/tula-auth-and-user-management/issues',
      })
      expect(pkg.license).toBe('Apache-2.0')
      expect(String(pkg.description).length).toBeGreaterThan(40)
      expect(pkg.keywords).toEqual(expect.arrayContaining(['tula', 'authentication']))
      const readme = await read(join(dir, 'README.md'))
      // A stranger arriving from npm: how to install it, and how settled it is.
      expect(readme).toMatch(/\b(bun add|bun create|bunx)\b/)
      // An early release: the README says that what it exposes may still change.
      expect(readme).toMatch(/\b0\.x\b/)
      expect(readme).not.toMatch(/dist-tag|`alpha`/)
      expect(readme).not.toMatch(/not published yet|nothing is published/i)
    }
  )

  // A released package that needs a held-back or private one at run time cannot be
  // installed. `devDependencies` are dropped from the published manifest and do not count.
  test('no released package depends at run time on a package that is not released', async () => {
    const all = await Promise.all(
      workspaceDirs.map(async (dir) => ({ dir, pkg: await manifest(dir) }))
    )
    const names = new Set(all.map(({ pkg }) => pkg.name))
    const released = new Set(
      all.filter(({ dir }) => releaseState(dir) === 'released').map(({ pkg }) => pkg.name)
    )
    expect(released.size).toBe(9)
    for (const { dir, pkg } of all) {
      if (releaseState(dir) === 'released') {
        expect({ dir, needs: unreleasedRuntimeDependencies(pkg, released, names) }).toEqual({
          dir,
          needs: [],
        })
      }
    }
    const core: Manifest = { name: '@tula-tech/core', version: '1.0.0' }
    expect(
      unreleasedRuntimeDependencies(
        {
          ...core,
          dependencies: { '@tula-tech/expo': 'workspace:*', '@tula-tech/contract': 'workspace:*' },
          // Named by a version, not by `workspace:`: still a package that is not on npm.
          peerDependencies: { '@tula-tech/expo-screens': '^0.1.0', react: '^19.0.0' },
          optionalDependencies: { '@tula-tech/api': 'workspace:*' },
          devDependencies: { '@tula-tech/db': 'workspace:*' },
        },
        released,
        names
      )
    ).toEqual([
      '@tula-tech/expo (dependencies)',
      '@tula-tech/expo-screens (peerDependencies)',
      '@tula-tech/api (optionalDependencies)',
    ])
    // The script stops for one, before anything is built.
    const script = await read('scripts/packages.ts')
    expect(script).toContain('unreleasedRuntimeDependencies(manifest, released, names)')
    expect(script).toContain('is released and depends at run time on what is not')
  })

  // `create-tula` cannot import the repository's list (it has no dependency at run time),
  // so it keeps the names itself and this holds the two equal: releasing an Expo package
  // without telling the scaffolder, or the reverse, fails here.
  test('create-tula refuses a template that needs exactly the held-back packages', async () => {
    const held = await Promise.all(HELD_PACKAGES.map(async (dir) => (await manifest(dir)).name))
    expect([...UNRELEASED_TULA_PACKAGES]).toEqual(held)
  })

  // The MCP server's scaffold tools are the other way a project is told what to install, and
  // `@tula-tech/mcp` is published too: it keeps the names itself, held equal here.
  test('the MCP scaffold tools refuse a framework that needs exactly the held-back packages', async () => {
    const held = await Promise.all(HELD_PACKAGES.map(async (dir) => (await manifest(dir)).name))
    expect([...MCP_UNRELEASED]).toEqual(held)
    const tools = await read('packages/mcp/src/tools.ts')
    expect(tools).toContain("import { UNRELEASED_TULA_PACKAGES } from './unreleased'")
    expect(tools).toMatch(/throw new ToolError\(\s*'scaffold\.not_released',/)
  })

  const active = (workflow: string) =>
    // Comments explain what is absent; only the lines that do something are checked.
    workflow
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')

  /** A job of the release workflow, from its key to the next job's. */
  const job = (workflow: string, name: string) => {
    const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
    const start = jobs.indexOf(`\n  ${name}:\n`)
    expect(start).toBeGreaterThan(-1)
    const rest = jobs.slice(start + 1)
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
    return next === -1 ? rest : rest.slice(0, next + 1)
  }

  test('the release workflow holds no long-lived token and names no publish command of its own', async () => {
    const workflow = active(await read('.github/workflows/release.yml'))
    for (const forbidden of [
      // No secret at all: trusted publishing needs none, and a token could publish anything.
      /secrets\./,
      /NPM_TOKEN/i,
      /NODE_AUTH_TOKEN/,
      /_authToken/,
      /\.npmrc/,
      /registry-url/,
      // The script is the only thing that uploads: no second path around its refusals.
      /\bnpm publish\b/,
      /\bbun publish\b/,
      /changeset publish/,
      /pull_request_target|workflow_dispatch|workflow_run/,
    ]) {
      expect(workflow).not.toMatch(forbidden)
    }
    expect(workflow).toContain('on:\n  push:\n    branches: [main]\n')
    // The workflow as a whole can only read; one job is given one more permission below.
    expect(workflow).toContain('\npermissions:\n  contents: read\n')
    expect(workflow.match(/:\s*write\b/g)).toEqual([': write'])
    expect(workflow.match(/id-token: write/g)).toHaveLength(1)
  })

  test('the dry run always runs and cannot upload; the upload is one job, off until a variable is set', async () => {
    const workflow = active(await read('.github/workflows/release.yml'))
    expect([...workflow.matchAll(/\n {2}([a-z][\w-]*):\n {4}name:/g)].map((m) => m[1])).toEqual([
      'dry-run',
      'publish',
    ])
    const dryRun = job(workflow, 'dry-run')
    expect(dryRun).not.toMatch(/\n {4}if:/)
    expect(dryRun).toContain('run: bun run release:dry-run')
    expect(dryRun).toContain('run: bun run packages:states')
    expect(dryRun).not.toMatch(/id-token|permissions:|release:publish|--publish/)

    const publish = job(workflow, 'publish')
    // Merging to `main` publishes nothing by itself: a person sets the variable.
    expect(publish).toContain("\n    if: vars.NPM_PUBLISH == 'true'\n")
    // The OIDC identity npm trusts names this environment, and GitHub lets only `main`
    // deploy to it (no reviewer approves a run). Without it the identity is the workflow FILE's, on any ref:
    // a branch with its own copy of release.yml could publish.
    expect(publish).toContain('\n    environment: npm-publish\n')
    expect(dryRun).not.toMatch(/\n {4}environment:/)
    expect(workflow.match(/environment:/g)).toHaveLength(1)
    expect(publish).toContain('\n    needs: dry-run\n')
    expect(publish).toContain('\n    permissions:\n      contents: read\n      id-token: write\n')
    expect(
      publish
        .match(/\n {6}- (?:name: [^\n]*\n {8})?run: [^\n]*/g)
        ?.map((step) => step.trim().split('run: ')[1])
    ).toEqual(['bun install --frozen-lockfile', 'bun run release:publish'])
    expect(publish).not.toMatch(/continue-on-error|\benv:/)
  })

  test('the runbook hands over to an environment that only main can deploy to', async () => {
    const doc = await read('docs/releasing.md')
    const handOver = doc
      .slice(doc.indexOf('**Hand over to the workflow.**'))
      .replace(/[ \t]*\n[ \t]*(?!\d+\. )/g, ' ')
    expect(handOver.length).toBeGreaterThan(200)
    const step = handOver.slice(0, handOver.search(/\n\d+\. \*\*Merge/))
    // The environment exists, is restricted to main, and npm is given its name.
    expect(step).toContain('environment named `npm-publish`')
    expect(step).toMatch(/deployment branches[^.]*`main` only/)
    // No required reviewer: a merge to `main` publishes (the owner's decision, TULA-108).
    expect(step).not.toContain('required reviewers')
    expect(step).toMatch(/Trusted Publisher[\s\S]*the environment `npm-publish`/)
    expect(step).not.toMatch(/\(no environment\)|no environment\b/)
    expect(doc.replace(/\s+/g, ' ')).toContain(
      'the branch restriction of the `npm-publish` environment'
    )
  })

  // Bun appends what follows a script's name, so `bun run release:dry-run --publish` would
  // be `release --publish` if the script carried no flag. With `--dry-run` written into it
  // that command is `release --dry-run --publish`, which the parser refuses ("choose one").
  test('the root scripts: the dry run says so itself, and uploading is a script of its own', async () => {
    const scripts = (await manifest('.')).scripts as Record<string, string>
    expect(scripts['release:dry-run']).toBe('bun run scripts/packages.ts release --dry-run')
    expect(scripts['release:dry-run']?.endsWith(' --dry-run')).toBe(true)
    expect(scripts['release:publish']).toBe('bun run scripts/packages.ts release --publish')
    expect(scripts['packages:states']).toBe('bun run scripts/packages.ts states')
    // Nothing else may carry the flag: not verify, not a lifecycle script.
    const carrying = Object.entries(scripts)
      .filter(([, command]) => /--publish|release:publish|\b(npm|bun) publish\b/.test(command))
      .map(([name]) => name)
    expect(carrying).toEqual(['release:publish'])
    expect(
      Object.keys(scripts).filter((name) => /^(pre|post)?publish|^prepack|^postpack/.test(name))
    ).toEqual([])
  })

  test('the script uploads in one place, through the gate, and names no publish command itself', async () => {
    const script = await read('scripts/packages.ts')
    // Every spawn: the captured ones (`run([...])`) and the direct ones.
    const captured = [...script.matchAll(/run\(\[([^\]]*)\]/g)].map((match) => match[1] ?? '')
    expect(captured.length).toBeGreaterThan(5)
    for (const command of captured) {
      expect(command).not.toMatch(/publish/)
    }
    const spawns = [...script.matchAll(/Bun\.spawn\((.+?), \{/g)].map((match) => match[1])
    // `command`: the captured runner's and the upload loop's. Nothing else is spawned from
    // a variable, and the literal one is `npm --version`.
    expect(spawns).toEqual(['command', "['npm', '--version']", 'command'])
    expect(script).not.toMatch(/['"`]publish['"`]/)
    expect(script.match(/uploadCommands\(/g)).toHaveLength(1)
    expect(script).toContain('for (const { pkg, command } of uploadCommands(args, plan, outDir)) {')
    // The flag is read by the parser and nowhere else, and never from the environment.
    expect(script).toContain(
      "const args = mode === 'release' ? parseReleaseArgs(rest) : { publish: false, otp: null }"
    )
    expect(script).not.toMatch(/publish:\s*true/)
    expect(script).not.toMatch(/process\.env\.(?!GITHUB_ACTIONS\b)/)
    // No credential is read: no npm configuration, no token. A one-time password is the
    // one thing a person may hand over, as an argument: the flag is spelled in the parser
    // and the command builder (scripts/release.ts) and nowhere in this script.
    // Judged on the lines that do something: the comments say what is absent.
    for (const [file, forbidden] of [
      // The flag as an argument of its own would be a second place that builds the command;
      // the usage line and the sentence about running again may name it.
      [
        'scripts/packages.ts',
        /readFile|npmrc|['"`]--otp['"`]|_authToken|\bauthorization\b|\bcookie\b/i,
      ],
      [
        'scripts/release.ts',
        /readFile|npmrc|_authToken|\bauthorization\b|\bcookie\b|process\.env/i,
      ],
    ] as const) {
      const code = active(
        await read(file).then((text) => text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''))
      )
      expect({ file, reads: forbidden.exec(code)?.[0] }).toEqual({ file, reads: undefined })
    }
    // The upload loop: the command is printed struck out, never joined as it is, the code is
    // not written anywhere, and with a code the child cannot stop to ask for another.
    const loop = script.slice(script.indexOf('// THE ONLY UPLOAD.'))
    expect(loop.length).toBeGreaterThan(500)
    expect(loop).toContain('printableCommand(command)')
    expect(loop).not.toMatch(/command\.join|command\.slice|\$\{args\.otp|write\([^)]*args\.otp/)
    expect(loop).toContain("stdin: args.otp === null ? 'inherit' : 'ignore',")
    // The order is the pure function's, and the code's refusal in CI reaches the plan.
    expect(script).toContain('uploadOrder(')
    expect(script).toContain('problems: otpProblems(args, process.env)')
  })

  test('changesets publish with public access, from main, and never tag a private package', async () => {
    const config = JSON.parse(await read('.changeset/config.json'))
    expect(config).toMatchObject({
      access: 'public',
      baseBranch: 'main',
      // The held-back packages are private and in the fixed group: their version moves
      // with the others' (`version`) and they are never tagged or published (`tag`).
      privatePackages: { version: true, tag: false },
    })
    const names = await Promise.all(
      PUBLISHABLE_PACKAGES.map(async (dir) => (await manifest(dir)).name)
    )
    expect(config.fixed).toEqual([names])
    // Not in prerelease mode: `changeset version` gives plain versions (1.2.3), which is the
    // only kind the release script uploads. `pre.json` exists only while the mode is on.
    expect(existsSync(join(root, '.changeset/pre.json'))).toBe(false)
  })
})

describe('publishable packages', () => {
  // Entry points published as CommonJS beside the module, each for a reason: an Expo config
  // plugin is loaded with `require`, in Node, while an app's configuration is read (ADR 0052).
  const COMMONJS_ENTRIES: Record<string, string[]> = {
    'packages/expo': ['./plugin'],
    'packages/expo-screens': ['./plugin'],
  }

  test('are the contract, the SDKs, the admin client, the config package, the MCP server, the CLI and create-tula, dependencies first', () => {
    expect([...PUBLISHABLE_PACKAGES]).toEqual([
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
    ])
  })

  test.each([...PUBLISHABLE_PACKAGES])(
    '%s resolves from source in the repository and from dist when published',
    async (dir) => {
      const pkg = await manifest(dir)
      // Nothing but a stylesheet may have side effects: a bundler must keep
      // `import '@tula-tech/react/styles.css'` and may drop any script that is not used.
      expect([false, ['**/*.css']] as unknown[]).toContainEqual(pkg.sideEffects)
      expect(pkg.type).toBe('module')
      expect(pkg.files).toContain('dist')
      const source = pkg.exports as Record<string, string>
      const published = pkg.publishConfig?.exports as Record<string, unknown>
      expect(source['.']).toBe('./src/index.ts')
      for (const [subpath, target] of Object.entries(source)) {
        // Every entry point the repository uses is also published.
        expect(published).toHaveProperty([subpath])
        if (COMMONJS_ENTRIES[dir]?.includes(subpath)) {
          const name = target.slice('./src/'.length, -'.ts'.length)
          expect(published[subpath]).toEqual({
            import: { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` },
            require: { types: `./dist/${name}.d.cts`, default: `./dist/${name}.cjs` },
          })
          expect(existsSync(join(root, dir, target))).toBe(true)
        } else if (target.endsWith('.ts')) {
          const name = target.slice('./src/'.length, -'.ts'.length)
          // The entry itself, and nothing else unless the package adds conditions of its own
          // (`@tula-tech/admin` sends a `browser` bundle to a module that refuses to load): each
          // of those is an entry of the same shape, with the same types, inside dist.
          const {
            types,
            default: main,
            ...conditions
          } = published[subpath] as Record<string, unknown>
          expect({ types, default: main }).toEqual({
            types: `./dist/${name}.d.ts`,
            default: `./dist/${name}.js`,
          })
          for (const condition of Object.values(conditions)) {
            expect(condition).toEqual({
              types: `./dist/${name}.d.ts`,
              default: expect.stringMatching(/^\.\/dist\/[a-z-]+\.js$/),
            })
          }
          expect(existsSync(join(root, dir, target))).toBe(true)
        } else if (target.startsWith('./src/')) {
          // A file shipped as it is (a stylesheet): the build copies it into dist.
          expect(published[subpath]).toBe(`./dist/${target.slice('./src/'.length)}`)
          expect(existsSync(join(root, dir, target))).toBe(true)
        }
      }
      expect(published['./package.json']).toBe('./package.json')
      expect((pkg.scripts as Record<string, string>).build).toBe('bunup')
    }
  )

  // The repository installs neither React Native nor Expo (about 500 packages for two
  // imports; ADR 0046), which it gets by marking those two peers optional. An application
  // must be told to have them: the published manifest drops the marking.
  //
  // Five peers stay optional when published, and only those: each is imported by an entry
  // point of its own (`@tula-tech/expo/passkeys`, `/browser`, `/apple`, `/google`,
  // `/device-key`), which an app that does not offer what it is for never imports (ADR
  // 0048, ADR 0052). The secure store and React Native are needed by every app.
  test('@tula-tech/expo: the native peers are optional here; published, only those an app may leave out are', async () => {
    const pkg = await manifest('packages/expo')
    expect(pkg.peerDependenciesMeta).toEqual({
      '@pagopa/io-react-native-crypto': { optional: true },
      'expo-apple-authentication': { optional: true },
      'expo-secure-store': { optional: true },
      'expo-web-browser': { optional: true },
      'react-native': { optional: true },
      'react-native-nitro-google-signin': { optional: true },
      'react-native-passkey': { optional: true },
    })
    const installed = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
    }
    expect(
      Object.keys(installed).filter((name) => /^(expo|react-native|@pagopa\/)/.test(name))
    ).toEqual([])

    const published = publishManifest(pkg, new Map([['@tula-tech/core', '1.2.3']]))
    expect(published.peerDependenciesMeta).toEqual({
      '@pagopa/io-react-native-crypto': { optional: true },
      'expo-apple-authentication': { optional: true },
      'expo-web-browser': { optional: true },
      'react-native-nitro-google-signin': { optional: true },
      'react-native-passkey': { optional: true },
    })
    expect(Object.keys(published.peerDependencies as object).sort()).toEqual([
      '@pagopa/io-react-native-crypto',
      'expo-apple-authentication',
      'expo-secure-store',
      'expo-web-browser',
      'react',
      'react-native',
      'react-native-nitro-google-signin',
      'react-native-passkey',
    ])
    expect(published.dependencies).toEqual({ '@tula-tech/core': '1.2.3' })
  })

  // The native screens are a package of their own (ADR 0063): Expo links a package's native
  // module into every app that installs it, so the module is where only an app that asked
  // for the screens installs it. It is not built on the headless SDK, and published every
  // peer is required: the package is nothing without Expo.
  test('@tula-tech/expo-screens: Expo and React Native are optional peers here and required when published, and it does not depend on @tula-tech/expo', async () => {
    const pkg = await manifest('packages/expo-screens')
    expect(pkg.peerDependenciesMeta).toEqual({
      expo: { optional: true },
      'react-native': { optional: true },
    })
    const installed = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
    }
    expect(
      Object.keys(installed).filter((name) => /^(expo|react-native|@pagopa\/)/.test(name))
    ).toEqual([])
    expect(Object.keys(installed)).not.toContain('@tula-tech/expo')

    const published = publishManifest(
      pkg,
      new Map([
        ['@tula-tech/core', '1.2.3'],
        ['@tula-tech/contract', '1.2.3'],
      ])
    )
    expect(published.peerDependenciesMeta).toEqual({})
    expect(Object.keys(published.peerDependencies as object).sort()).toEqual([
      'expo',
      'react',
      'react-native',
    ])
    // The contract is a dependency for its Zod-free theme: the grammar a theme value is
    // checked with before it reaches a native screen.
    expect(published.dependencies).toEqual({
      '@tula-tech/contract': '1.2.3',
      '@tula-tech/core': '1.2.3',
    })
    // The native module travels with the package, and only with this one.
    expect(published.files).toEqual(['dist', 'android', 'ios', 'expo-module.config.json'])
    expect(existsSync(join(root, 'packages/expo-screens/expo-module.config.json'))).toBe(true)
    for (const path of ['expo-module.config.json', 'ios', 'android', 'scripts']) {
      expect({ path, exists: existsSync(join(root, 'packages/expo', path)) }).toEqual({
        path,
        exists: false,
      })
    }
    expect((await manifest('packages/expo')).files).toEqual(['dist'])
  })

  test('verify builds and checks them', async () => {
    const scripts = (await manifest('.')).scripts as Record<string, string>
    expect(scripts.verify).toContain('bun run packages:check')
    expect(scripts['packages:check']).toBe('bun run scripts/packages.ts check')
  })
})

describe('what a packed manifest and a tarball may hold', () => {
  const sound: Manifest = {
    name: '@tula-tech/cli',
    version: '0.1.0-alpha.0',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './openapi.json': './openapi.json',
      './package.json': './package.json',
    },
    bin: { tula: './dist/bin.js' },
    dependencies: { '@tula-tech/admin': '0.1.0-alpha.0', zod: '^4.6.5' },
  }

  test('a publishable manifest has no problem', () => {
    expect(stagedManifestProblems(sound)).toEqual([])
  })

  test.each<[string, Partial<Manifest>, string]>([
    ['still private', { private: true }, '@tula-tech/cli: the packed manifest has "private": true'],
    [
      'a workspace range in dependencies',
      { dependencies: { '@tula-tech/admin': 'workspace:*' } },
      '@tula-tech/cli: dependencies.@tula-tech/admin is still "workspace:*"',
    ],
    [
      'a workspace range in peerDependencies',
      { peerDependencies: { '@tula-tech/core': 'workspace:^' } },
      '@tula-tech/cli: peerDependencies.@tula-tech/core is still "workspace:^"',
    ],
    [
      'scripts left in',
      { scripts: { build: 'bunup' } },
      '@tula-tech/cli: the packed manifest still has "scripts"',
    ],
    [
      'publishConfig left in',
      { publishConfig: {} },
      '@tula-tech/cli: the packed manifest still has "publishConfig"',
    ],
    [
      'an entry point at the sources',
      { exports: { '.': './src/index.ts' } },
      '@tula-tech/cli: the entry point ./src/index.ts is not in dist/',
    ],
    [
      'a bin at the sources',
      { bin: { tula: './src/bin.ts' } },
      '@tula-tech/cli: the entry point ./src/bin.ts is not in dist/',
    ],
  ])('%s is a problem', (_what, change, problem) => {
    expect(stagedManifestProblems({ ...sound, ...change })).toContain(problem)
  })

  test('dev dependencies left in are named, and a workspace one twice over', () => {
    expect(
      stagedManifestProblems({
        ...sound,
        devDependencies: { '@tula-tech/tsconfig': 'workspace:*' },
      })
    ).toEqual([
      '@tula-tech/cli: devDependencies.@tula-tech/tsconfig is still "workspace:*"',
      '@tula-tech/cli: the packed manifest still has "devDependencies"',
    ])
  })

  test('a tarball of dist, the README, the licence and templates leaks nothing', () => {
    expect(
      leakedPackedFiles(
        [
          'package/package.json',
          'package/LICENSE',
          'package/README.md',
          'package/dist/index.js',
          'package/dist/shared/chunk-abc.js',
          // create-tula's templates are example apps: their sources and UI tests travel.
          'package/templates/react-vite/app/src/main.tsx',
          'package/templates/base/_env.example.tmpl',
          'package/templates/expo/app/app/.env.example',
          'package/templates/swiftui/app/ios/TulaExampleUITests/Support.swift',
          '',
        ].join('\n')
      )
    ).toEqual([])
  })

  test.each([
    'package/src/index.ts',
    'package/dist/session.test.js',
    'package/dist/deep/flow.spec.d.ts',
    'package/node_modules/zod/index.js',
    'package/templates/nextjs/node_modules/next/index.js',
    'package/.npmrc',
    'package/templates/base/.npmrc',
    'package/.env',
    'package/.env.local',
    'package/templates/base/.env.production',
    'elsewhere/index.js',
  ])('%s must not ship', (path) => {
    expect(leakedPackedFiles(`package/package.json\n${path}\n`)).toEqual([path])
  })

  test('the packing script refuses a leak in any package and a bad manifest in a released one', async () => {
    const script = await read('scripts/packages.ts')
    expect(script).toContain('const leaked = leakedPackedFiles(listing)')
    expect(script).toContain('the tarball holds what must not ship')
    expect(script).toContain('const problems = stagedManifestProblems(packed.packed)')
    // The manifest that is judged is read back out of the tarball, which is what is uploaded.
    expect(script).toContain("['tar', '-xzOf', tarball, 'package/package.json']")
  })
})

describe('publishManifest', () => {
  const versions = new Map([
    ['@tula-tech/contract', '0.1.0-alpha.0'],
    ['@tula-tech/core', '0.1.0-alpha.0'],
  ])
  const base: Manifest = {
    name: '@tula-tech/core',
    version: '0.1.0-alpha.0',
    private: true,
    exports: { '.': './src/index.ts' },
    publishConfig: { exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } },
    files: ['dist'],
    scripts: { build: 'bunup' },
    dependencies: { '@tula-tech/contract': 'workspace:*', zod: '^4.6.5' },
    devDependencies: { '@tula-tech/tsconfig': 'workspace:*' },
  }

  test('takes publishConfig’s fields, drops repository-only ones, and keeps `private`', () => {
    expect(publishManifest(base, versions)).toEqual({
      name: '@tula-tech/core',
      version: '0.1.0-alpha.0',
      private: true,
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files: ['dist'],
      dependencies: { '@tula-tech/contract': '0.1.0-alpha.0', zod: '^4.6.5' },
    })
  })

  test.each([
    ['workspace:*', '0.1.0-alpha.0'],
    ['workspace:^', '^0.1.0-alpha.0'],
    ['workspace:~', '~0.1.0-alpha.0'],
  ])('resolves %s to %s, in peer dependencies too', (range, expected) => {
    const published = publishManifest(
      { ...base, dependencies: undefined, peerDependencies: { '@tula-tech/contract': range } },
      versions
    )
    expect(published.peerDependencies).toEqual({ '@tula-tech/contract': expected })
    expect(published.dependencies).toBeUndefined()
  })

  test('refuses a workspace dependency that is not itself published', () => {
    expect(() =>
      publishManifest({ ...base, dependencies: { '@tula-tech/db': 'workspace:*' } }, versions)
    ).toThrow('@tula-tech/db is a workspace dependency but not a publishable package')
  })
})

// `@tula-tech/expo-screens`'s tarball holds copies of the native SDKs' sources that only its build makes
// (ADR 0063): publint and attw look at entry points and would pass a tarball without them.
describe('what a tarball must hold', () => {
  const required = REQUIRED_PACKED_FILES['@tula-tech/expo-screens'] ?? []
  const whole = required.map((path) => `package/${path}`).join('\n')

  test('a known file of every directory the Expo screens package copies is asked for, and is a source', () => {
    expect(VENDORED).toHaveLength(6)
    for (const { from, to, extension } of VENDORED) {
      const asked = required.filter((path) => path.startsWith(`${to}/`))
      expect({ to, asked: asked.length }).toEqual({ to, asked: 1 })
      const file = (asked[0] as string).slice(to.length + 1)
      expect(file.endsWith(extension)).toBe(true)
      // The file is one the copy is made from: a renamed source fails here, not at a release.
      expect({ file, exists: existsSync(join(root, from, file)) }).toEqual({ file, exists: true })
    }
    expect(required).toHaveLength(VENDORED.length)
  })

  test('a listing with all of them has nothing missing', () => {
    expect(
      missingPackedFiles('@tula-tech/expo-screens', `package/package.json\n${whole}\n`)
    ).toEqual([])
  })

  test.each(required.map((path) => [path]))('a tarball without %s is refused by name', (path) => {
    const listing = whole
      .split('\n')
      .filter((line) => line !== `package/${path}`)
      .join('\n')
    expect(missingPackedFiles('@tula-tech/expo-screens', listing)).toEqual([path])
  })

  test('a file of the same name somewhere else does not count', () => {
    const listing = required.map((path) => `package/dist/${path}`).join('\n')
    expect(missingPackedFiles('@tula-tech/expo-screens', listing)).toEqual([...required])
  })

  test('a package with no required file is asked for none, also one named like a property', () => {
    expect(missingPackedFiles('@tula-tech/core', '')).toEqual([])
    // The headless Expo SDK ships no native source: only the screens' package is asked.
    expect(missingPackedFiles('@tula-tech/expo', '')).toEqual([])
    expect(Object.keys(REQUIRED_PACKED_FILES)).toEqual(['@tula-tech/expo-screens'])
    expect(missingPackedFiles('constructor', '')).toEqual([])
  })

  test('the packing script refuses a tarball with a file missing', async () => {
    const script = await read('scripts/packages.ts')
    expect(script).toContain('const missing = missingPackedFiles(manifest.name, listing)')
    // In two pieces only so that the linter does not take it for a template literal.
    const thrown = ['throw new Error(`$', '{manifest.name}: the tarball does not hold'].join('')
    expect(script).toContain(thrown)
  })
})
