import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from './version'

// The executable itself, as a child process. Every spawn has a timeout: `Bun.spawnSync` blocks
// the thread the test runner's own timeout runs on, so a child that never exits would hang the
// whole run instead of failing one test.
const BIN = join(import.meta.dir, 'bin.ts')
const TIMEOUT_MS = 20_000
const SECRET_KEY = 'tula_sk_dev_binspawn0000000000000000000000000000'

function tula(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}
) {
  const child = Bun.spawnSync(['bun', BIN, ...args], {
    timeout: TIMEOUT_MS,
    cwd: options.cwd,
    // Nothing of the developer's own environment: a real TULA_SECRET_KEY must not leak in.
    env: { PATH: process.env.PATH ?? '', NO_COLOR: '1', ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

describe('the tula executable', () => {
  test('starts with a Bun shebang', async () => {
    expect((await Bun.file(BIN).text()).startsWith('#!/usr/bin/env bun\n')).toBe(true)
  })

  test('--version exits 0 with the version', () => {
    expect(tula(['--version'])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' })
  })

  test('no command exits 1 with the usage', () => {
    const run = tula([])
    expect(run.code).toBe(1)
    expect(run.stdout).toContain('Usage: tula <command> [options]')
  })

  test('a key on the command line is refused and not echoed', () => {
    const run = tula(['diff', '--secret-key', SECRET_KEY])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('There is no --secret-key option')
    expect(run.stdout + run.stderr).not.toContain(SECRET_KEY)
  })

  test('reads the key from a file and from standard input, then fails to reach the API with exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tula-bin-test-'))
    try {
      writeFileSync(join(dir, 'tula.config.ts'), 'export default { environments: { dev: {} } }\n')
      writeFileSync(join(dir, 'key.txt'), `${SECRET_KEY}\n`)
      chmodSync(join(dir, 'key.txt'), 0o600)
      // A port nothing listens on: the run gets as far as its first request.
      const env = { TULA_API_URL: 'http://127.0.0.1:9' }
      for (const run of [
        tula(['diff', '--secret-key-file', 'key.txt'], { env, cwd: dir }),
        tula(['diff', '--secret-key-file', '-'], { env, cwd: dir, stdin: `${SECRET_KEY}\n` }),
      ]) {
        expect(run.code).toBe(1)
        expect(run.stderr).toContain('network.failed')
        expect(run.stdout + run.stderr).not.toContain(SECRET_KEY)
      }
      if (process.platform !== 'win32') {
        // A key file other users can read is used, with a warning that shows none of it.
        expect(
          tula(['diff', '--secret-key-file', 'key.txt'], { env, cwd: dir }).stderr
        ).not.toContain('warning:')
        chmodSync(join(dir, 'key.txt'), 0o644)
        const open = tula(['diff', '--secret-key-file', 'key.txt'], { env, cwd: dir })
        expect(open.stderr).toContain('readable by other users (mode 0644)')
        expect(open.stderr).toContain('network.failed')
        expect(open.stdout + open.stderr).not.toContain(SECRET_KEY)
      }
      // Standard input carries the key, so it cannot confirm: apply needs --yes.
      const piped = tula(['apply', '--secret-key-file', '-'], { env, cwd: dir, stdin: SECRET_KEY })
      expect(piped.code).toBe(1)
      expect(piped.stderr).toContain('pass --yes as well')
      // Not at a terminal and no --yes: refused before anything, never a hang.
      const missing = tula(['apply'], { env, cwd: dir })
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain('No secret key')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
