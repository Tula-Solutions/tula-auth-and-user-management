/**
 * One finished child process.
 *
 * @example
 * ```ts
 * const { code, stdout } = await host.run(['docker', 'compose', 'version'], { timeoutMs: 10_000 })
 * ```
 */
export interface RunResult {
  /** The exit code; `null` when the process was killed (a timeout, a signal). */
  code: number | null
  /** What it wrote to standard output. Empty when the output was passed through. */
  stdout: string
  /** What it wrote to standard error. Empty when the output was passed through. */
  stderr: string
  /** Whether it was killed because it ran past its timeout. */
  timedOut: boolean
}

/**
 * How a child process is run.
 *
 * @example
 * ```ts
 * const options: RunOptions = { timeoutMs: 60_000, env: { COMPOSE_PROJECT_NAME: 'shop' } }
 * ```
 */
export interface RunOptions {
  /** The working directory. */
  cwd?: string
  /** Variables added to the process's own environment. */
  env?: Readonly<Record<string, string>>
  /** Kill the process after this long. Every spawn has one: a child that hangs must not hang the CLI. */
  timeoutMs: number
  /**
   * `capture` (the default) collects the output and shows none of it; `inherit` passes
   * standard error through so a long step shows its progress. Standard output is always
   * captured: a minted key is printed there.
   */
  stderr?: 'capture' | 'inherit'
}

/**
 * Everything `tula dev` does outside the API: running `docker compose` and reading and writing
 * the project's files. A test passes a fake, so no test needs Docker.
 *
 * @example
 * ```ts
 * const host: Host = createProcessHost()
 * await host.run(['docker', 'compose', 'up', '-d'], { timeoutMs: 300_000 })
 * ```
 */
export interface Host {
  /**
   * Run a command to its end.
   *
   * @param command - The executable and its arguments. Never a shell line.
   * @param options - Directory, environment, timeout.
   * @returns The exit code and the captured output.
   * @throws Error with `code: 'ENOENT'` when the executable does not exist.
   */
  run(command: readonly string[], options: RunOptions): Promise<RunResult>
  /**
   * Read a file as text.
   *
   * @param path - Absolute path.
   * @returns The text, or `null` when the file does not exist.
   * @throws UsageError when `path` is a symbolic link or anything else that is not a regular
   *   file (a named pipe, a directory): refused before it is opened, so a read never waits.
   */
  readFile(path: string): Promise<string | null>
  /**
   * Write a file, replacing it atomically, readable by its owner only.
   *
   * @param path - Absolute path.
   * @param text - The contents.
   * @throws UsageError when `path` is a symbolic link: nothing is written through one.
   */
  writeSecretFile(path: string, text: string): Promise<void>
  /**
   * Create a file that must not exist yet, readable by its owner only (mode 0600). Asking and
   * taking the name are one step, so nothing that appears at the path meanwhile is replaced.
   *
   * @param path - Absolute path.
   * @param text - The contents.
   * @throws UsageError when anything is at `path`: a file (whatever it holds), a directory, a
   *   named pipe or a symbolic link. Nothing there is opened or changed.
   */
  createSecretFile(path: string, text: string): Promise<void>
  /**
   * Remove a file. A symbolic link at the path is removed itself, never what it points at.
   *
   * @param path - Absolute path.
   * @returns Whether there was something to remove.
   */
  removeFile(path: string): Promise<boolean>
  /**
   * Make an existing file readable and writable by its owner only (mode 0600), leaving its
   * contents alone.
   *
   * @param path - Absolute path.
   * @returns Whether the file was open to anyone else and has been closed. `false` when it
   *   already was owner-only, does not exist, or the platform has no such modes.
   * @throws UsageError when `path` is a symbolic link: no mode is changed through one.
   */
  restrictFile(path: string): Promise<boolean>
  /**
   * Wait.
   *
   * @param ms - How long.
   */
  sleep(ms: number): Promise<void>
}
