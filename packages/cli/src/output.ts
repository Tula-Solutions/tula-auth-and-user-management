/**
 * Where output goes: `process.stdout`, `process.stderr`, or a test's buffer.
 *
 * @example
 * ```ts
 * const lines: string[] = []
 * const sink: Sink = { write: (text) => lines.push(text) }
 * ```
 */
export interface Sink {
  /** Write text. */
  write(text: string): unknown
  /** Whether the sink is a terminal. */
  isTTY?: boolean
}

/**
 * Text styles. Each returns its text unchanged when colour is off.
 *
 * @example
 * ```ts
 * output.line(output.style.green('+ added'))
 * ```
 */
export interface Styles {
  /** Something added. */
  green(text: string): string
  /** Something removed, or an error. */
  red(text: string): string
  /** Something changed, or a warning. */
  yellow(text: string): string
  /** Secondary text. */
  dim(text: string): string
  /** A heading. */
  bold(text: string): string
}

/**
 * The one place the CLI writes from. Commands never touch `console` or `process.stdout`: they
 * get an `Output`, so a test captures everything a run prints.
 *
 * @example
 * ```ts
 * const output = createOutput(process.stdout, process.stderr, process.env)
 * output.line('No changes.')
 * ```
 */
export interface Output {
  /** Write a line to standard output. */
  line(text?: string): void
  /** Write a line to standard error. */
  error(text: string): void
  /** Styles for standard output. */
  readonly style: Styles
  /** Styles for standard error. */
  readonly errorStyle: Styles
  /**
   * Name a value that must never be printed (the secret key, a provider's secret). Every line
   * written afterwards has it replaced by `[redacted]`. No code path prints one on purpose;
   * this is the net under them (an error message that quotes a request, a future mistake).
   */
  redact(value: string): void
}

/**
 * Whether to colour a stream: only a terminal, and never when `NO_COLOR` is set to anything
 * but the empty string (https://no-color.org) or `TERM` is `dumb`.
 *
 * @param sink - The stream.
 * @param env - The environment.
 * @returns `true` to use ANSI colours.
 *
 * @example
 * ```ts
 * shouldUseColor(process.stdout, process.env)
 * ```
 */
export function shouldUseColor(
  sink: Sink,
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const noColor = env.NO_COLOR
  return sink.isTTY === true && (noColor === undefined || noColor === '') && env.TERM !== 'dumb'
}

function styles(color: boolean): Styles {
  const wrap = (open: number, close: number) => (text: string) =>
    color ? `\u001b[${open}m${text}\u001b[${close}m` : text
  return {
    green: wrap(32, 39),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  }
}

/** Shorter than this, a value is not treated as a secret: redacting it would garble output. */
const MIN_REDACTED_LENGTH = 6

/**
 * Build the CLI's output.
 *
 * @param stdout - Where results go.
 * @param stderr - Where errors and prompts go.
 * @param env - The environment (`NO_COLOR`, `TERM`).
 * @returns The output.
 *
 * @example
 * ```ts
 * const output = createOutput(process.stdout, process.stderr, process.env)
 * ```
 */
export function createOutput(
  stdout: Sink,
  stderr: Sink,
  env: Readonly<Record<string, string | undefined>>
): Output {
  const secrets = new Set<string>()
  const clean = (text: string) => {
    let cleaned = text
    for (const secret of secrets) {
      cleaned = cleaned.split(secret).join('[redacted]')
    }
    return cleaned
  }
  return {
    line: (text = '') => {
      stdout.write(`${clean(text)}\n`)
    },
    error: (text) => {
      stderr.write(`${clean(text)}\n`)
    },
    style: styles(shouldUseColor(stdout, env)),
    errorStyle: styles(shouldUseColor(stderr, env)),
    redact: (value) => {
      const trimmed = value.trim()
      if (trimmed.length >= MIN_REDACTED_LENGTH) {
        secrets.add(trimmed)
        // A multi-line secret (a PEM key) could surface one line at a time.
        for (const line of trimmed.split('\n')) {
          if (line.trim().length >= MIN_REDACTED_LENGTH * 4) {
            secrets.add(line.trim())
          }
        }
      }
    },
  }
}
