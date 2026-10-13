import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  chooseChannel,
  DIST_TAG,
  type Fetcher,
  orderProblems,
  otpProblems,
  parseReleaseArgs,
  planRelease,
  printableCommand,
  publishCommand,
  type RegistryState,
  refusals,
  registryStates,
  registryUrl,
  releaseReport,
  type StagedPackage,
  type TreeState,
  uploadCommands,
  uploadOrder,
} from '../../scripts/release'

// The decisions of `bun run release:publish` (scripts/release.ts), each on its own: what it
// refuses, what it skips, which command uploads and what a person reads first. Nothing here
// builds a package or reaches a registry. That the script and the workflow are wired to
// these decisions, and to nothing else, is held by release.test.ts.

const root = '/repo'
const staging = join(root, '.release')
const VERSION = '0.1.0-alpha.0'
const INTEGRITY = `sha512-${'q'.repeat(86)}==`
const OTHER_INTEGRITY = `sha512-${'z'.repeat(86)}==`

function staged(name: string, change: Partial<StagedPackage> = {}): StagedPackage {
  return {
    name,
    version: VERSION,
    tarball: join(staging, `${name.replace('@', '').replace('/', '-')}-${VERSION}.tgz`),
    bytes: 2048,
    files: 5,
    sha256: 'ab'.repeat(32),
    integrity: INTEGRITY,
    manifest: { name, version: VERSION },
    ...change,
  }
}

const contract = staged('@tula-tech/contract')
const core = staged('@tula-tech/core', {
  manifest: {
    name: '@tula-tech/core',
    version: VERSION,
    dependencies: { '@tula-tech/contract': VERSION },
  },
})
const react = staged('@tula-tech/react', {
  manifest: {
    name: '@tula-tech/react',
    version: VERSION,
    dependencies: { '@tula-tech/contract': VERSION, '@tula-tech/core': VERSION },
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
    expect(parseReleaseArgs([])).toEqual({ publish: false, otp: null })
    expect(parseReleaseArgs(['--dry-run'])).toEqual({ publish: false, otp: null })
    expect(parseReleaseArgs(['--publish'])).toEqual({ publish: true, otp: null })
  })

  test.each([
    [['--publsh']],
    [['publish']],
    [['-p']],
    [['--publish=true']],
    [['--yes']],
    [['--publish', '--otp=123456']],
    [['--publish', '--auth-type', 'web']],
    [['']],
  ])('%j is refused, never read as the default', (argv) => {
    expect(() => parseReleaseArgs(argv)).toThrow(/unknown argument/)
  })

  // A code typed without its flag is still a code: the message says that digits were
  // given, not which.
  test.each(['123456', '1234567', '12345678'])(
    'digits that look like a one-time password are not repeated as an unknown argument: %s',
    (code) => {
      for (const argv of [
        ['--publish', code],
        [code, '--publish'],
        ['--publish', '--otpp', code],
      ]) {
        let message = ''
        try {
          parseReleaseArgs(argv)
        } catch (error) {
          message = (error as Error).message
        }
        expect(message).toMatch(/unknown argument/)
        expect(message).toContain('"<digits>"')
        expect(message).not.toContain(code)
      }
    }
  )

  test('other unknown arguments are still named, so a typo can be seen', () => {
    expect(() => parseReleaseArgs(['--publsh'])).toThrow(/unknown argument "--publsh"/)
    expect(() => parseReleaseArgs(['12345'])).toThrow(/unknown argument "12345"/)
  })

  test('both flags together are refused', () => {
    expect(() => parseReleaseArgs(['--dry-run', '--publish'])).toThrow(/choose one/)
    // What `bun run release:dry-run --publish` becomes: Bun appends the argument.
    expect(() => parseReleaseArgs(['--dry-run', '--publish', '--otp', '123456'])).toThrow(
      /choose one/
    )
  })

  test.each(['123456', '1234567', '12345678'])(
    'a one-time password of 6 to 8 digits is taken with --publish: %s',
    (code) => {
      expect(parseReleaseArgs(['--publish', '--otp', code])).toEqual({ publish: true, otp: code })
      expect(parseReleaseArgs(['--otp', code, '--publish'])).toEqual({ publish: true, otp: code })
    }
  )

  // What was typed after `--otp` may be a password, a token or a real code with a typo: it
  // is never repeated, not even to say that it is wrong.
  test.each([
    ['five digits', '12345'],
    ['nine digits', '123456789'],
    ['a letter', '12a456'],
    ['a token', 'npm_SECRETsecretSECRET'],
    ['spaces', '123 456'],
    ['nothing', ''],
    ['the next flag', '--publish'],
  ])('a one-time password that is %s is refused, and not repeated', (_what, value) => {
    let message = ''
    try {
      parseReleaseArgs(['--publish', '--otp', value])
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/--otp takes the 6 to 8 digits/)
    if (value !== '' && value !== '--publish') {
      expect(message).not.toContain(value)
    }
  })

  test('--otp without a value, twice, or without --publish is refused', () => {
    expect(() => parseReleaseArgs(['--publish', '--otp'])).toThrow(/--otp takes the 6 to 8 digits/)
    expect(() => parseReleaseArgs(['--publish', '--otp', '123456', '--otp', '654321'])).toThrow(
      /--otp was given twice/
    )
    for (const argv of [
      ['--otp', '123456'],
      ['--dry-run', '--otp', '123456'],
    ]) {
      let message = ''
      try {
        parseReleaseArgs(argv)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toMatch(/--otp is only for --publish/)
      expect(message).not.toContain('123456')
    }
  })

  // The code is typed by a person at a terminal: a job that has one got it from a variable
  // or a file, which is a second factor stored beside the first.
  test.each<[string, Record<string, string>]>([
    ['GitHub Actions', { GITHUB_ACTIONS: 'true' }],
    ['any CI', { CI: 'true' }],
    ['a CI that sets CI=1', { CI: '1' }],
  ])('a one-time password is refused in %s', (_what, env) => {
    const problems = otpProblems({ publish: true, otp: '123456' }, env)
    expect(problems).toEqual([
      '--otp was given in CI: a one-time password is typed by a person, at their own machine, and is never stored where a job can read it',
    ])
    expect(otpProblems({ publish: true, otp: null }, env)).toEqual([])
    const plan = planRelease(
      packages,
      absent,
      local,
      refusals({ packages, before: clean, after: clean, problems })
    )
    expect(uploadCommands({ publish: true, otp: '123456' }, plan, staging)).toEqual([])
  })

  test('on a person’s machine a one-time password is no problem', () => {
    expect(otpProblems({ publish: true, otp: '123456' }, {})).toEqual([])
    expect(otpProblems({ publish: true, otp: '123456' }, { CI: '' })).toEqual([])
  })
})

describe('the order of a release', () => {
  test('dependencies first is sound', () => {
    expect(orderProblems(packages)).toEqual([])
  })

  test('a package before what it depends on is named, in any dependency field', () => {
    expect(orderProblems([core, contract, react])).toEqual([
      '@tula-tech/core depends on @tula-tech/contract, which would be published after it',
    ])
    const peer = staged('@tula-tech/nextjs', {
      manifest: {
        name: '@tula-tech/nextjs',
        version: VERSION,
        peerDependencies: { '@tula-tech/react': VERSION },
      },
    })
    expect(orderProblems([contract, core, peer, react])).toEqual([
      '@tula-tech/nextjs depends on @tula-tech/react, which would be published after it',
    ])
  })

  test('a dependency that is not part of the release does not count', () => {
    expect(orderProblems([react])).toEqual([])
  })

  // A scope belongs to its organisation; an unscoped name is anyone's until it is taken,
  // and npm never accepts again a version that once existed, while it answers 404 for it.
  // So the unscoped package goes first: if its upload is refused, nothing else went out.
  test('an unscoped package is uploaded first, and the rest keep their order', () => {
    const createTula = staged('create-tula')
    const ordered = uploadOrder([contract, core, react, createTula])
    expect(ordered.map((pkg) => pkg.name)).toEqual([
      'create-tula',
      '@tula-tech/contract',
      '@tula-tech/core',
      '@tula-tech/react',
    ])
    expect(orderProblems(ordered)).toEqual([])
    expect(uploadOrder(packages)).toEqual(packages)
  })

  test('an unscoped package that depends on a scoped one is still named by the order check', () => {
    const needy = staged('create-tula', {
      manifest: {
        name: 'create-tula',
        version: VERSION,
        dependencies: { '@tula-tech/contract': VERSION },
      },
    })
    expect(orderProblems(uploadOrder([contract, needy]))).toEqual([
      'create-tula depends on @tula-tech/contract, which would be published after it',
    ])
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
        staged('@tula-tech/contract', {
          version,
          manifest: { name: '@tula-tech/contract', version },
        }),
      ]
      expect(check({ packages: other })).toEqual([
        `the version ${version} is not an alpha prerelease, and this script publishes under the dist-tag "alpha" only`,
      ])
    }
  )

  test('packages of the fixed group at different versions', () => {
    const ahead = staged('@tula-tech/admin', { version: '0.1.0-alpha.1' })
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
    const stale = staged('@tula-tech/core', {
      manifest: {
        name: '@tula-tech/core',
        version: VERSION,
        dependencies: { '@tula-tech/contract': '0.0.9' },
      },
    })
    expect(check({ packages: [contract, stale] })).toEqual([
      '@tula-tech/core asks for @tula-tech/contract@0.0.9, and this release publishes 0.1.0-alpha.0',
    ])
  })

  test('nothing to release, a wrong order and problems found elsewhere are all listed', () => {
    expect(check({ packages: [] })).toEqual(['there is no package to release'])
    expect(check({ packages: [core, contract], problems: ['a tarball is wrong'] })).toEqual([
      'a tarball is wrong',
      '@tula-tech/core depends on @tula-tech/contract, which would be published after it',
    ])
  })
})

describe('what the registry already has', () => {
  /** A status alone is answered with the body of the same tarball; a pair gives the body. */
  const answering = (statuses: Record<string, number | Error | [number, unknown]>) => {
    const asked: { url: string; init: Parameters<Fetcher>[1] }[] = []
    const fetcher: Fetcher = async (url, init) => {
      asked.push({ url, init })
      const answer = statuses[url]
      if (answer === undefined || answer instanceof Error) {
        throw answer ?? new Error('unexpected request')
      }
      const [status, body] =
        typeof answer === 'number' ? [answer, { dist: { integrity: INTEGRITY } }] : answer
      return {
        status,
        json: async () => {
          if (body instanceof Error) {
            throw body
          }
          return body
        },
      }
    }
    return { asked, fetcher }
  }

  // A version on the registry is skipped only when it is the tarball this run built. A run
  // that failed after four packages and is finished from a later commit would otherwise
  // publish five packages of one commit beside four of another, under one version.
  test.each<[string, unknown, RegistryState]>([
    ['the same integrity', { dist: { integrity: INTEGRITY } }, 'published'],
    ['another integrity', { dist: { integrity: OTHER_INTEGRITY } }, 'different'],
    ['a shasum and no integrity', { dist: { shasum: 'ab'.repeat(20) } }, 'unstated'],
    ['no dist', { name: '@tula-tech/contract' }, 'unstated'],
    ['an integrity that is not a string', { dist: { integrity: 7 } }, 'unstated'],
    ['an empty integrity', { dist: { integrity: '' } }, 'unstated'],
    ['a body that is not an object', 'ok', 'unstated'],
    ['a body that cannot be read', new Error('Unexpected token'), 'unknown'],
  ])('a version that is there with %s', async (_what, body, expected) => {
    const { fetcher } = answering({ [registryUrl('@tula-tech/contract', VERSION)]: [200, body] })
    expect([...(await registryStates([contract], fetcher))]).toEqual([
      ['@tula-tech/contract', expected],
    ])
  })

  // Nothing was compared, so "other contents" would be a claim the script cannot make. It
  // still refuses: a version it cannot vouch for is not skipped.
  test('a version the registry states no integrity for refuses the run, and says that', () => {
    const states = new Map<string, RegistryState>([
      ['@tula-tech/contract', 'unstated'],
      ['@tula-tech/core', 'absent'],
      ['@tula-tech/react', 'absent'],
    ])
    const plan = planRelease(packages, states, local, [])
    expect(plan.packages[0]?.action).toBe('refuse')
    expect(plan.refusals).toEqual([
      '@tula-tech/contract@0.1.0-alpha.0 is on the registry and the registry states no integrity for it, so it cannot be compared with the tarball this run built: nothing is uploaded beside a version that cannot be vouched for',
    ])
    expect(plan.refusals.join('\n')).not.toContain('other contents')
    expect(uploadCommands({ publish: true, otp: null }, plan, staging)).toEqual([])
    const report = releaseReport({ publish: false, otp: null }, plan, {
      head: 'a'.repeat(40),
      root,
    })
    expect(report).toContain(
      'DRY RUN: UNKNOWN @tula-tech/contract@0.1.0-alpha.0 (on the registry, which states no integrity for it)'
    )
    expect(report).not.toContain('DIFFERS')
  })

  test('a version that is there with other contents refuses the whole run, and says why', () => {
    const states = new Map<string, RegistryState>([
      ['@tula-tech/contract', 'published'],
      ['@tula-tech/core', 'different'],
      ['@tula-tech/react', 'absent'],
    ])
    const plan = planRelease(packages, states, local, [])
    expect(plan.packages.map((entry) => [entry.pkg.name, entry.action])).toEqual([
      ['@tula-tech/contract', 'skip'],
      ['@tula-tech/core', 'refuse'],
      ['@tula-tech/react', 'publish'],
    ])
    expect(plan.refusals).toEqual([
      '@tula-tech/core@0.1.0-alpha.0 is on the registry with other contents than the tarball this run built: a release is finished from the commit it started from, or a new version is cut',
    ])
    expect(uploadCommands({ publish: true, otp: null }, plan, staging)).toEqual([])
    const report = releaseReport({ publish: false, otp: null }, plan, {
      head: 'a'.repeat(40),
      root,
    })
    expect(report).toContain(
      'DRY RUN: DIFFERS @tula-tech/core@0.1.0-alpha.0 (on the registry with other contents)'
    )
    expect(report).toContain('DRY RUN: nothing was published. 1 package would be;')
  })

  test('a scoped name keeps its @ and has its slash encoded', () => {
    expect(registryUrl('@tula-tech/core', VERSION)).toBe(
      'https://registry.npmjs.org/@tula-tech%2Fcore/0.1.0-alpha.0'
    )
    expect(registryUrl('create-tula', VERSION)).toBe(
      'https://registry.npmjs.org/create-tula/0.1.0-alpha.0'
    )
  })

  test('200 is published, 404 is absent, and anything else is unknown, never absent', async () => {
    const extra = [staged('@tula-tech/admin'), staged('@tula-tech/cli'), staged('create-tula')]
    const { asked, fetcher } = answering({
      [registryUrl('@tula-tech/contract', VERSION)]: 200,
      [registryUrl('@tula-tech/core', VERSION)]: 404,
      [registryUrl('@tula-tech/react', VERSION)]: 500,
      [registryUrl('@tula-tech/admin', VERSION)]: 401,
      [registryUrl('@tula-tech/cli', VERSION)]: new Error('getaddrinfo ENOTFOUND'),
      [registryUrl('create-tula', VERSION)]: 302,
    })
    const states = await registryStates([...packages, ...extra], fetcher)
    expect([...states]).toEqual([
      ['@tula-tech/contract', 'published'],
      ['@tula-tech/core', 'absent'],
      ['@tula-tech/react', 'unknown'],
      ['@tula-tech/admin', 'unknown'],
      ['@tula-tech/cli', 'unknown'],
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
      ['@tula-tech/contract', 'published'],
      ['@tula-tech/core', 'published'],
      ['@tula-tech/react', 'absent'],
    ])
    const plan = planRelease(packages, states, local, [])
    expect(plan.packages.map((entry) => [entry.pkg.name, entry.action])).toEqual([
      ['@tula-tech/contract', 'skip'],
      ['@tula-tech/core', 'skip'],
      ['@tula-tech/react', 'publish'],
    ])
    expect(plan.refusals).toEqual([])
    expect(
      uploadCommands({ publish: true, otp: null }, plan, staging).map((upload) => upload.pkg.name)
    ).toEqual(['@tula-tech/react'])
  })

  test('everything already there: nothing to upload, and no refusal', () => {
    const all = new Map<string, RegistryState>(packages.map((pkg) => [pkg.name, 'published']))
    const plan = planRelease(packages, all, local, [])
    expect(plan.refusals).toEqual([])
    expect(uploadCommands({ publish: true, otp: null }, plan, staging)).toEqual([])
  })

  test('a registry that did not answer for one package refuses the whole run', () => {
    const states = new Map<string, RegistryState>([
      ['@tula-tech/contract', 'absent'],
      ['@tula-tech/core', 'unknown'],
    ])
    // `@tula-tech/react` has no answer at all: that is unknown too.
    const plan = planRelease(packages, states, local, [])
    expect(plan.refusals).toEqual([
      'the registry did not say whether @tula-tech/core@0.1.0-alpha.0, @tula-tech/react@0.1.0-alpha.0 exist',
    ])
    expect(uploadCommands({ publish: true, otp: null }, plan, staging)).toEqual([])
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
      '/repo/.release/tula-tech-core-0.1.0-alpha.0.tgz',
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
      '/repo/.release/tula-tech-core-0.1.0-alpha.0.tgz',
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
    expect(uploadCommands({ publish: true, otp: null }, plan, staging)).toEqual([])
    // What is said never repeats a value from the environment.
    expect(JSON.stringify(channel)).not.toMatch(/npm_x|opaque|example\.invalid/)
  })

  // The code is one element of the argument vector, never part of a string a shell reads,
  // and what is printed of the command has it struck out.
  test('a one-time password is passed as an argument of its own and never printed', () => {
    const command = publishCommand(core, staging, local, '123456')
    expect(command).toEqual([
      'bun',
      'publish',
      '/repo/.release/tula-tech-core-0.1.0-alpha.0.tgz',
      '--access',
      'public',
      '--tag',
      'alpha',
      '--otp',
      '123456',
    ])
    expect(printableCommand(command)).toBe(
      'bun publish /repo/.release/tula-tech-core-0.1.0-alpha.0.tgz --access public --tag alpha --otp ******'
    )
    expect(printableCommand(['bun', 'publish', '--otp'])).toBe('bun publish --otp')
    expect(printableCommand(['bun', 'publish', '--otp=123456'])).toBe('bun publish --otp=******')
    expect(publishCommand(core, staging, local, null)).not.toContain('--otp')
    expect(publishCommand(core, staging, local)).not.toContain('--otp')

    const args = parseReleaseArgs(['--publish', '--otp', '123456'])
    const uploads = uploadCommands(args, sound(), staging)
    expect(uploads).toHaveLength(3)
    for (const upload of uploads) {
      expect(upload.command.slice(-2)).toEqual(['--otp', '123456'])
    }
    expect(releaseReport(args, sound(), { head: 'a'.repeat(40), root })).not.toContain('123456')
    expect(JSON.stringify(sound())).not.toContain('123456')
  })

  test.each([
    ['a package directory', '/repo/packages/core'],
    ['the staging directory of a package', '/repo/.release/@tula-tech__core'],
    ['a tarball somewhere else', '/tmp/tula-tech-core-0.1.0-alpha.0.tgz'],
    [
      'a tarball below the staging directory',
      '/repo/.release/nested/tula-tech-core-0.1.0-alpha.0.tgz',
    ],
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
    expect(uploadCommands({ publish: false, otp: null }, sound(), staging)).toEqual([])
    expect(uploadCommands(parseReleaseArgs([]), sound(), staging)).toEqual([])
    expect(uploadCommands(parseReleaseArgs(['--dry-run']), sound(), staging)).toEqual([])
  })

  test('with --publish and no refusal every absent package is uploaded, in order', () => {
    const uploads = uploadCommands(parseReleaseArgs(['--publish']), sound(), staging)
    expect(uploads.map((upload) => upload.command.slice(0, 3))).toEqual([
      ['bun', 'publish', '/repo/.release/tula-tech-contract-0.1.0-alpha.0.tgz'],
      ['bun', 'publish', '/repo/.release/tula-tech-core-0.1.0-alpha.0.tgz'],
      ['bun', 'publish', '/repo/.release/tula-tech-react-0.1.0-alpha.0.tgz'],
    ])
  })

  test.each<[string, Partial<Parameters<typeof refusals>[0]>]>([
    ['version 0.0.0', { packages: [staged('@tula-tech/contract', { version: '0.0.0' })] }],
    ['a dirty tree', { after: { ...clean, clean: false } }],
    ['a commit that moved', { after: { head: 'c'.repeat(40), clean: true } }],
    ['a problem found elsewhere', { problems: ['the packed manifest has "private": true'] }],
  ])('with --publish and %s, nothing is uploaded', (_what, change) => {
    const input = { packages, before: clean, after: clean, ...change }
    const states = new Map<string, RegistryState>(input.packages.map((pkg) => [pkg.name, 'absent']))
    const plan = planRelease(input.packages, states, local, refusals(input))
    expect(plan.refusals.length).toBeGreaterThan(0)
    expect(uploadCommands({ publish: true, otp: null }, plan, staging)).toEqual([])
  })

  // The value is compared with `true`, so nothing truthy that is not the parsed flag passes.
  test('only the parsed flag opens it', () => {
    for (const publish of ['true', 1, 'yes', {}, undefined, null]) {
      expect(uploadCommands({ publish, otp: null } as never, sound(), staging)).toEqual([])
    }
  })
})

describe('what a person reads first', () => {
  const context = { head: 'a'.repeat(40), root }

  test('the dry run: every package with its version, tarball, size, files, tag and checksum', () => {
    expect(releaseReport({ publish: false, otp: null }, sound(), context)).toBe(
      [
        'DRY RUN: commit aaaaaaaaaaaa, dist-tag "alpha", access public',
        `DRY RUN: ${local.note}`,
        'DRY RUN: publish @tula-tech/contract@0.1.0-alpha.0  .release/tula-tech-contract-0.1.0-alpha.0.tgz  2.0 kB, 5 files, tag alpha, sha256 abababababababab…',
        'DRY RUN: publish @tula-tech/core@0.1.0-alpha.0  .release/tula-tech-core-0.1.0-alpha.0.tgz  2.0 kB, 5 files, tag alpha, sha256 abababababababab…',
        'DRY RUN: publish @tula-tech/react@0.1.0-alpha.0  .release/tula-tech-react-0.1.0-alpha.0.tgz  2.0 kB, 5 files, tag alpha, sha256 abababababababab…',
        'DRY RUN: nothing was published. 3 packages would be; uploading takes `bun run release:publish` (docs/releasing.md).',
        '',
      ].join('\n')
    )
  })

  test('what is already there, what the registry did not say, and every refusal', () => {
    const states = new Map<string, RegistryState>([
      ['@tula-tech/contract', 'published'],
      ['@tula-tech/core', 'absent'],
    ])
    const plan = planRelease(
      packages,
      states,
      local,
      refusals({ packages, before: { ...clean, clean: false }, after: clean })
    )
    const report = releaseReport({ publish: false, otp: null }, plan, context)
    expect(report).toContain(
      'DRY RUN: skip    @tula-tech/contract@0.1.0-alpha.0 (already on the registry, the same tarball)'
    )
    expect(report).toContain('DRY RUN: publish @tula-tech/core@0.1.0-alpha.0  ')
    expect(report).toContain(
      'DRY RUN: publish @tula-tech/react@0.1.0-alpha.0 (the registry did not answer)  '
    )
    expect(report).toContain(
      'DRY RUN: a publish would be refused: the git tree had uncommitted changes when the build started'
    )
    expect(report).toContain(
      'DRY RUN: a publish would be refused: the registry did not say whether @tula-tech/react@0.1.0-alpha.0 exist'
    )
    expect(report).toContain('DRY RUN: nothing was published. 2 packages would be;')

    const refused = releaseReport({ publish: true, otp: null }, plan, context)
    expect(refused).toContain('RELEASE: REFUSED: the git tree had uncommitted changes')
    expect(refused.trimEnd().endsWith('RELEASE: nothing was published.')).toBe(true)
    expect(refused).not.toContain('DRY RUN')
  })

  // The workflow's dry-run job has no OIDC identity on purpose (only the publish job has
  // `id-token: write`), so on every push to `main` the report would cry "refused" about
  // something that is as it should be. A dry run says it as a note; an upload still refuses.
  test('in a dry run, what only the uploading job needs is a note and not a refusal', () => {
    const channel = chooseChannel({ GITHUB_ACTIONS: 'true' }, '11.6.0')
    const plan = planRelease(
      packages,
      absent,
      channel,
      refusals({ packages, before: { ...clean, clean: false }, after: clean })
    )
    const report = releaseReport({ publish: false, otp: null }, plan, context)
    expect(report).toContain(
      'DRY RUN: note, not checked in a dry run (the job that uploads must have it): this GitHub Actions job has no OIDC identity'
    )
    expect(report).not.toMatch(/would be refused: this GitHub Actions job/)
    // A real reason is still a refusal, in the same report.
    expect(report).toContain(
      'DRY RUN: a publish would be refused: the git tree had uncommitted changes when the build started'
    )
    // With --publish it refuses, in so many words, and nothing is uploaded.
    const refused = releaseReport({ publish: true, otp: null }, plan, context)
    expect(refused).toContain('RELEASE: REFUSED: this GitHub Actions job has no OIDC identity')
    expect(refused).not.toContain('note, not checked')
    expect(uploadCommands({ publish: true, otp: null }, plan, staging)).toEqual([])
  })

  test('a release that goes ahead says so in its own label, and one package is singular', () => {
    const one = planRelease([contract], new Map([['@tula-tech/contract', 'absent']]), local, [])
    expect(releaseReport({ publish: true, otp: null }, one, context)).not.toMatch(
      /DRY RUN|REFUSED|nothing was/
    )
    expect(releaseReport({ publish: false, otp: null }, one, context)).toContain(
      '1 package would be;'
    )
  })
})
