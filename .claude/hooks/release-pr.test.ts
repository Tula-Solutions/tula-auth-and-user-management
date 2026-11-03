import { afterEach, describe, expect, test } from 'bun:test'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  API_MANIFEST,
  changelogEntries,
  HAND_KEPT_CONSTANTS,
  pendingChangesets,
  plan,
  planCommand,
  prepareCommand,
  RELEASE_BRANCH,
  releaseBody,
  releaseTitle,
  syncHandKeptVersions,
} from '../../scripts/release-pr'

// The release pull request is built by scripts/release-pr.ts and opened by
// .github/workflows/release-pr.yml, which runs only on `develop`; the back-merge runs only on
// `main`. No pull request exercises either, so these tests are what runs before a merge: the
// decisions, the places a release moves by hand, the changelog the body lists, a plan made
// against a real git history, and the rules the three workflows are held to (triggers,
// permissions, no stored credential, concurrency and the dispatch of the required checks).

const root = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

const scratch: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'release-pr-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('what a push to develop does', () => {
  test.each([
    ['nothing pending', [], [], 'none'],
    ['nothing pending, though main consumed some', [], ['a.md'], 'none'],
    ['changesets pending, none consumed', ['a.md', 'b.md'], [], 'release'],
    ['a pending changeset a release already consumed', ['a.md', 'b.md'], ['a.md'], 'wait'],
    ['only consumed changesets left (the back-merge is missing)', ['a.md'], ['a.md'], 'wait'],
  ])('%s -> %s', (_name, pending, consumed, expected) => {
    expect(plan(pending, consumed)).toBe(expected as ReturnType<typeof plan>)
  })

  test('the title names the version, and the branch is the one every workflow names', () => {
    expect(releaseTitle('0.2.0')).toBe('release: v0.2.0')
    expect(RELEASE_BRANCH).toBe('release/next')
  })

  test('pending changesets are the Markdown files of .changeset/, README excluded', () => {
    const dir = temp()
    mkdirSync(join(dir, '.changeset'))
    writeFileSync(join(dir, '.changeset', 'config.json'), '{"fixed":[["x"]]}')
    for (const name of ['README.md', 'b-owl.md', 'a-fox.md', 'notes.txt']) {
      writeFileSync(join(dir, '.changeset', name), '---\n"x": patch\n---\n\nx\n')
    }
    expect(pendingChangesets(dir)).toEqual(['a-fox.md', 'b-owl.md'])
  })
})

describe('the plan against a real history', () => {
  /** Run git in `cwd` with no user config and no hooks. */
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(
      [
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=',
        ...args,
      ],
      { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 20_000, env: { ...process.env, HOME: cwd } }
    )
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
    }
    return result.stdout.toString()
  }

  /** A repository where `main` has deleted the changesets in `consumed`, and `develop` still has every one. */
  const repo = (all: string[], consumed: string[]) => {
    const dir = temp()
    git(dir, 'init', '-q', '-b', 'develop')
    mkdirSync(join(dir, '.changeset'))
    writeFileSync(join(dir, '.changeset', 'config.json'), '{"fixed":[["x"]]}')
    for (const name of all) {
      writeFileSync(join(dir, '.changeset', name), `---\n"x": patch\n---\n\n${name}\n`)
    }
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'develop: changesets')
    git(dir, 'branch', 'main')
    git(dir, 'switch', '-q', 'main')
    for (const name of consumed) {
      git(dir, 'rm', '-q', `.changeset/${name}`)
    }
    writeFileSync(join(dir, 'version.txt'), '1')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'release')
    git(dir, 'switch', '-q', 'develop')
    return dir
  }

  const planFor = (dir: string): { action: string; pending: string } => {
    const out = join(dir, 'out.txt')
    writeFileSync(out, '')
    const before = process.env.GITHUB_OUTPUT
    process.env.GITHUB_OUTPUT = out
    try {
      planCommand(dir, 'main')
    } finally {
      if (before === undefined) {
        delete process.env.GITHUB_OUTPUT
      } else {
        process.env.GITHUB_OUTPUT = before
      }
    }
    return Object.fromEntries(
      readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=') as [string, string])
    ) as { action: string; pending: string }
  }

  // Each case starts a handful of git processes: Bun's default five seconds is too little on a slow runner.
  test('pending changesets that no commit of main deleted -> release', () => {
    expect(planFor(repo(['a.md', 'b.md'], []))).toEqual({ action: 'release', pending: '2' })
  }, 30_000)

  test('a changeset that main deleted (the release is not back on develop) -> wait', () => {
    expect(planFor(repo(['a.md', 'b.md'], ['a.md']))).toEqual({ action: 'wait', pending: '2' })
  }, 30_000)

  test('no changeset at all -> none', () => {
    expect(planFor(repo([], []))).toEqual({ action: 'none', pending: '0' })
  }, 30_000)

  test('a squashed back-merge does not stall: once develop has the deletion, a new changeset releases', () => {
    const dir = repo(['a.md'], ['a.md'])
    // develop gets the deletion as a plain commit (a squash has no merge parent) and a new changeset.
    git(dir, 'rm', '-q', '.changeset/a.md')
    writeFileSync(join(dir, '.changeset', 'c.md'), '---\n"x": patch\n---\n\nc\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'develop: squash of the back-merge, and c')
    expect(planFor(dir)).toEqual({ action: 'release', pending: '1' })
  }, 30_000)

  test('the back-merge test of back-merge.yml: a squashed back-merge leaves nothing to bring back', () => {
    // The two expressions of the workflow, run as written against a history where main's
    // content is on develop but main's commits are not.
    const dir = repo(['a.md'], ['a.md'])
    git(dir, 'rm', '-q', '.changeset/a.md')
    writeFileSync(join(dir, 'version.txt'), '1')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'develop: squash of the release')
    const ancestor = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', 'main', 'develop'], {
      cwd: dir,
      timeout: 20_000,
    })
    expect(ancestor.exitCode).toBe(1)
    const merged = git(dir, 'merge-tree', '--write-tree', 'develop', 'main').split('\n')[0]
    expect(merged).toBe(git(dir, 'rev-parse', 'develop^{tree}').trim())
    // And with content only main has, the trees differ: the pull request is due.
    git(dir, 'switch', '-q', 'main')
    writeFileSync(join(dir, 'only-main.txt'), '1')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'main: a hotfix')
    const due = git(dir, 'merge-tree', '--write-tree', 'develop', 'main').split('\n')[0]
    expect(due).not.toBe(git(dir, 'rev-parse', 'develop^{tree}').trim())
  }, 30_000)
})

describe('a changeset that releases nothing is not pending', () => {
  const dirWith = (files: Record<string, string>) => {
    const dir = temp()
    mkdirSync(join(dir, '.changeset'))
    writeFileSync(join(dir, '.changeset', 'config.json'), '{"fixed":[["x","y"]]}')
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, '.changeset', name), text)
    }
    return dir
  }

  test.each([
    ['an empty changeset', '---\n---\n'],
    [
      'one that names only a package outside the fixed group',
      '---\n"private-app": minor\n---\n\nx\n',
    ],
    ['one with no front matter', 'just text\n'],
  ])('%s releases nothing: no release pull request', (_name, text) => {
    expect(pendingChangesets(dirWith({ 'a.md': text }))).toEqual([])
  })

  test('one that names a package of the group is pending', () => {
    const dir = dirWith({ 'a.md': '---\n"y": patch\n---\n\nx\n', 'b.md': '---\n---\n' })
    expect(pendingChangesets(dir)).toEqual(['a.md'])
  })
})

describe('prepare, against a throwaway repository', () => {
  const vcs = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(
      ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args],
      { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 20_000, env: { ...process.env, HOME: cwd } }
    )
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
    }
    return result.stdout.toString()
  }

  /** The files a release touches, at the current version, committed. */
  const repo = () => {
    const dir = temp()
    vcs(dir, 'init', '-q', '-b', 'develop')
    for (const file of [...HAND_KEPT_CONSTANTS, API_MANIFEST]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      cpSync(join(root, file), join(dir, file))
    }
    const current = (JSON.parse(read(API_MANIFEST)) as { version: string }).version
    mkdirSync(join(dir, 'packages/contract'), { recursive: true })
    writeFileSync(join(dir, 'packages/contract/package.json'), `{"version":"${current}"}\n`)
    writeFileSync(join(dir, 'packages/contract/CHANGELOG.md'), '# c\n')
    vcs(dir, 'add', '-A')
    vcs(dir, 'commit', '-q', '-m', 'base')
    return { dir, current }
  }

  /** Stand-ins for `changeset version` and the lockfile, which need the installed workspace. */
  const steps = (next: string) => ({
    changesetVersion: (dir: string) => {
      writeFileSync(join(dir, 'packages/contract/package.json'), `{"version":"${next}"}\n`)
      writeFileSync(
        join(dir, 'packages/contract/CHANGELOG.md'),
        `# c\n\n## ${next}\n\n### Minor Changes\n\n- abcdef1: Something new.\n`
      )
    },
    lockfile: (dir: string) => writeFileSync(join(dir, 'bun.lock'), `locked ${next}\n`),
  })

  test('moves every place, commits once, leaves a clean tree, writes the body and the outputs', () => {
    const { dir } = repo()
    const body = join(temp(), 'body.md')
    const out = join(temp(), 'out.txt')
    writeFileSync(out, '')
    const before = process.env.GITHUB_OUTPUT
    process.env.GITHUB_OUTPUT = out
    try {
      expect(prepareCommand(dir, body, steps('9.8.7'))).toBe('9.8.7')
    } finally {
      if (before === undefined) {
        delete process.env.GITHUB_OUTPUT
      } else {
        process.env.GITHUB_OUTPUT = before
      }
    }
    expect(vcs(dir, 'status', '--porcelain')).toBe('')
    expect(vcs(dir, 'log', '--format=%s').trim().split('\n')).toEqual([
      'chore(release): 9.8.7',
      'base',
    ])
    expect(readFileSync(join(dir, 'packages/cli/src/version.ts'), 'utf8')).toMatch(
      /VERSION = '9\.8\.7'/
    )
    expect(JSON.parse(readFileSync(join(dir, API_MANIFEST), 'utf8')).version).toBe('9.8.7')
    expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe('locked 9.8.7\n')
    expect(readFileSync(body, 'utf8')).toContain('- Something new.')
    expect(readFileSync(out, 'utf8')).toBe('version=9.8.7\ntitle=release: v9.8.7\n')
  }, 30_000)

  test('refuses a dirty tree', () => {
    const { dir } = repo()
    writeFileSync(join(dir, 'stray.txt'), 'x')
    expect(() => prepareCommand(dir, join(temp(), 'b.md'), steps('9.8.7'))).toThrow('not clean')
  }, 30_000)

  test('refuses a run that did not move the version (the PR would propose what is released)', () => {
    const { dir, current } = repo()
    expect(() => prepareCommand(dir, join(temp(), 'b.md'), steps(current))).toThrow(
      'did not move the version'
    )
    expect(vcs(dir, 'log', '--format=%s').trim()).toBe('base')
  }, 30_000)
})

describe('the places a release moves by hand', () => {
  /** A copy of the real files that hold the version by hand, at a made-up old version. */
  const copy = () => {
    const dir = temp()
    for (const file of [...HAND_KEPT_CONSTANTS, API_MANIFEST]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      cpSync(join(root, file), join(dir, file))
    }
    return dir
  }

  test('the four places the version test reads move together, and only those', () => {
    const dir = copy()
    const files = syncHandKeptVersions(dir, '9.8.7')
    expect(files.sort()).toEqual([...HAND_KEPT_CONSTANTS, API_MANIFEST].sort())
    expect(read('packages/cli/src/version.ts')).not.toContain('9.8.7')
    expect(readFileSync(join(dir, 'packages/cli/src/version.ts'), 'utf8')).toMatch(
      /VERSION = '9\.8\.7'/
    )
    expect(readFileSync(join(dir, 'packages/create-tula/src/scaffold.ts'), 'utf8')).toMatch(
      /VERSION = '9\.8\.7'/
    )
    expect(readFileSync(join(dir, 'packages/mcp/src/server.ts'), 'utf8')).toMatch(
      /MCP_VERSION = '9\.8\.7'/
    )
    expect(JSON.parse(readFileSync(join(dir, API_MANIFEST), 'utf8')).version).toBe('9.8.7')
  })

  test('the example in a constant’s comment moves with it', () => {
    const dir = copy()
    syncHandKeptVersions(dir, '9.8.7')
    const text = readFileSync(join(dir, 'packages/cli/src/version.ts'), 'utf8')
    expect(text).toContain("'tula-cli/9.8.7'")
  })

  test('a version-like string elsewhere in a file is refused, not rewritten silently', () => {
    const dir = copy()
    const file = join(dir, 'packages/create-tula/src/scaffold.ts')
    const old = /VERSION = '([^']+)'/.exec(readFileSync(file, 'utf8'))?.[1] ?? ''
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nexport const RANGE = '^${old}'\n`)
    expect(() => syncHandKeptVersions(dir, '9.8.7')).toThrow('other than the constant')
  })

  test('a second run changes nothing', () => {
    const dir = copy()
    syncHandKeptVersions(dir, '9.8.7')
    expect(syncHandKeptVersions(dir, '9.8.7')).toEqual([])
  })

  test.each(['1.2', 'v1.2.3', '1.2.3-alpha.1', '1.2.3+b', ''])('refuses %p', (version) => {
    expect(() => syncHandKeptVersions(copy(), version)).toThrow('not a plain version')
  })

  test('refuses a file whose constant it cannot find, instead of leaving it behind', () => {
    const dir = copy()
    writeFileSync(join(dir, 'packages/mcp/src/server.ts'), 'export const OTHER = 1\n')
    expect(() => syncHandKeptVersions(dir, '9.8.7')).toThrow('no VERSION constant')
  })

  test('every place is one the version test reads', () => {
    const test = read('.claude/hooks/release-versions.test.ts')
    for (const file of HAND_KEPT_CONSTANTS) {
      expect(test).toContain(file.replace('packages/', '../../packages/').replace(/\.ts$/, ''))
    }
    expect(test).toContain("versionOf('apps/api')")
  })
})

describe('the pull request body', () => {
  const diff = [
    'diff --git a/packages/core/CHANGELOG.md b/packages/core/CHANGELOG.md',
    '--- a/packages/core/CHANGELOG.md',
    '+++ b/packages/core/CHANGELOG.md',
    '@@ -1,3 +1,22 @@',
    '+## 0.2.0',
    '+',
    '+### Minor Changes',
    '+',
    '+- f56f6b5: Replace the default theme.',
    '+',
    '+  Tokens keep their names.',
    '+',
    '+### Patch Changes',
    '+',
    '+- 1234567: Fix a refresh race.',
    '+',
    '+- Updated dependencies [f56f6b5]',
    '+  - @tula-tech/contract@0.2.0',
    '+',
    '+## 0.1.1',
    'diff --git a/packages/react/CHANGELOG.md b/packages/react/CHANGELOG.md',
    '+++ b/packages/react/CHANGELOG.md',
    '+## 0.2.0',
    '+',
    '+### Minor Changes',
    '+',
    '+- f56f6b5: Replace the default theme.',
    '+',
    '+  Tokens keep their names.',
    '+',
    '+### Patch Changes',
    '+',
    '+- @tula-tech/config@0.2.0',
  ].join('\n')

  test('lists each entry once, by kind, without hashes or dependency noise', () => {
    expect(changelogEntries(diff)).toEqual({
      Major: [],
      Minor: ['- Replace the default theme.\n\n  Tokens keep their names.'],
      Patch: ['- Fix a refresh race.'],
    })
  })

  test('reads only what the diff adds', () => {
    expect(changelogEntries('-### Minor Changes\n-- gone: removed\n context')).toEqual({
      Major: [],
      Minor: [],
      Patch: [],
    })
  })

  test('says what merging does, in the order it happens, and the version', () => {
    const body = releaseBody('0.2.0', changelogEntries(diff))
    expect(body).toContain('Version 0.2.0')
    expect(body).toContain('### Minor changes')
    expect(body).toContain('npm-publish')
    expect(body.indexOf('documentation site')).toBeLessThan(body.indexOf('npm-publish'))
    expect(body.indexOf('npm-publish')).toBeLessThan(body.indexOf('GitHub Packages'))
    expect(body.indexOf('GitHub Packages')).toBeLessThan(body.indexOf('back-merge'))
  })

  test('cuts a very long list instead of exceeding what GitHub accepts', () => {
    const long = { Major: [], Minor: [`- ${'x'.repeat(70_000)}`], Patch: [] }
    expect(releaseBody('0.2.0', long).length).toBeLessThan(65_536)
  })

  test('an empty release says so', () => {
    expect(releaseBody('0.2.0', { Major: [], Minor: [], Patch: [] })).toContain('carry no entries')
  })
})

describe('the workflows', () => {
  interface Step {
    name?: string
    uses?: string
    run?: string
    if?: string
    env?: Record<string, string>
  }
  interface Job {
    permissions?: Record<string, string>
    steps: Step[]
    env?: Record<string, string>
  }
  interface Workflow {
    on: Record<string, { branches?: string[] } | null>
    permissions: Record<string, string>
    concurrency: { group: string; 'cancel-in-progress': boolean | string }
    jobs: Record<string, Job>
  }

  const load = (file: string) => {
    const source = read(`.github/workflows/${file}`)
    return {
      source,
      workflow: Bun.YAML.parse(source) as Workflow,
      // Comments explain what is absent; only the lines that do something are checked.
      active: source
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n'),
    }
  }

  const release = load('release-pr.yml')
  const back = load('back-merge.yml')
  const ci = load('ci.yml')

  describe.each([
    ['release-pr.yml', release, 'develop', 'release-pr', 'release/next'],
    ['back-merge.yml', back, 'main', 'back-merge', 'back-merge/main'],
  ] as const)('%s', (_file, { workflow, active }, branch, group, head) => {
    test('runs for a push to its one branch, and for nothing else', () => {
      expect(Object.keys(workflow.on)).toEqual(['push'])
      expect(workflow.on.push?.branches).toEqual([branch])
    })

    test('has no permission by default; one job holds contents, pull-requests and actions: write', () => {
      expect(workflow.permissions).toEqual({})
      const jobs = Object.values(workflow.jobs)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.permissions).toEqual({
        contents: 'write',
        'pull-requests': 'write',
        actions: 'write',
      })
    })

    test('uses no secret, no personal access token and no stored credential', () => {
      expect(active).not.toMatch(/secrets\./)
      expect(active).not.toMatch(/\b(PAT|NPM_TOKEN|NODE_AUTH_TOKEN|GH_PAT|personal)\b/i)
      expect(active).not.toMatch(/token:\s/)
      expect(active).not.toContain('id-token')
      expect(active).not.toMatch(/npm publish|bun publish|changeset publish/)
      const tokens = [...active.matchAll(/(?:GH_TOKEN|GITHUB_TOKEN):\s*(.+)/g)].map((m) => m[1])
      expect(tokens.length).toBeGreaterThan(0)
      for (const token of tokens) {
        expect(token?.trim()).toBe('${{ github.token }}')
      }
    })

    test('runs one at a time and never cancels a run half-way', () => {
      expect(workflow.concurrency).toEqual({ group, 'cancel-in-progress': false })
    })

    test('writes only its own branch, never main or develop', () => {
      const pushes = active.split('\n').filter((line) => /\bpush --force\b/.test(line))
      expect(pushes).toHaveLength(1)
      expect(pushes[0]).toContain(`--force origin`)
      expect(pushes[0]).toContain(head)
      // The branch it writes is the last word of the command, and it is its own.
      expect(pushes[0]?.trim().endsWith(head)).toBe(true)
      for (const line of active.split('\n').filter((l) => l.includes('--delete-branch'))) {
        expect(line).toContain('gh pr close "$number"')
      }
    })

    test('dispatches ci.yml on its branch so that verify and e2e report on it', () => {
      const runs = Object.values(workflow.jobs)[0]?.steps.map((step) => step.run ?? '') ?? []
      expect(runs.filter((run) => run.includes('gh workflow run'))).toEqual([
        `gh workflow run ci.yml --ref ${head}`,
      ])
    })

    test('opens the pull request with the run’s own token, from its branch, without a title taken from the outside', () => {
      expect(active).toContain(`--head ${head}`)
      expect(active).not.toMatch(/\$\{\{\s*github\.event\.(head_commit|pull_request|issue)/)
    })
  })

  test('the release PR targets main, the back-merge targets develop', () => {
    expect(release.active).toMatch(/gh pr create --base main --head release\/next/)
    expect(back.active).toMatch(/gh pr create --base develop --head back-merge\/main/)
  })

  test('the release PR builds from develop only and installs without lifecycle scripts', () => {
    const steps = Object.values(release.workflow.jobs)[0]?.steps ?? []
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout'))
    expect(checkout).toMatchObject({ with: { ref: 'develop' } })
    // The root `prepare` installs Husky hooks; the bot's commit has none to run.
    expect(
      steps.some((step) => step.run === 'bun install --frozen-lockfile --ignore-scripts')
    ).toBe(true)
  })

  test('the release PR step order: plan, build, push, open, dispatch', () => {
    const runs = (Object.values(release.workflow.jobs)[0]?.steps ?? []).map((s) => s.run ?? '')
    const at = (needle: string) => runs.findIndex((run) => run.includes(needle))
    expect(at('release-pr.ts plan')).toBeGreaterThan(-1)
    expect(at('release-pr.ts plan')).toBeLessThan(at('release-pr.ts prepare'))
    expect(at('release-pr.ts prepare')).toBeLessThan(at('push --force'))
    expect(at('push --force')).toBeLessThan(at('gh pr create'))
    expect(at('gh pr create')).toBeLessThan(at('gh workflow run'))
  })

  test('every checkout leaves no token in the config; the push passes it for that one command', () => {
    for (const { workflow, active } of [release, back]) {
      const checkouts = Object.values(workflow.jobs)[0]?.steps.filter((step) =>
        step.uses?.startsWith('actions/checkout')
      )
      expect(checkouts).toHaveLength(1)
      expect(checkouts?.[0]).toMatchObject({ with: { 'persist-credentials': false } })
      expect(active).toMatch(/git -c "http\.https:\/\/github\.com\/\.extraheader=[^"]*\$auth" push/)
      expect(active).not.toMatch(/remote set-url|credential\.helper/)
      // The base64 form is not the token, so the runner would not mask it by itself.
      expect(active).toMatch(/auth=\$\(.*\)\n\s*echo "::add-mask::\$auth"\n\s*git -c/)
    }
  })

  test('the back-merge brings back a merge commit’s worth: it is skipped when develop already has main', () => {
    expect(back.active).toContain('git merge-base --is-ancestor origin/main origin/develop')
    expect(back.active).toContain('git merge-tree --write-tree origin/develop origin/main')
    expect(back.source).toContain('MERGE COMMIT')
  })

  test('the back-merge’s head is never main itself (the repository deletes merged head branches)', () => {
    expect(back.active).not.toMatch(/--head main\b/)
    expect(back.active).toContain('origin/main:refs/heads/back-merge/main')
  })

  test('release.yml, docs-pages.yml and github-packages.yml still run on main and are not started by these', () => {
    for (const file of ['release.yml', 'github-packages.yml', 'docs-pages.yml']) {
      expect(load(file).workflow.on.push?.branches).toContain('main')
    }
    // The two that publish to a registry cannot be started by hand or by a dispatch.
    for (const file of ['release.yml', 'github-packages.yml']) {
      expect(Object.keys(load(file).workflow.on)).toEqual(['push'])
    }
  })

  describe('ci.yml, which the two dispatch', () => {
    test('accepts workflow_dispatch, beside the events it always ran for', () => {
      expect(Object.keys(ci.workflow.on).sort()).toEqual(
        ['pull_request', 'push', 'workflow_dispatch'].sort()
      )
    })

    test('still names the checks the ruleset requires', () => {
      expect(Object.keys(ci.workflow.jobs)).toEqual(expect.arrayContaining(['verify', 'e2e']))
    })

    test('a dispatch on a release or back-merge branch replaces the older one; main and develop are never cancelled', () => {
      const expression = String(ci.workflow.concurrency['cancel-in-progress'])
      expect(expression).toContain("github.event_name == 'workflow_dispatch'")
      expect(expression).toContain("github.ref != 'refs/heads/main'")
      expect(expression).toContain("github.ref != 'refs/heads/develop'")
    })

    test('writes no marker and saves no cache for a dispatch (only a push does)', () => {
      expect(ci.active).toMatch(/passed:[\s\S]*github\.event_name == 'push'/)
      expect(ci.active).toMatch(/Save the Turborepo cache[\s\S]*if: github\.event_name == 'push'/)
    })
  })

  test('nothing here touches the npm-publish environment or NPM_PUBLISH', () => {
    for (const { active } of [release, back]) {
      expect(active).not.toContain('npm-publish')
      expect(active).not.toContain('NPM_PUBLISH')
    }
    expect(existsSync(join(root, '.github/workflows/release.yml'))).toBe(true)
  })

  test('the docs say plainly that a merge to main publishes with no approval, and how to add a gate back', () => {
    const doc = read('docs/releasing.md').replace(/\s+/g, ' ')
    expect(doc).toContain('publishes to npm with no further approval')
    expect(doc).toContain('Adding a required reviewer')
    expect(doc).not.toMatch(/waits in the `npm-publish` environment for/)
    expect(doc).not.toContain('after you approve the run')
  })
})
