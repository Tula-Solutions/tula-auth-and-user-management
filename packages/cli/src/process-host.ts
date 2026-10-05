import { constants } from 'node:fs'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { basename } from 'node:path'
import { UsageError } from './args'
import type { Host, RunResult } from './host'

/** What is said when a file the CLI would write or re-mode turns out to be a symbolic link. */
function linkRefusal(path: string): UsageError {
  return new UsageError(
    `${basename(path)} is a symbolic link. \`tula\` does not write a secret or change a mode through a link: replace it with a regular file.`
  )
}

/** What is said when the path holds a named pipe, a directory, a device or a socket. */
function kindRefusal(path: string): UsageError {
  return new UsageError(
    `${basename(path)} is not a regular file. \`tula\` keeps its keys in a regular file only: move it away and run the command again.`
  )
}

/**
 * Refuse anything at `path` that is not a regular file. Writing or changing a mode through a
 * symbolic link would act on a file somebody else chose, and opening a named pipe for reading
 * waits for a writer that never comes. Asked with `lstat`, before anything is opened.
 *
 * @param path - The file about to be written or re-moded.
 * @returns Whether anything is at `path`.
 * @throws UsageError when `path` is a symbolic link (dangling or not) or any other kind of
 *   thing that is not a regular file.
 */
async function refuseIrregular(path: string): Promise<boolean> {
  try {
    const found = await lstat(path)
    if (found.isSymbolicLink()) {
      throw linkRefusal(path)
    }
    if (!found.isFile()) {
      throw kindRefusal(path)
    }
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/** A name for a temporary file that nobody who can write to the directory can predict. */
function unguessable(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

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
      await refuseIrregular(path)
      // Written beside the file and renamed over it: a reader never sees half a file, and the
      // file is never, even for a moment, readable by anyone but its owner. The temporary
      // file is created exclusively (`wx` fails on any existing name, and never follows a
      // link) under a random name: a predictable one could be planted as a link to a file
      // the secret would then be written into.
      const temporary = `${path}.${unguessable()}.tmp`
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(text)
          // The mode given to `open` is cut by the umask only towards fewer bits; set again
          // in case the platform ignored it.
          await file.chmod(0o600)
        } finally {
          await file.close()
        }
        // Renaming replaces whatever is at `path` itself, never what a link there points at.
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    },
    async restrictFile(path) {
      if (!(await refuseIrregular(path))) {
        return false
      }
      // Opened without following a link and changed through the handle, so that what was
      // checked is what is changed even if the name is swapped in between.
      let file: Awaited<ReturnType<typeof open>>
      try {
        // `O_NONBLOCK`: should a named pipe be swapped in after the check above, the open
        // returns at once instead of waiting, and the check below refuses it.
        file = await open(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
        )
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'ENOENT') {
          return false
        }
        if (code === 'ELOOP') {
          throw linkRefusal(path)
        }
        throw error
      }
      try {
        const opened = await file.stat()
        if (!opened.isFile()) {
          throw kindRefusal(path)
        }
        if ((opened.mode & 0o077) === 0) {
          return false
        }
        await file.chmod(0o600)
        // Where modes do not exist (Windows) the bits never change: nothing was closed.
        return ((await file.stat()).mode & 0o077) === 0
      } finally {
        await file.close()
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}
