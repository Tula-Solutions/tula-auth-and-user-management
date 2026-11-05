import { join } from 'node:path'

// What the release refuses to find in npm's configuration: a long-lived credential. This is
// the one place that reads those files, and only to refuse; it echoes no value.

/**
 * Whether an environment variable is an npm setting that carries a credential.
 *
 * npm reads every `npm_config_*` variable as a setting, so a token can arrive under a name
 * other than `NPM_TOKEN` (`npm_config__authToken`, a registry-scoped key).
 *
 * @param key - The variable's name.
 * @returns True for a token, `_auth` or `_password` setting.
 */
export function isCredentialSetting(key: string): boolean {
  return /^npm_config_.*(_authtoken|_auth|_password)$/i.test(key)
}

/**
 * Whether an npm configuration file sets a credential to a literal value. A comment and a
 * `${VAR}` placeholder (what `setup-node` writes) are not one.
 *
 * @param text - The file's text.
 * @returns True when a line sets a token, `_auth` or `_password` to a literal.
 */
export function holdsLiteralCredential(text: string): boolean {
  return text.split('\n').some((raw) => {
    const line = raw.trim()
    if (line.startsWith(';') || line.startsWith('#')) {
      return false
    }
    const value = /(?:^|:)(?:_authToken|_auth|_password)\s*=\s*(.*)$/i.exec(line)?.[1]
    return value !== undefined && value !== '' && !/^\$\{[^}]+\}$/.test(value)
  })
}

/**
 * The text of the npm configuration files npm would read here.
 *
 * @param env - The process's environment (`NPM_CONFIG_USERCONFIG` names the user file).
 * @param cwd - The project directory, whose own file npm also reads.
 * @returns The contents of each file that exists.
 */
export async function readNpmConfigFiles(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string
): Promise<string[]> {
  const paths = [env.NPM_CONFIG_USERCONFIG, join(env.HOME ?? '', '.npmrc'), join(cwd, '.npmrc')]
  const found: string[] = []
  for (const path of paths) {
    if (path !== undefined && path !== '' && (await Bun.file(path).exists())) {
      found.push(await Bun.file(path).text())
    }
  }
  return found
}
