import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'build.ts')

/** Runs the build script against a throwaway repository, writing to a throwaway dist. */
function build(repo: string, out: string, args: string[] = [], base?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DOCS_REPO_ROOT: repo,
    DOCS_OUT_DIR: out,
  }
  delete env.DOCS_BASE
  if (base !== undefined) {
    env.DOCS_BASE = base
  }
  return Bun.spawnSync(['bun', 'run', SCRIPT, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    // A child that never exits would hang the whole run (AGENTS.md, "Testing").
    timeout: 60_000,
  })
}

describe('scripts/build.ts', () => {
  test('a document that cannot be rendered stops the build and leaves the previous dist alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-build-'))
    try {
      const repo = join(dir, 'repo')
      const out = join(dir, 'dist')
      mkdirSync(join(repo, 'docs'), { recursive: true })
      mkdirSync(out)
      writeFileSync(join(repo, 'docs/README.md'), '# Docs\n\n[Quickstart](quickstart.md)\n')
      writeFileSync(join(repo, 'docs/quickstart.md'), '# Quickstart\n\n[gone](missing-page.md)\n')
      writeFileSync(join(out, 'previous.txt'), 'the last good build')

      const result = build(repo, out)

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('docs/quickstart.md')
      expect(result.stderr.toString()).toContain('missing-page.md')
      // Vite's `emptyOutDir` has not run: the last build is still there.
      expect(readFileSync(join(out, 'previous.txt'), 'utf8')).toBe('the last good build')
      expect(existsSync(join(out, 'index.html'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // Each `bun` start can take a second on a slow runner, and Bun's default is five.
  }, 90_000)

  test('a base path that is not one stops the build before anything is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-build-'))
    try {
      const repo = join(dir, 'repo')
      const out = join(dir, 'dist')
      mkdirSync(join(repo, 'docs'), { recursive: true })
      mkdirSync(out)
      writeFileSync(join(repo, 'docs/README.md'), '# Docs\n')
      writeFileSync(join(out, 'previous.txt'), 'the last good build')

      const result = build(repo, out, [], '/tula-auth-and-user-management')

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.toString()).toContain('DOCS_BASE must start and end with "/"')
      expect(readFileSync(join(out, 'previous.txt'), 'utf8')).toBe('the last good build')
      expect(existsSync(join(out, 'index.html'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // One `bun` start, which can take a second or more on a slow runner.
  }, 60_000)

  // `--check` (what `verify` runs) renders under a sub-path even with no base set: at `/` an
  // address from the host's root looks right, and on GitHub Pages it is a 404. The address
  // check itself is `page-check.test.ts`'s; a link in the Markdown never reaches it, because the
  // resolver already reads `/x` as a file of the repository.
  test('the check renders under a sub-path when no base is set, and under the base when one is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docs-build-'))
    try {
      const repo = join(dir, 'repo')
      mkdirSync(join(repo, 'docs'), { recursive: true })
      writeFileSync(join(repo, 'docs/README.md'), '# Docs\n\n[Quickstart](quickstart.md)\n')
      writeFileSync(
        join(repo, 'docs/quickstart.md'),
        '# Quickstart\n\nSee [the index](README.md).\n'
      )

      const unset = build(repo, join(dir, 'dist'), ['--check'])
      expect(unset.stderr.toString()).toBe('')
      expect(unset.exitCode).toBe(0)
      expect(unset.stdout.toString()).toContain('render under /base-path-check/')

      const set = build(repo, join(dir, 'dist'), ['--check'], '/tula-auth-and-user-management/')
      expect(set.exitCode).toBe(0)
      expect(set.stdout.toString()).toContain('render under /tula-auth-and-user-management/')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // One `bun` start, which can take a second or more on a slow runner.
  }, 60_000)
})
