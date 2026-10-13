import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  chooseChannel,
  DIST_TAG,
  type Fetcher,
  orderProblems,
  parseReleaseArgs,
  planRelease,
  publishCommand,
  type RegistryState,
  refusals,
  registryStates,
  registryUrl,
  releaseReport,
  type StagedPackage,
  type TreeState,
  uploadCommands,
} from '../../scripts/release'

// The decisions of `bun run release:publish` (scripts/release.ts), each on its own: what it
// refuses, what it skips, which command uploads and what a person reads first. Nothing here
// builds a package or reaches a registry. That the script and the workflow are wired to
// these decisions, and to nothing else, is held by release.test.ts.

const root = '/repo'
const staging = join(root, '.release')
const VERSION = '0.1.0-alpha.0'

function staged(name: string, change: Partial<StagedPackage> = {}): StagedPackage {
  return {
    name,
    version: VERSION,
    tarball: join(staging, `${name.replace('@', '').replace('/', '-')}-${VERSION}.tgz`),
    bytes: 2048,
    files: 5,
    sha256: 'ab'.repeat(32),
    manifest: { name, version: VERSION },
    ...change,
  }
}

const contract = staged('@tula/contract')
const core = staged('@tula/core', {
  manifest: { name: '@tula/core', version: VERSION, dependencies: { '@tula/contract': VERSION } },
})
const react = staged('@tula/react', {
  manifest: {
    name: '@tula/react',
    version: VERSION,
    dependencies: { '@tula/contract': VERSION, '@tula/core': VERSION },
    peerDependencies: { react: '^19.0.0' },
  },
})
const packages = [contract, core, react]

const clean: TreeState = { head: 'a'.repeat(40), clean: true }
const local = chooseChannel({}, null)
const absent = new Map<string, RegistryState>(packages.map((pkg) => [pkg.name, 'absent']))
const sound = () =>
  planRelease(packages, absent, local, refusals({ packages, before: clean, after: clean }))

describe('the arguments of a release', () => {
  test('the dry run is the default, and an upload takes the flag spelled out', () => {
    expect(parseReleaseArgs([])).toEqual({ publish: false })
    expect(parseReleaseArgs(['--dry-run'])).toEqual({ publish: false })
    expect(parseReleaseArgs(['--publish'])).toEqual({ publish: true })
  })

  test.each([
    [['--publsh']],
    [['publish']],
    [['-p']],
    [['--publish=true']],
    [['--yes']],
    [['--publish', '--otp', '123456']],
    [['']],
  ])('%j is refused, never read as the default', (argv) => {
    expect(() => parseReleaseArgs(argv)).toThrow(/unknown argument/)
  })

  test('both flags together are refused', () => {
    expect(() => parseReleaseArgs(['--dry-run', '--publish'])).toThrow(/choose one/)
  })
})

describe('the order of a release', () => {
  test('dependencies first is sound', () => {
    expect(orderProblems(packages)).toEqual([])
  })

  test('a package before what it depends on is named, in any dependency field', () => {
    expect(orderProblems([core, contract, react])).toEqual([
      '@tula/core depends on @tula/contract, which would be published after it',
    ])
    const peer = staged('@tula/nextjs', {
      manifest: {
        name: '@tula/nextjs',
        version: VERSION,
        peerDependencies: { '@tula/react': VERSION },
      },
    })
    expect(orderProblems([contract, core, peer, react])).toEqual([
      '@tula/nextjs depends on @tula/react, which would be published after it',
    ])
  })

  test('a dependency that is not part of the release does not count', () => {
    expect(orderProblems([react])).toEqual([])
  })
})

describe('what a release refuses', () => {
  const check = (change: Partial<Parameters<typeof refusals>[0]>) =>
    refusals({ packages, before: clean, after: clean, ...change })

  test('a clean tree at one commit, one alpha version, dependencies first: nothing', () => {
    expect(check({})).toEqual([])
  })

  test('version 0.0.0', () => {
    const unversioned = packages.map((pkg) => ({
      ...pkg,
      version: '0.0.0',
      manifest: { name: pkg.name, version: '0.0.0' },
    }))
    expect(check({ packages: unversioned })).toEqual([
      'the version is 0.0.0: run `bunx changeset version` on the release branch first',
    ])
  })

  test.each(['0.1.0', '1.0.0', '0.1.0-beta.0', '0.1.0-alpha', '0.1.0-alpha.0+build', 'latest'])(
    'a version that is not an alpha prerelease: %s',
    (version) => {
      const other = [
        staged('@tula/contract', { version, manifest: { name: '@tula/contract', version } }),
      ]
      expect(check({ packages: other })).toEqual([
        `the version ${version} is not an alpha prerelease, and this script publishes under the dist-tag "alpha" only`,
      ])
    }
  )

  test('packages of the fixed group at different versions', () => {
    const ahead = staged('@tula/admin', { version: '0.1.0-alpha.1' })
    expect(check({ packages: [contract, ahead] })).toEqual([
      'the released packages are a fixed group and must share one version, not 0.1.0-alpha.0, 0.1.0-alpha.1',
    ])
  })

  test('a dirty tree, before the build or after it', () => {
    expect(check({ before: { ...clean, clean: false } })).toEqual([
      'the git tree had uncommitted changes when the build started',
    ])
    expect(check({ after: { ...clean, clean: false } })).toEqual([
      'the git tree has uncommitted changes after the build',
    ])
  })

  test('a commit that changed while the tarballs were built', () => {
    expect(check({ after: { head: 'b'.repeat(40), clean: true } })).toEqual([
      'HEAD moved during the run (aaaaaaaaaaaa → bbbbbbbbbbbb): the tarballs are not of the current commit',
    ])
  })

  test('a dependency on another version of a package of the same release', () => {
    const stale = staged('@tula/core', {
      manifest: {
        name: '@tula/core',
        version: VERSION,
        dependencies: { '@tula/contract': '0.0.9' },
      },
    })
    expect(check({ packages: [contract, stale] })).toEqual([
      '@tula/core asks for @tula/contract@0.0.9, and this release publishes 0.1.0-alpha.0',
    ])
  })

  test('nothing to release, a wrong order and problems found elsewhere are all listed', () => {
    expect(check({ packages: [] })).toEqual(['there is no package to release'])
    expect(check({ packages: [core, contract], problems: ['a tarball is wrong'] })).toEqual([
      'a tarball is wrong',
      '@tula/core depends on @tula/contract, which would be published after it',
    ])
  })
})

describe('what the registry already has', () => {
  const answering = (statuses: Record<string, number | Error>) => {
    const asked: { url: string; init: Parameters<Fetcher>[1] }[] = []
    const fetcher: Fetcher = async (url, init) => {
      asked.push({ url, init })
      const answer = statuses[url]
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error('unexpected request')
      }
      return { status: answer }
    }
    return { asked, fetcher }
  }

  test('a scoped name keeps its @ and has its slash encoded', () => {
    expect(registryUrl('@tula/core', VERSION)).toBe(
      'https://registry.npmjs.org/@tula%2Fcore/0.1.0-alpha.0'
    )
    expect(registryUrl('create-tula', VERSION)).toBe(
      'https://registry.npmjs.org/create-tula/0.1.0-alpha.0'
    )
  })

  test('200 is published, 404 is absent, and anything else is unknown, never absent', async () => {
    const extra = [staged('@tula/admin'), staged('@tula/cli'), staged('create-tula')]
    const { asked, fetcher } = answering({
      [registryUrl('@tula/contract', VERSION)]: 200,
      [registryUrl('@tula/core', VERSION)]: 404,
      [registryUrl('@tula/react', VERSION)]: 500,
      [registryUrl('@tula/admin', VERSION)]: 401,
      [registryUrl('@tula/cli', VERSION)]: new Error('getaddrinfo ENOTFOUND'),
      [registryUrl('create-tula', VERSION)]: 302,
    })
    const states = await registryStates([...packages, ...extra], fetcher)
    expect([...states]).toEqual([
      ['@tula/contract', 'published'],
      ['@tula/core', 'absent'],
      ['@tula/react', 'unknown'],
      ['@tula/admin', 'unknown'],
      ['@tula/cli', 'unknown'],
      ['create-tula', 'unknown'],
    ])
    // A plain GET of public metadata: one header, no credential, no redirect, a deadline.
    expect(asked).toHaveLength(6)
    for (const { init } of asked) {
      expect(init.headers).toEqual({ accept: 'application/json' })
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })

  test('a run that stopped half-way is resumed: what is there is skipped, the rest published', () => {
    const states = new Map<string, RegistryState>([
      ['@tula/contract', 'published'],
      ['@tula/core', 'published'],
      ['@tula/react', 'absent'],
    ])
    const plan = planRelease(packages, states, local, [])
    expect(plan.packages.map((entry) => [entry.pkg.name, entry.action])).toEqual([
      ['@tula/contract', 'skip'],
      ['@tula/core', 'skip'],
      ['@tula/react', 'publish'],
    ])
    expect(plan.refusals).toEqual([])
    expect(
      uploadCommands({ publish: true }, plan, staging).map((upload) => upload.pkg.name)
    ).toEqual(['@tula/react'])
  })

  test('everything already there: nothing to upload, and no refusal', () => {
    const all = new Map<string, RegistryState>(packages.map((pkg) => [pkg.name, 'published']))
    const plan = planRelease(packages, all, local, [])
    expect(plan.refusals).toEqual([])
    expect(uploadCommands({ publish: true }, plan, staging)).toEqual([])
  })

  test('a registry that did not answer for one package refuses the whole run', () => {
    const states = new Map<string, RegistryState>([
      ['@tula/contract', 'absent'],
      ['@tula/core', 'unknown'],
    ])
    // `@tula/react` has no answer at all: that is unknown too.
    const plan = planRelease(packages, states, local, [])
    expect(plan.refusals).toEqual([
      'the registry did not say whether @tula/core@0.1.0-alpha.0, @tula/react@0.1.0-alpha.0 exist',
    ])
    expect(uploadCommands({ publish: true }, plan, staging)).toEqual([])
  })
})

describe('which command uploads', () => {
  const oidc = {
    GITHUB_ACTIONS: 'true',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'opaque',
  }

  test('on a person’s machine: bun, their own login, no provenance, and it says so', () => {
    expect(local).toEqual({
      cli: 'bun',
      provenance: false,
      note: expect.stringContaining('WITHOUT provenance'),
      problems: [],
    })
    expect(publishCommand(core, staging, local)).toEqual([
      'bun',
      'publish',
      '/repo/.release/tula-core-0.1.0-alpha.0.tgz',
      '--access',
      'public',
      '--tag',
      'alpha',
    ])
    // A token on a laptop is the CLI's business: the script does not look, and does not use npm.
    expect(chooseChannel({ NPM_TOKEN: 'x', CI: 'true' }, '1.0.0').cli).toBe('bun')
  })

  test('in GitHub Actions with an OIDC identity: npm, with provenance and no token', () => {
    const channel = chooseChannel(oidc, '11.5.1')
    expect(channel).toMatchObject({ cli: 'npm', provenance: true, problems: [] })
    expect(publishCommand(core, staging, channel)).toEqual([
      'npm',
      'publish',
      '/repo/.release/tula-core-0.1.0-alpha.0.tgz',
      '--access',
      'public',
      '--tag',
      'alpha',
      '--provenance',
    ])
    expect(DIST_TAG).toBe('alpha')
  })

  test.each<[string, Record<string, string>, string | null, RegExp]>([
    ['no OIDC identity', { GITHUB_ACTIONS: 'true' }, '11.6.0', /no OIDC identity/],
    [
      'half an OIDC identity',
      { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid' },
      '11.6.0',
      /no OIDC identity/,
    ],
    ['a long-lived NPM_TOKEN', { ...oidc, NPM_TOKEN: 'npm_x' }, '11.6.0', /NPM_TOKEN is set/],
    [
      'a NODE_AUTH_TOKEN',
      { ...oidc, NODE_AUTH_TOKEN: 'npm_x' },
      '11.6.0',
      /NODE_AUTH_TOKEN is set/,
    ],
    ['no npm', oidc, null, /npm is not installed/],
    ['an npm before trusted publishing', oidc, '11.5.0', /npm 11\.5\.0 is older than 11\.5\.1/],
    ['an npm of an older major', oidc, '10.9.9', /npm 10\.9\.9 is older than 11\.5\.1/],
    ['an npm version that cannot be read', oidc, 'unknown', /is older than 11\.5\.1/],
  ])('in GitHub Actions, %s forbids the upload', (_what, env, npm, problem) => {
    const channel = chooseChannel(env, npm)
    expect(channel.cli).toBe('npm')
    expect(channel.problems.join('\n')).toMatch(problem)
    const plan = planRelease(packages, absent, channel, [])
    expect(uploadCommands({ publish: true }, plan, staging)).toEqual([])
    // What is said never repeats a value from the environment.
    expect(JSON.stringify(channel)).not.toMatch(/npm_x|opaque|example\.invalid/)
  })

  test.each([
    ['a package directory', '/repo/packages/core'],
    ['the staging directory of a package', '/repo/.release/@tula__core'],
    ['a tarball somewhere else', '/tmp/tula-core-0.1.0-alpha.0.tgz'],
    ['a tarball below the staging directory', '/repo/.release/nested/tula-core-0.1.0-alpha.0.tgz'],
    ['a path that climbs out of it', '/repo/.release/../packages/core/x.tgz'],
    ['the current directory', '.'],
  ])('%s is never published: only a staged tarball is', (_what, tarball) => {
    expect(() => publishCommand({ ...core, tarball }, staging, local)).toThrow(
      /only a staged tarball in \.release\/ is published, never a package directory/
    )
  })
})

describe('the one gate before an upload', () => {
  test('without --publish nothing is uploaded, whatever the plan says', () => {
    expect(sound().refusals).toEqual([])
    expect(uploadCommands({ publish: false }, sound(), staging)).toEqual([])
    expect(uploadCommands(parseReleaseArgs([]), sound(), staging)).toEqual([])
    expect(uploadCommands(parseReleaseArgs(['--dry-run']), sound(), staging)).toEqual([])
  })

  test('with --publish and no refusal every absent package is uploaded, in order', () => {
    const uploads = uploadCommands(parseReleaseArgs(['--publish']), sound(), staging)
    expect(uploads.map((upload) => upload.command.slice(0, 3))).toEqual([
      ['bun', 'publish', '/repo/.release/tula-contract-0.1.0-alpha.0.tgz'],
      ['bun', 'publish', '/repo/.release/tula-core-0.1.0-alpha.0.tgz'],
      ['bun', 'publish', '/repo/.release/tula-react-0.1.0-alpha.0.tgz'],
    ])
  })

  test.each<[string, Partial<Parameters<typeof refusals>[0]>]>([
    ['version 0.0.0', { packages: [staged('@tula/contract', { version: '0.0.0' })] }],
    ['a dirty tree', { after: { ...clean, clean: false } }],
    ['a commit that moved', { after: { head: 'c'.repeat(40), clean: true } }],
    ['a problem found elsewhere', { problems: ['the packed manifest has "private": true'] }],
  ])('with --publish and %s, nothing is uploaded', (_what, change) => {
    const input = { packages, before: clean, after: clean, ...change }
    const states = new Map<string, RegistryState>(input.packages.map((pkg) => [pkg.name, 'absent']))
    const plan = planRelease(input.packages, states, local, refusals(input))
    expect(plan.refusals.length).toBeGreaterThan(0)
    expect(uploadCommands({ publish: true }, plan, staging)).toEqual([])
  })

  // The value is compared with `true`, so nothing truthy that is not the parsed flag passes.
  test('only the parsed flag opens it', () => {
    for (const publish of ['true', 1, 'yes', {}, undefined, null]) {
      expect(uploadCommands({ publish } as never, sound(), staging)).toEqual([])
    }
  })
})

describe('what a person reads first', () => {
  const context = { head: 'a'.repeat(40), root }

  test('the dry run: every package with its version, tarball, size, files, tag and checksum', () => {
    expect(releaseReport({ publish: false }, sound(), context)).toBe(
      [
        'DRY RUN: commit aaaaaaaaaaaa, dist-tag "alpha", access public',
        `DRY RUN: ${local.note}`,
        'DRY RUN: publish @tula/contract@0.1.0-alpha.0  .release/tula-contract-0.1.0-alpha.0.tgz  2.0 kB, 5 files, tag alpha, sha256 abababababababab…',
        'DRY RUN: publish @tula/core@0.1.0-alpha.0  .release/tula-core-0.1.0-alpha.0.tgz  2.0 kB, 5 files, tag alpha, sha256 abababababababab…',
        'DRY RUN: publish @tula/react@0.1.0-alpha.0  .release/tula-react-0.1.0-alpha.0.tgz  2.0 kB, 5 files, tag alpha, sha256 abababababababab…',
        'DRY RUN: nothing was published. 3 packages would be; uploading takes `bun run release:publish` (docs/releasing.md).',
        '',
      ].join('\n')
    )
  })

  test('what is already there, what the registry did not say, and every refusal', () => {
    const states = new Map<string, RegistryState>([
      ['@tula/contract', 'published'],
      ['@tula/core', 'absent'],
    ])
    const plan = planRelease(
      packages,
      states,
      local,
      refusals({ packages, before: { ...clean, clean: false }, after: clean })
    )
    const report = releaseReport({ publish: false }, plan, context)
    expect(report).toContain(
      'DRY RUN: skip    @tula/contract@0.1.0-alpha.0 (already on the registry)'
    )
    expect(report).toContain('DRY RUN: publish @tula/core@0.1.0-alpha.0  ')
    expect(report).toContain(
      'DRY RUN: publish @tula/react@0.1.0-alpha.0 (the registry did not answer)  '
    )
    expect(report).toContain(
      'DRY RUN: a publish would be refused: the git tree had uncommitted changes when the build started'
    )
    expect(report).toContain(
      'DRY RUN: a publish would be refused: the registry did not say whether @tula/react@0.1.0-alpha.0 exist'
    )
    expect(report).toContain('DRY RUN: nothing was published. 2 packages would be;')

    const refused = releaseReport({ publish: true }, plan, context)
    expect(refused).toContain('RELEASE: REFUSED: the git tree had uncommitted changes')
    expect(refused.trimEnd().endsWith('RELEASE: nothing was published.')).toBe(true)
    expect(refused).not.toContain('DRY RUN')
  })

  test('a release that goes ahead says so in its own label, and one package is singular', () => {
    const one = planRelease([contract], new Map([['@tula/contract', 'absent']]), local, [])
    expect(releaseReport({ publish: true }, one, context)).not.toMatch(
      /DRY RUN|REFUSED|nothing was/
    )
    expect(releaseReport({ publish: false }, one, context)).toContain('1 package would be;')
  })
})
