import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')

function run(script: string, stdin: string, args: string[] = []) {
  const proc = Bun.spawnSync(['bash', join(root, script), ...args], {
    stdin: Buffer.from(stdin),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  })
  return { code: proc.exitCode, stderr: proc.stderr.toString() }
}

function protect(path: string) {
  return run('.claude/hooks/protect-files.sh', JSON.stringify({ tool_input: { file_path: path } }))
    .code
}

describe('protect-files.sh', () => {
  test.each([
    'packages/contract/openapi.json',
    'apps/api/src/routeTree.gen.ts',
    'apps/dashboard/src/components/ui/button.tsx',
    'bun.lock',
    '.env',
    '.env.production',
    'apps/api/.env',
    'apps/api/.env.local',
  ])('blocks %s', (path) => {
    expect(protect(join(root, path))).toBe(2)
  })

  test.each(['.env.example', 'apps/api/.env.example', 'apps/api/src/index.ts', 'AGENTS.md'])(
    'allows %s',
    (path) => {
      expect(protect(join(root, path))).toBe(0)
    }
  )

  test.each([`${root}/x/../bun.lock`, `${root}/packages/./contract/openapi.json`])(
    'normalizes %s before matching (F11)',
    (path) => {
      expect(protect(path)).toBe(2)
    }
  )
})

describe('.husky/commit-msg', () => {
  function commitMsg(subject: string) {
    const file = join(tmpdir(), `commit-msg-${crypto.randomUUID()}`)
    Bun.spawnSync(['bash', '-c', 'printf "%s\\n" "$1" > "$2"', '_', subject, file])
    return run('.husky/commit-msg', '', [file]).code
  }

  test.each([
    'feat(api): add sessions',
    'fix: handle reuse',
    'refactor!: drop v0 claims',
    "Merge branch 'feat/sessions' into develop",
    'Merge pull request #12 from Tula-Solutions/feat/sessions',
    'Revert "feat: add sessions"',
    'fixup! feat: add sessions',
    'squash! fix: handle reuse',
  ])('accepts %p (F4)', (subject) => {
    expect(commitMsg(subject)).toBe(0)
  })

  test.each(['added stuff', 'Feat: capitalized type', 'feature: wrong type'])(
    'rejects %p',
    (subject) => {
      expect(commitMsg(subject)).toBe(1)
    }
  )
})

describe('workspace packages', () => {
  // Bun reads bunfig.toml only from the test cwd, and turbo runs tests inside each package, so a
  // root-level coverageThreshold is silently ignored (F1).
  const dirs = ['apps', 'packages']
    .filter((group) => existsSync(join(root, group)))
    .flatMap((group) =>
      readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(group, entry.name))
    )

  test('at least one workspace package exists', () => {
    expect(dirs.length).toBeGreaterThan(0)
  })

  test.each(dirs)('%s enforces its own coverage threshold if it has tests', async (dir) => {
    const pkg = await Bun.file(join(root, dir, 'package.json')).json()
    if (!pkg.scripts?.['test:coverage']) {
      return
    }
    const bunfigPath = join(root, dir, 'bunfig.toml')
    if (!existsSync(bunfigPath)) {
      throw new Error(`${dir} has a test:coverage script but no bunfig.toml with coverageThreshold`)
    }
    expect(await Bun.file(bunfigPath).text()).toMatch(/coverageThreshold\s*=/)
  })
})

describe('protect-files.sh edge paths (F14)', () => {
  test.each(['bun.lock', 'packages/contract/openapi.json', './.env'])(
    'resolves relative path %p against the project root and blocks it',
    (path) => {
      expect(protect(path)).toBe(2)
    }
  )

  test.each(['/', '.', `${root}/../../..`])('does not crash on %p', (path) => {
    expect(protect(path)).toBe(0)
  })
})

describe('settings.json .env read rules (F13)', () => {
  // Minimal glob matcher for Claude Code's gitignore-style `Read(...)` patterns.
  function matches(pattern: string, path: string) {
    const body = pattern.replace(/^Read\(\.\/(.*)\)$/, '$1')
    const regex = body
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('**/', '<GLOBSTAR>')
      .replace(/\*/g, '[^/]*')
      .replaceAll('<GLOBSTAR>', '(?:.*/)?')
    return new RegExp(`^${regex}$`).test(path)
  }

  async function denied(path: string) {
    const settings = await Bun.file(join(root, '.claude/settings.json')).json()
    return (settings.permissions.deny as string[])
      .filter((rule) => rule.startsWith('Read('))
      .some((rule) => matches(rule, path))
  }

  test.each([
    '.env',
    '.env.local',
    '.env.production',
    '.env.staging',
    '.env.development',
    '.env.test',
    '.env.dev',
    '.env.prod',
    '.env.qa',
    '.env.ci',
    '.env.production.local',
    'apps/api/.env',
    'apps/api/.env.production',
    'apps/api/.env.prod',
  ])('denies reading %s', async (path) => {
    expect(await denied(path)).toBe(true)
  })

  test.each(['.env.example', 'apps/api/.env.example'])('leaves %s readable', async (path) => {
    expect(await denied(path)).toBe(false)
  })
})
