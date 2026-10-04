/**
 * Why a config was refused.
 *
 * - `config.invalid`: the file's content is not a valid config (`issues` says where).
 * - `config.not_found`: there is no file at the path.
 * - `config.load_failed`: the file could not be imported (a syntax error, a throw, a runtime
 *   that cannot import TypeScript).
 * - `config.environment_required`: the file has several environments and none was named.
 * - `config.environment_unknown`: the named environment is not in the file.
 * - `config.secret_missing`: an environment variable a secret refers to is not set.
 *
 * @example
 * ```ts
 * if (error.code === 'config.secret_missing') {
 *   process.exitCode = 1
 * }
 * ```
 */
export type ConfigErrorCode =
  | 'config.invalid'
  | 'config.not_found'
  | 'config.load_failed'
  | 'config.environment_required'
  | 'config.environment_unknown'
  | 'config.secret_missing'

/**
 * One problem in a config file.
 *
 * @example
 * ```ts
 * const issue: ConfigIssue = { path: 'environments.dev.settings.pasword', message: 'unknown key' }
 * ```
 */
export interface ConfigIssue {
  /** Where in the config, dot-separated; empty for the file as a whole. */
  readonly path: string
  /** What is wrong there. Never a value from the file. */
  readonly message: string
}

/**
 * The one error this package throws.
 *
 * It never carries a value from the config file or from the environment: an issue names the
 * path and the rule, and a missing secret names the variable.
 *
 * @example
 * ```ts
 * try {
 *   await loadConfig('tula.config.ts')
 * } catch (error) {
 *   if (isConfigError(error)) {
 *     for (const issue of error.issues) {
 *       report(`${issue.path}: ${issue.message}`)
 *     }
 *   }
 * }
 * ```
 */
export class ConfigError extends Error {
  /** Why the config was refused. */
  readonly code: ConfigErrorCode
  /** The problems found, for `config.invalid`; empty otherwise. */
  readonly issues: readonly ConfigIssue[]

  /**
   * @param code - Why the config was refused.
   * @param message - The message.
   * @param issues - The problems found.
   */
  constructor(code: ConfigErrorCode, message: string, issues: readonly ConfigIssue[] = []) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.issues = issues
  }

  /**
   * A plain, serialisable copy of the error (no stack).
   *
   * @returns The error's fields.
   */
  toJSON(): {
    name: string
    code: ConfigErrorCode
    message: string
    issues: readonly ConfigIssue[]
  } {
    return { name: this.name, code: this.code, message: this.message, issues: this.issues }
  }
}

/**
 * Whether a caught value is a {@link ConfigError}.
 *
 * @param value - The caught value.
 * @returns `true` for a `ConfigError`.
 *
 * @example
 * ```ts
 * if (isConfigError(error)) {
 *   show(error.message)
 * }
 * ```
 */
export function isConfigError(value: unknown): value is ConfigError {
  return (
    value instanceof ConfigError ||
    (value instanceof Error && value.name === 'ConfigError' && 'code' in value && 'issues' in value)
  )
}

/**
 * Build the error for a config whose content is not valid.
 *
 * @param issues - The problems found.
 * @returns The error, its message listing every issue.
 */
export function invalidConfig(issues: readonly ConfigIssue[]): ConfigError {
  const lines = issues.map(
    (issue) => `  ${issue.path === '' ? '(config)' : issue.path}: ${issue.message}`
  )
  return new ConfigError('config.invalid', `The config is not valid:\n${lines.join('\n')}`, issues)
}
