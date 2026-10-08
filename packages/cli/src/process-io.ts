import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import { UsageError } from './args'
import type { CliIo } from './framework'
import { createProcessHost } from './process-host'

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
  stat: (path: string) => Promise<{ mode: number }>
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
  let warned = false
  /**
   * Say, once, that the key file can be read by other users of the machine. The run goes on:
   * the key has been exposed already, and refusing would not take that back. Skipped where
   * there are no POSIX modes (Windows reports 0666 for every file).
   */
  async function checkMode(path: string): Promise<void> {
    if (warned || parts.platform === 'win32') {
      return
    }
    // A file that cannot be looked at cannot be read either: the read reports that.
    const mode = await parts.stat(path).then(
      (stats) => stats.mode,
      () => undefined
    )
    if (mode !== undefined && (mode & 0o077) !== 0) {
      warned = true
      parts.stderr.write(
        `warning: the file given as --secret-key-file is readable by other users (mode ${(mode & 0o777).toString(8).padStart(4, '0')}). Restrict it: chmod 600 <file>.\n`
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
      }
      return text
    },
    readFile: async (path) => {
      const absolute = isAbsolute(path) ? path : resolve(parts.cwd, path)
      await checkMode(absolute)
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
