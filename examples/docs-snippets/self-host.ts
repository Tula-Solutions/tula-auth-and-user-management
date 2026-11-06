import { createAdminClient, ifMatch } from '@tula-tech/admin'

// The admin API calls shown in docs/self-host.md, through `@tula-tech/admin`. Copied by region
// (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

const admin = createAdminClient({ baseUrl: 'http://localhost:3003', secretKey })

/** Read the settings document and its revision. */
export async function readSettings() {
  // #region self-host-settings-read
  const { data, etag } = await admin.call('getEnvironmentSettings')
  // etag: '"0"', data: { revision: 0, settings: { version: 1, … } }
  // #endregion
  return { data, etag }
}

/** Replace the whole document, naming the revision that was read. */
export async function replaceSettings(revision: number) {
  // #region self-host-settings-replace
  await admin.call('replaceEnvironmentSettings', {
    headers: { 'If-Match': ifMatch(revision) },
    body: {
      app: { name: 'Acme', supportEmail: 'help@acme.example' },
      urls: { allowedOrigins: ['https://app.acme.example'] },
    },
  })
  // #endregion
}

/** Check a stateful session's cookie value. */
export async function verifyCookie(cookie: string) {
  // #region self-host-verify-session
  const { data: claims } = await admin.call('verifySession', { body: { token: cookie } })
  // #endregion
  return claims
}
