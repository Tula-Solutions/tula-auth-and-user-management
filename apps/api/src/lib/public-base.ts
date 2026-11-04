import type { AppConfig } from '~/dependencies'

/**
 * The server's public address without a trailing slash, the base of every URL the server builds
 * for a person or a directory to paste elsewhere (SCIM base, SSO callback, setup link).
 *
 * @param config - The app config.
 * @returns `PUBLIC_URL` with trailing slashes removed.
 */
export function publicBase(config: Pick<AppConfig, 'publicUrl'>): string {
  return config.publicUrl.replace(/\/+$/, '')
}
