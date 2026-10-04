import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseConfig, type TulaConfig } from './config'
import { ConfigError, invalidConfig, isConfigError } from './errors'

/**
 * A config and the file it came from.
 *
 * @example
 * ```ts
 * const loaded: LoadedConfig = await loadConfig('tula.config.ts')
 * ```
 */
export interface LoadedConfig {
  /** The file's absolute path. */
  readonly path: string
  /** The validated config. */
  readonly config: TulaConfig
}

/** The file name `tula` looks for when it is not given one. */
export const DEFAULT_CONFIG_FILE = 'tula.config.ts'

/**
 * Load and validate a config file.
 *
 * The file is **imported**, which runs it: a config file is code its operator trusts, exactly
 * like a build script. It is validated again here whether or not it used `defineConfig`, so a
 * plain object export gets the same checks.
 *
 * Importing a `.ts` file needs a runtime that can: Bun does (the `tula` CLI runs on Bun), and
 * so does Node 22.18 or later for a file that uses only erasable syntax. Elsewhere the load
 * fails with `config.load_failed`; a `.js` or `.mjs` config works on any runtime.
 *
 * A failure to import reports the thrown error's **name** only. Its message is whatever the
 * file's code put there, which this package cannot vouch for; run the file directly to see it.
 *
 * @param path - The file, absolute or relative to `cwd`.
 * @param cwd - The directory a relative path is resolved against. Defaults to the process's.
 * @returns The file's absolute path and its validated config.
 * @throws ConfigError `config.not_found`, `config.load_failed` or `config.invalid`.
 *
 * @example
 * ```ts
 * const { config } = await loadConfig('tula.config.ts')
 * const prod = selectEnvironment(config, 'prod')
 * ```
 */
export async function loadConfig(path: string, cwd: string = process.cwd()): Promise<LoadedConfig> {
  const file = isAbsolute(path) ? path : resolve(cwd, path)
  const found = await stat(file).then(
    (entry) => entry.isFile(),
    () => false
  )
  if (!found) {
    throw new ConfigError('config.not_found', `There is no config file at ${file}.`)
  }

  let module: unknown
  try {
    module = await import(pathToFileURL(file).href)
  } catch (cause) {
    // A config whose own `defineConfig()` call refused it: that error is already the right one.
    if (isConfigError(cause)) {
      throw cause
    }
    const name = cause instanceof Error ? cause.name : 'an error'
    throw new ConfigError(
      'config.load_failed',
      `Could not load ${file} (${name}). Run the file by itself to see why, e.g. \`bun ${file}\`. ` +
        'A TypeScript config needs Bun, or Node 22.18 or later.'
    )
  }

  const exported =
    typeof module === 'object' && module !== null && 'default' in module
      ? (module as { default: unknown }).default
      : undefined
  if (exported === undefined) {
    throw invalidConfig([
      { path: '', message: 'the file must `export default defineConfig({ … })`' },
    ])
  }
  return { path: file, config: parseConfig(exported) }
}
