import { type AdminClient, createAdminClient } from '@tula/admin'
import { type EnvironmentConfig, secretKeyMatchesKind } from '@tula/config'
import { UsageError } from './args'
import type { CliIo } from './framework'
import type { Output } from './output'
import { VERSION } from './version'

/**
 * The API a run talks to.
 *
 * @example
 * ```ts
 * const { admin, apiUrl } = await resolveTarget({ name: 'prod', environment, flags, io, output })
 * ```
 */
export interface Target {
  /** The API's URL, for display. */
  apiUrl: string
  /** The admin client, holding the secret key. */
  admin: AdminClient
}

/** `prod-eu` → `PROD_EU`: the suffix of an environment's own variables. */
function variableSuffix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

function own(env: CliIo['env'], name: string): string | undefined {
  const value = Object.hasOwn(env, name) ? env[name] : undefined
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/**
 * Work out which API a run talks to and with which key.
 *
 * - **URL**: `--api-url`, else `TULA_API_URL_<NAME>`, else `TULA_API_URL`.
 * - **Secret key**: `--secret-key-file <path>` (`-` reads standard input), else
 *   `TULA_SECRET_KEY_<NAME>`, else `TULA_SECRET_KEY`.
 *
 * `<NAME>` is the environment's name in the config, upper-cased, so one CI job can hold the
 * keys of several environments. Neither is ever read from the config file (it is committed),
 * and there is deliberately no option that takes the key itself: a command line is recorded
 * in shell history and visible in process lists. The key is registered with the output's
 * redaction before anything else can print.
 *
 * The secret key decides the environment. When the config's entry says which `kind` it is
 * for, a key of the other kind (`tula_sk_dev_…` for `production`) is refused here, before any
 * request.
 *
 * @param input - The environment's name and entry, the command's flags, and the run's io.
 * @returns The API's URL and an admin client.
 * @throws UsageError when the URL or the key is missing, or the key is of the wrong kind.
 * @throws TulaAdminError when the key is not a secret key or the URL is not usable.
 *
 * @example
 * ```ts
 * const target = await resolveTarget({ name: 'prod', environment, flags, io, output })
 * ```
 */
export async function resolveTarget(input: {
  name: string
  environment: EnvironmentConfig
  flags: Record<string, string | boolean | undefined>
  io: CliIo
  output: Output
}): Promise<Target> {
  const { name, environment, flags, io, output } = input
  const suffix = variableSuffix(name)

  const keyFile =
    typeof flags['secret-key-file'] === 'string' ? flags['secret-key-file'] : undefined
  let secretKey: string | undefined
  if (keyFile !== undefined) {
    const read = keyFile === '-' ? io.readStdin : io.readFile
    if (!read) {
      throw new UsageError('--secret-key-file cannot be read here.')
    }
    secretKey = (
      await read(keyFile).catch(() => {
        throw new UsageError(
          keyFile === '-'
            ? 'Could not read the secret key from standard input.'
            : 'Could not read the file given as --secret-key-file.'
        )
      })
    ).trim()
  } else {
    secretKey = own(io.env, `TULA_SECRET_KEY_${suffix}`) ?? own(io.env, 'TULA_SECRET_KEY')
  }
  if (!secretKey) {
    throw new UsageError(
      `No secret key: set TULA_SECRET_KEY (or TULA_SECRET_KEY_${suffix}), or pass --secret-key-file <path>.`
    )
  }
  output.redact(secretKey)

  const apiUrl =
    (typeof flags['api-url'] === 'string' ? flags['api-url'] : undefined) ??
    own(io.env, `TULA_API_URL_${suffix}`) ??
    own(io.env, 'TULA_API_URL')
  if (!apiUrl) {
    throw new UsageError(
      `No API URL: set TULA_API_URL (or TULA_API_URL_${suffix}), or pass --api-url <url>.`
    )
  }

  const admin = createAdminClient({
    baseUrl: apiUrl,
    secretKey,
    fetch: io.fetch,
    userAgent: `tula-cli/${VERSION}`,
  })
  if (!secretKeyMatchesKind(environment.kind, secretKey)) {
    throw new UsageError(
      `The config says "${name}" is a ${environment.kind} environment, and the secret key is not ` +
        `a ${environment.kind} key. Nothing was read or changed.`
    )
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ''), admin }
}
