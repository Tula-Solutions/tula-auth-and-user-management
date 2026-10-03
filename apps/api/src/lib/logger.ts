import pino, { type DestinationStream, type Logger } from 'pino'
import pretty from 'pino-pretty'

/** Structured fields attached to a log line. */
export type LogContext = Record<string, unknown>

/** Levels application code can log at. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Keys censored anywhere in the top two levels of a log context.
 *
 * A safety net only: AGENTS.md forbids passing secrets to the logger at all, because redaction by
 * key name cannot catch a token logged under an unexpected name.
 */
export const REDACTED_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'code',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  'x-tula-publishable-key',
  'x-tula-attempt',
  'attemptSecret',
  'secretHash',
  // An emailed sign-in link's token and the browser binding that goes with it (ADR 0024). Both
  // arrive in a JSON body, never in a URL; named here in case one is ever logged by mistake.
  'linkToken',
  'linkBinding',
  'binding',
  'tula_link',
] as const

const REDACT_PATHS = REDACTED_KEYS.flatMap((key) => [`["${key}"]`, `*["${key}"]`])

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  level: LogLevel | 'silent'
  /** Human-readable output for a local shell; JSON lines otherwise. */
  pretty: boolean
}

/**
 * Build a pino logger with Tula's redaction rules.
 *
 * `pino-pretty` is attached as a destination stream, not a `transport`: transports run in a
 * worker thread that resolves modules by name at runtime, which breaks under `bun build`.
 *
 * @param options - Level and output format.
 * @param destination - Where to write (defaults to stdout); tests pass a buffer.
 * @returns The pino logger.
 */
export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const config = {
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: undefined,
  }
  if (destination) {
    return pino(config, destination)
  }
  return options.pretty
    ? pino(
        config,
        pretty({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' })
      )
    : pino(config)
}

// Configured from raw process.env instead of ~/env so importing the logger can never fail or
// exit: tests and scripts import modules that log without a full server environment. NODE_ENV
// only picks the output format here, which is the one thing AGENTS.md allows it to decide.
const nodeEnv = process.env.NODE_ENV
const requestedLevel = process.env.LOG_LEVEL
const base = createLogger({
  level:
    nodeEnv === 'test'
      ? 'silent'
      : requestedLevel === 'debug' ||
          requestedLevel === 'warn' ||
          requestedLevel === 'error' ||
          requestedLevel === 'silent'
        ? requestedLevel
        : 'info',
  pretty: nodeEnv !== 'production',
})

function write(level: LogLevel, message: string, context?: LogContext): void {
  if (context) {
    base[level](context, message)
  } else {
    base[level](message)
  }
}

/**
 * Log at `debug` level.
 *
 * @param message - Human-readable message.
 * @param context - Structured fields. Never pass secrets, tokens or full emails.
 */
export function debug(message: string, context?: LogContext): void {
  write('debug', message, context)
}

/**
 * Log at `info` level.
 *
 * @param message - Human-readable message.
 * @param context - Structured fields. Never pass secrets, tokens or full emails.
 */
export function info(message: string, context?: LogContext): void {
  write('info', message, context)
}

/**
 * Log at `warn` level.
 *
 * @param message - Human-readable message.
 * @param context - Structured fields. Never pass secrets, tokens or full emails.
 */
export function warn(message: string, context?: LogContext): void {
  write('warn', message, context)
}

/**
 * Log at `error` level.
 *
 * @param message - Human-readable message.
 * @param context - Structured fields. Never pass secrets, tokens or full emails.
 */
export function error(message: string, context?: LogContext): void {
  write('error', message, context)
}
