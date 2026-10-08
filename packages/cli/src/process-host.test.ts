import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
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

  describe('symbolic links (not on Windows, where making one needs a privilege)', () => {
    const posix = process.platform !== 'win32'

    /** A file elsewhere that a planted link points at: it must never be written or re-moded. */
    async function victim(): Promise<string> {
      const path = join(dir, 'victim')
      await writeFile(path, 'theirs', { mode: 0o644 })
      await chmod(path, 0o644)
      return path
    }

    async function untouched(path: string): Promise<void> {
      expect(await readFile(path, 'utf8')).toBe('theirs')
      expect((await stat(path)).mode & 0o777).toBe(0o644)
    }

    test.if(posix)(
      'a link planted at the old, guessable temporary name is not written through',
      async () => {
        const target = await victim()
        const path = join(dir, '.env.local')
        // What the write used to create: anyone who could write to the directory knew the name.
        await symlink(target, `${path}.${process.pid}.tmp`)
        await host.writeSecretFile(path, 'TULA_SECRET_KEY=tula_sk_dev_x')
        await untouched(target)
        expect(await host.readFile(path)).toBe('TULA_SECRET_KEY=tula_sk_dev_x')
        expect((await lstat(path)).isSymbolicLink()).toBe(false)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
    )

    test.if(posix)(
      'the temporary file has a name nobody can guess, and none is left behind',
      async () => {
        const path = join(dir, '.env.local')
        await host.writeSecretFile(path, 'one')
        await host.writeSecretFile(path, 'two')
        expect(await readdir(dir)).toEqual(['.env.local'])
      }
    )

    test.if(posix)(
      'a link at the file itself is refused: its target is neither written nor re-moded',
      async () => {
        const target = await victim()
        const path = join(dir, '.env.local')
        await symlink(target, path)
        const error = await host.writeSecretFile(path, 'TULA_SECRET_KEY=tula_sk_dev_x').then(
          () => undefined,
          (thrown: Error) => thrown
        )
        expect(error?.name).toBe('UsageError')
        expect(error?.message).toContain('symbolic link')
        expect(error?.message).not.toContain('tula_sk_dev_x')
        await untouched(target)
        expect((await lstat(path)).isSymbolicLink()).toBe(true)
        expect((await readdir(dir)).sort()).toEqual(['.env.local', 'victim'])
      }
    )

    test.if(posix)(
      'restrictFile refuses a link instead of closing the mode of what it points at',
      async () => {
        const target = await victim()
        const path = join(dir, '.env.local')
        await symlink(target, path)
        const error = await host.restrictFile(path).then(
          () => undefined,
          (thrown: Error) => thrown
        )
        expect(error?.name).toBe('UsageError')
        await untouched(target)
      }
    )

    test.if(posix)(
      'a link that points nowhere is refused too, and nothing is created at its target',
      async () => {
        const path = join(dir, '.env.local')
        await symlink(join(dir, 'not-there'), path)
        await expect(host.writeSecretFile(path, 'x')).rejects.toThrow('symbolic link')
        await expect(host.restrictFile(path)).rejects.toThrow('symbolic link')
        expect(await readdir(dir)).toEqual(['.env.local'])
      }
    )
  })

  describe('something that is not a regular file (review E4; no named pipes on Windows)', () => {
    const posix = process.platform !== 'win32'

    /** A named pipe at `.env.local`: opening one for reading waits for a writer, for ever. */
    function pipe(): string {
      const path = join(dir, '.env.local')
      const made = Bun.spawnSync(['mkfifo', path], { timeout: 5_000 })
      expect(made.exitCode).toBe(0)
      return path
    }

    /**
     * The outcome of `work`, or `'hung'` after a second. The pipe's other end is then opened
     * so that an open still waiting on it returns and the test leaves nothing behind.
     */
    async function bounded(path: string, work: Promise<unknown>): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = work.then(
        () => 'done',
        (thrown: Error) => thrown
      )
      try {
        return await Promise.race([
          outcome,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('hung'), 1_000)
          }),
        ])
      } finally {
        clearTimeout(timer)
        // Without a reader waiting this fails at once (ENXIO), which is the good case.
        const writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK).catch(
          () => undefined
        )
        await writer?.close()
        await outcome
      }
    }

    test.if(posix)('restrictFile refuses a named pipe instead of waiting on it', async () => {
      const path = pipe()
      const error = (await bounded(path, host.restrictFile(path))) as Error
      expect(error).not.toBe('hung')
      expect(error.name).toBe('UsageError')
      expect(error.message).toContain('.env.local is not a regular file')
      expect(error.message).not.toContain(dir)
    })

    test.if(posix)('writeSecretFile refuses a named pipe and leaves it as it was', async () => {
      const path = pipe()
      const error = (await bounded(
        path,
        host.writeSecretFile(path, 'TULA_SECRET_KEY=tula_sk_dev_x')
      )) as Error
      expect(error.name).toBe('UsageError')
      expect(error.message).toContain('not a regular file')
      expect(error.message).not.toContain('tula_sk_dev_x')
      expect((await lstat(path)).isFIFO()).toBe(true)
      expect(await readdir(dir)).toEqual(['.env.local'])
    })

    test.if(posix)('readFile refuses a named pipe at once, without opening it (F1)', async () => {
      const path = pipe()
      const started = Date.now()
      const error = (await bounded(path, host.readFile(path))) as Error
      expect(error).not.toBe('hung')
      expect(Date.now() - started).toBeLessThan(500)
      expect(error.name).toBe('UsageError')
      expect(error.message).toContain('.env.local is not a regular file')
      expect(error.message).not.toContain(dir)
    })

    test.if(posix)(
      'readFile refuses a link to a named pipe: nothing is read through a link',
      async () => {
        const target = pipe()
        const path = join(dir, 'link')
        await symlink(target, path)
        const error = (await bounded(target, host.readFile(path))) as Error
        expect(error).not.toBe('hung')
        expect(error.name).toBe('UsageError')
        expect(error.message).toContain('link is a symbolic link')
      }
    )

    test('readFile refuses a directory in fixed words, not with the system’s error', async () => {
      const path = join(dir, '.env.local')
      await mkdir(path)
      const error = await host.readFile(path).then(
        () => undefined,
        (thrown: Error) => thrown
      )
      expect(error?.name).toBe('UsageError')
      expect(error?.message).toContain('.env.local is not a regular file')
      expect(error?.message).not.toContain('EISDIR')
    })

    test.if(posix)(
      'createSecretFile refuses a named pipe, a directory and a link, and leaves each',
      async () => {
        const fifo = pipe()
        const error = (await bounded(fifo, host.createSecretFile(fifo, 'x'))) as Error
        expect(error.name).toBe('UsageError')
        expect(error.message).toContain('.env.local already exists')
        expect((await lstat(fifo)).isFIFO()).toBe(true)
        await mkdir(join(dir, 'folder'))
        await expect(host.createSecretFile(join(dir, 'folder'), 'x')).rejects.toThrow(
          'already exists'
        )
        await symlink(join(dir, 'nowhere'), join(dir, 'dangling'))
        await expect(host.createSecretFile(join(dir, 'dangling'), 'x')).rejects.toThrow(
          'already exists'
        )
        expect((await readdir(dir)).sort()).toEqual(['.env.local', 'dangling', 'folder'])
      }
    )

    test('a directory at the path is refused too, by both', async () => {
      const path = join(dir, '.env.local')
      await mkdir(path)
      await expect(host.restrictFile(path)).rejects.toThrow('not a regular file')
      await expect(host.writeSecretFile(path, 'x')).rejects.toThrow('not a regular file')
      expect(await readdir(dir)).toEqual(['.env.local'])
    })
  })

  describe('a file that must be new (F2)', () => {
    test('createSecretFile makes the file, readable by its owner only', async () => {
      const path = join(dir, 'secrets.json')
      await host.createSecretFile(path, '[]\n')
      expect(await readFile(path, 'utf8')).toBe('[]\n')
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
    })

    test('createSecretFile never replaces a file that is there, whatever it holds', async () => {
      const path = join(dir, 'secrets.json')
      for (const content of ['from an earlier run', '[]\n', '']) {
        await writeFile(path, content)
        const error = await host.createSecretFile(path, 'new').then(
          () => undefined,
          (thrown: Error) => thrown
        )
        expect(error?.name).toBe('UsageError')
        expect(error?.message).toContain('secrets.json already exists')
        expect(error?.message).not.toContain(dir)
        expect(await readFile(path, 'utf8')).toBe(content)
      }
      expect(await readdir(dir)).toEqual(['secrets.json'])
    })

    test('two claims of one path at once: exactly one wins', async () => {
      const path = join(dir, 'secrets.json')
      const outcomes = await Promise.allSettled([
        host.createSecretFile(path, 'one'),
        host.createSecretFile(path, 'two'),
      ])
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    })

    test('removeFile removes a file, says whether it did, and never follows a link', async () => {
      const path = join(dir, 'secrets.json')
      expect(await host.removeFile(path)).toBe(false)
      await writeFile(path, 'x')
      expect(await host.removeFile(path)).toBe(true)
      if (process.platform !== 'win32') {
        await writeFile(join(dir, 'kept'), 'kept')
        await symlink(join(dir, 'kept'), path)
        expect(await host.removeFile(path)).toBe(true)
        expect(await readFile(join(dir, 'kept'), 'utf8')).toBe('kept')
      }
    })
  })

  test('sleep waits', async () => {
    const started = Date.now()
    await host.sleep(20)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })
})
