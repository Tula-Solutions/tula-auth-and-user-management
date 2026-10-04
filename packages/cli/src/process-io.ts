import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { CliIo } from './framework'

/**
 * The surroundings of a real run: the process's streams, environment and directory, a prompt
 * on the terminal, and the two ways a secret key can be read without being on the command
 * line (a file, standard input).
 *
 * @returns The io `main` runs with.
 *
 * @example
 * ```ts
 * await runCli(process.argv.slice(2), processIo(), COMMANDS)
 * ```
 */
export function processIo(): CliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: async (question) => {
      // The question goes to standard error, so `tula apply > plan.txt` still shows it.
      const reader = createInterface({ input: process.stdin, output: process.stderr })
      try {
        return await reader.question(question)
      } finally {
        reader.close()
      }
    },
    readStdin: async () => {
      let text = ''
      for await (const chunk of process.stdin) {
        text += String(chunk)
      }
      return text
    },
    readFile: (path) => readFile(isAbsolute(path) ? path : resolve(process.cwd(), path), 'utf8'),
  }
}
