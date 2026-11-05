import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import { UsageError } from './args'
import { printable } from './doctor'
import type { CliIo } from './framework'
import { createProcessHost, MAX_INPUT_BYTES } from './process-host'

/**
 * What {@link createProcessIo} builds a run's surroundings from: the process's streams,
 * environment, directory and platform, and how a file is read and looked at. A test passes
 * its own streams and file modes.
 *
 * @example
 * ```ts
 * const parts: ProcessParts = { stdin, stdout, stderr, env: {}, cwd: '/work', platform: 'linux', readFile, stat }
 * ```
 */
export interface ProcessParts {
  /** Standard input. */
  stdin: NodeJS.ReadableStream & {
    isTTY?: boolean
    /** Present on a terminal: turns the terminal's own echo and line editing off. */
    setRawMode?: (raw: boolean) => unknown
  }
  /** Standard output. */
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  /** Standard error. */
  stderr: NodeJS.WritableStream & { isTTY?: boolean }
  /** The environment. */
  env: Readonly<Record<string, string | undefined>>
  /** The working directory. */
  cwd: string
  /** `process.platform`. */
  platform: string
  /** Read a file as text. */
  readFile: (path: string) => Promise<string>
  /** A file's mode bits. */
  stat: (path: string) => Promise<{ mode: number; size?: number }>
  /** Call `stop` when the process is asked to end. Returns how to stop listening. */
  onTerminate?: (stop: () => void) => () => void
}

/**
 * Ask a question on standard error and read the answer from the terminal without showing it:
 * the terminal is put in raw mode, so nothing typed is echoed, and restored whatever happens.
 * Enter (or Ctrl-D) ends the answer, Backspace removes a character, Ctrl-C cancels.
 */
function readHidden(parts: ProcessParts, question: string): Promise<string> {
  const { stdin, stderr } = parts
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (settle: () => void) => {
      stdin.off('data', onData)
      stdin.setRawMode?.(false)
      stdin.pause()
      stderr.write('\n')
      settle()
    }
    function onData(chunk: unknown) {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          finish(() => resolve(value))
          return
        }
        if (character === '\u0003') {
          finish(() => reject(new UsageError('Cancelled.')))
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('')
        } else if (character >= ' ') {
          value += character
        }
      }
    }
    stderr.write(question)
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

/**
 * The surroundings of a run, from the given parts.
 *
 * @param parts - The streams, environment, directory, platform and file access.
 * @returns The io `runCli` runs with.
 *
 * @example
 * ```ts
 * await runCli(argv, createProcessIo(parts), COMMANDS)
 * ```
 */
export function createProcessIo(parts: ProcessParts): CliIo {
  const warned = new Set<string>()
  /**
   * Look at a file before it is read: say, once per file, that other users of the machine can
   * read it, and refuse one larger than `MAX_INPUT_BYTES` (a key, a config or a secrets file is
   * small; a device or a huge file would fill memory). The run goes on after the warning: the
   * contents have been exposed already, and refusing would not take that back. The mode check
   * is skipped where there are no POSIX modes (Windows reports 0666 for every file).
   */
  async function checkFile(path: string): Promise<void> {
    // A file that cannot be looked at cannot be read either: the read reports that.
    const stats = await parts.stat(path).then(
      (found) => found,
      () => undefined
    )
    if (stats?.size !== undefined && stats.size > MAX_INPUT_BYTES) {
      throw new UsageError(`The file is larger than ${MAX_INPUT_BYTES} bytes.`)
    }
    if (warned.has(path) || parts.platform === 'win32') {
      return
    }
    const mode = stats?.mode
    if (mode !== undefined && (mode & 0o077) !== 0) {
      warned.add(path)
      parts.stderr.write(
        `warning: ${printable(path, 200)} is readable by other users (mode ${(mode & 0o777).toString(8).padStart(4, '0')}). Restrict it: chmod 600 <file>.\n`
      )
    }
  }
  return {
    stdout: parts.stdout,
    stderr: parts.stderr,
    env: parts.env,
    cwd: parts.cwd,
    // The question is written to standard error, so that is the stream a person must be
    // watching: `tula apply > plan.txt` can still ask.
    isTTY: parts.stdin.isTTY === true && parts.stderr.isTTY === true,
    stdinIsTTY: parts.stdin.isTTY === true,
    prompt: async (question) => {
      // The question goes to standard error, so `tula apply > plan.txt` still shows it.
      const reader = createInterface({ input: parts.stdin, output: parts.stderr })
      try {
        return await reader.question(question)
      } finally {
        reader.close()
      }
    },
    now: () => new Date(),
    host: createProcessHost(parts.env),
    serve: {
      input: parts.stdin as Readable,
      output: parts.stdout as Writable,
      ...(parts.onTerminate ? { onTerminate: parts.onTerminate } : {}),
    },
    // Only on a terminal that can stop echoing: anywhere else the secret is read from a pipe.
    ...(parts.stdin.isTTY === true && typeof parts.stdin.setRawMode === 'function'
      ? { promptSecret: (question: string) => readHidden(parts, question) }
      : {}),
    readStdin: async () => {
      let text = ''
      for await (const chunk of parts.stdin) {
        text += String(chunk)
        if (text.length > MAX_INPUT_BYTES) {
          throw new UsageError(`Standard input is larger than ${MAX_INPUT_BYTES} bytes.`)
        }
      }
      return text
    },
    readFile: async (path) => {
      const absolute = isAbsolute(path) ? path : resolve(parts.cwd, path)
      await checkFile(absolute)
      return parts.readFile(absolute)
    },
  }
}

/**
 * The surroundings of a real run: the process's streams, environment and directory, a prompt
 * on the terminal, and the two ways a secret key can be read without being on the command
 * line (a file, standard input). A key file that other users can read is warned about.
 *
 * @returns The io `main` runs with.
 *
 * @example
 * ```ts
 * await runCli(process.argv.slice(2), processIo(), COMMANDS)
 * ```
 */
export function processIo(): CliIo {
  return createProcessIo({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    readFile: (path) => readFile(path, 'utf8'),
    stat: (path) => stat(path),
    onTerminate: (stop) => {
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
      return () => {
        process.off('SIGTERM', stop)
        process.off('SIGINT', stop)
      }
    },
  })
}
