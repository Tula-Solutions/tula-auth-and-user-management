import { createAdminClient } from '@tula-tech/admin'

// The audit export calls shown in docs/audit-export.md, through `@tula-tech/admin`. Copied by
// region (`bun run docs:generate`) and compiled by `bun run typecheck:scripts`. Nothing here runs.

/** The environment's secret key (`tula_sk_…`), read from the server's own configuration. */
declare const secretKey: string

const admin = createAdminClient({ baseUrl: 'https://auth.example.com', secretKey })

/** Export every entry since the start of the year. */
export async function exportSinceJanuary() {
  // #region audit-export-since
  const response = await admin.stream('exportAuditLogs', {
    body: { format: 'csv', from: '2026-01-01T00:00:00Z' },
  })
  const csv = await response.text()
  // #endregion
  return csv
}

/** Export one organization's connection changes for a quarter. */
export async function exportConnectionChanges() {
  // #region audit-export-organization
  const response = await admin.stream('exportAuditLogs', {
    body: {
      format: 'csv',
      organizationId: '<org id>',
      action: 'sso_connection.updated',
      from: '2026-07-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    },
  })
  const csv = await response.text()
  // #endregion
  return csv
}
