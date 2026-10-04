import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `tula mcp` is the only command that needs the MCP server and its SDK. Every other run of
// `tula` must not pay for loading them. The executable is started as a child process with a
// preload that records every module the process loaded; each spawn has a timeout, so a child
// that never exits fails one test instead of hanging the run.
const BIN = join(import.meta.dir, 'bin.ts')
const RECORDER = join(import.meta.dir, 'testing', 'loaded-modules.ts')
const TIMEOUT_MS = 15_000

/** `@tula/mcp` (from the workspace or from `node_modules`) and the MCP SDK. */
const MCP_MODULE = /[\\/](?:packages[\\/]mcp|@tula[\\/]mcp|@modelcontextprotocol)[\\/]/

let dir: string
let runs = 0

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tula-lazy-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tula(args: string[]): { code: number | null; modules: string[]; stdout: string } {
  runs += 1
  const record = join(dir, `modules-${runs}.json`)
  const child = Bun.spawnSync(['bun', '--preload', RECORDER, BIN, ...args], {
    timeout: TIMEOUT_MS,
    cwd: dir,
    // Nothing of the developer's own environment: a real TULA_SECRET_KEY must not leak in.
    env: { PATH: process.env.PATH ?? '', NO_COLOR: '1', TULA_TEST_LOADED_MODULES: record },
    // Closed at once: `tula mcp` serves until its input ends, so it ends straight away.
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: child.exitCode,
    modules: JSON.parse(readFileSync(record, 'utf8')) as string[],
    stdout: child.stdout.toString(),
  }
}

describe('the MCP server is loaded only by `tula mcp`', () => {
  test.each([
    ['--version', ['--version'], 0],
    ['--help', ['--help'], 0],
    ['diff --help', ['diff', '--help'], 0],
    ['doctor --help', ['doctor', '--help'], 0],
    // The command's name, options and help are plain data: describing it loads nothing.
    ['mcp --help', ['mcp', '--help'], 0],
    ['a command that fails (no config file)', ['diff'], 1],
  ])('tula %s loads neither @tula/mcp nor the MCP SDK', (_name, args, code) => {
    const run = tula(args)
    expect(run.code).toBe(code)
    // The recorder saw the run: the CLI's own modules are there.
    expect(run.modules.some((module) => module.endsWith(join('cli', 'src', 'framework.ts')))).toBe(
      true
    )
    expect(run.modules.filter((module) => MCP_MODULE.test(module))).toEqual([])
  })

  test('tula mcp does load them: the recorder would see it', () => {
    const run = tula(['mcp'])
    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
    const loaded = run.modules.filter((module) => MCP_MODULE.test(module))
    expect(loaded.some((module) => module.includes('@modelcontextprotocol'))).toBe(true)
    expect(loaded.some((module) => /[\\/]mcp[\\/]src[\\/]server\.ts$/.test(module))).toBe(true)
  })

  test('the built executable keeps the boundary: @tula/mcp is only ever a dynamic import', async () => {
    // What bunup is configured to do (packages stay imports): the output must reach
    // @tula/mcp through `import()` alone, or the published `tula` would load it on every run.
    const built = await Bun.build({
      entrypoints: [BIN, join(import.meta.dir, 'index.ts')],
      target: 'bun',
      format: 'esm',
      packages: 'external',
      throw: true,
    })
    const code = (await Promise.all(built.outputs.map((output) => output.text()))).join('\n')
    expect(code).toMatch(/import\(\s*["']@tula\/mcp["']\s*\)/)
    expect(code).not.toMatch(/from\s*["']@tula\/mcp["']/)
    expect(code).not.toMatch(/import\s*["']@tula\/mcp["']/)
    expect(code).not.toContain('@modelcontextprotocol')
  })
})
