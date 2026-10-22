import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = join(import.meta.dir, 'build.ts')

/** Runs the build script against a throwaway repository, writing to a throwaway dist. */
function build(repo: string, out: string) {
  return Bun.spawnSync(['bun', 'run', SCRIPT], {
    env: { ...process.env, DOCS_REPO_ROOT: repo, DOCS_OUT_DIR: out },
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
})
