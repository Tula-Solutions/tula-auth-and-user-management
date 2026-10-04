import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import type { Host, RunResult } from './host'

/**
 * The real {@link Host}: child processes through `Bun.spawn`, files through the file system.
 *
 * Every process is killed when it runs past its timeout, and when the CLI is interrupted
 * (Ctrl-C): the run then rejects with an error whose `code` is `ABORT`. A command is an
 * executable and its arguments, never a shell line, so nothing in an argument is interpreted.
 *
 * @param env - The environment children inherit.
 * @returns The host.
 *
 * @example
 * ```ts
 * const host = createProcessHost(process.env)
 * const { code } = await host.run(['docker', 'compose', 'version'], { timeoutMs: 30_000 })
 * ```
 */
export function createProcessHost(env: Readonly<Record<string, string | undefined>>): Host {
  return {
    async run(command, options): Promise<RunResult> {
      const child = Bun.spawn([...command], {
        cwd: options.cwd,
        env: { ...env, ...options.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: options.stderr === 'inherit' ? 'inherit' : 'pipe',
      })
      let timedOut = false
      let interrupted = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, options.timeoutMs)
      const onInterrupt = () => {
        interrupted = true
        child.kill('SIGINT')
      }
      process.once('SIGINT', onInterrupt)
      try {
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          child.stderr ? new Response(child.stderr).text() : '',
          child.exited,
        ])
        if (interrupted) {
          throw Object.assign(new Error('interrupted'), { code: 'ABORT' })
        }
        return { code: timedOut ? null : child.exitCode, stdout, stderr, timedOut }
      } finally {
        clearTimeout(timer)
        process.off('SIGINT', onInterrupt)
      }
    },
    async readFile(path) {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
          return null
        }
        throw error
      }
    },
    async writeSecretFile(path, text) {
      // Written beside the file and renamed over it: a reader never sees half a file, and the
      // file is never, even for a moment, readable by anyone but its owner.
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, path)
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
