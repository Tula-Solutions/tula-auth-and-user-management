import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessHost } from './process-host'

const host = createProcessHost({ PATH: process.env.PATH ?? '', FROM_PARENT: 'parent' })
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tula-host-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('createProcessHost', () => {
  test('runs a command and captures its output and exit code', async () => {
    const result = await host.run(
      [
        'bun',
        '-e',
        'console.log(process.env.FROM_PARENT, process.env.EXTRA); console.error("err"); process.exit(3)',
      ],
      { timeoutMs: 20_000, env: { EXTRA: 'extra' } }
    )
    expect(result).toEqual({ code: 3, stdout: 'parent extra\n', stderr: 'err\n', timedOut: false })
  })

  test('an argument is never interpreted by a shell', async () => {
    const result = await host.run(
      ['bun', '-e', 'console.log(process.argv.at(-1))', '$(echo no); `no`'],
      {
        timeoutMs: 20_000,
      }
    )
    expect(result.stdout).toContain('$(echo no); `no`')
  })

  test('kills a process that runs past its timeout', async () => {
    const started = Date.now()
    const result = await host.run(['bun', '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('a missing executable rejects with ENOENT', async () => {
    const error = await host.run(['tula-no-such-executable-xyz'], { timeoutMs: 5_000 }).then(
      () => undefined,
      (thrown: { code?: string }) => thrown
    )
    expect(error?.code).toBe('ENOENT')
  })

  test('runs in the given directory', async () => {
    const result = await host.run(['bun', '-e', 'console.log(process.cwd())'], {
      cwd: dir,
      timeoutMs: 20_000,
    })
    expect(result.stdout.trim().endsWith(dir.split('/').at(-1) as string)).toBe(true)
  })

  test('an interrupt (Ctrl-C) stops the child and rejects with ABORT', async () => {
    // The handlers are attached at once: the rejection must never be seen as unhandled.
    const running = host
      .run(['bun', '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 20_000 })
      .then(
        () => undefined,
        (thrown: { code?: string }) => thrown
      )
    await new Promise((resolve) => setTimeout(resolve, 300))
    process.emit('SIGINT')
    const error = await running
    expect(error?.code).toBe('ABORT')
  })

  test('reads a file, and answers null for one that does not exist', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello')
    expect(await host.readFile(join(dir, 'a.txt'))).toBe('hello')
    expect(await host.readFile(join(dir, 'missing.txt'))).toBeNull()
    await expect(host.readFile(dir)).rejects.toThrow()
  })

  test('writes a file readable by its owner only, replacing what was there', async () => {
    const path = join(dir, '.env.local')
    await writeFile(path, 'old', { mode: 0o644 })
    await host.writeSecretFile(path, 'new')
    expect(await host.readFile(path)).toBe('new')
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  test('restrictFile closes a file others can read, and says whether it had to', async () => {
    const host = createProcessHost({})
    const path = join(dir, '.env.local')
    await writeFile(path, 'A=1', { mode: 0o644 })
    await chmod(path, 0o644)
    expect(await host.restrictFile(path)).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await host.restrictFile(path)).toBe(false)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await host.restrictFile(join(dir, 'missing'))).toBe(false)
  })

  test('sleep waits', async () => {
    const started = Date.now()
    await host.sleep(20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })
})
