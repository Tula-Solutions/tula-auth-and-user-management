import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

// H-203: every delete the retention job makes is confined to one environment twice over: by
// `withTenant` (row-level security) and by an explicit environment filter. This reads the
// Postgres adapters' source, because the integration tests that would prove it need Docker.
const POSTGRES = join(import.meta.dir, '../../adapters/postgres')

const PURGES: Array<[file: string, method: string]> = [
  ['activity.ts', 'deleteAuditBefore'],
  ['users.ts', 'deletePasswordHistoryBeyond'],
  ['users.ts', 'deleteTestUsersBefore'],
  ['flow-attempts.ts', 'deleteExpired'],
  ['verification-tokens.ts', 'deleteExpired'],
  ['sessions.ts', 'deleteEnded'],
  ['factors.ts', 'deleteExpiredPending'],
  ['passkeys.ts', 'deleteExpiredChallenges'],
  ['webhook-deliveries.ts', 'deleteEndedBefore'],
  ['webhook-deliveries.ts', 'deleteSettledEvents'],
  ['sms-usage.ts', 'deleteBefore'],
  ['proposals.ts', 'deleteExpiredBefore'],
  ['hooks.ts', 'deleteCallCountsBefore'],
  ['organization-domains.ts', 'purgeExpiredPending'],
  ['organizations.ts', 'deleteExpiredInvitations'],
  ['organizations.ts', 'purgeSupersededRoleVersions'],
  ['setup-links.ts', 'deleteExpiredBefore'],
]

/** The text of one method: from its declaration to the next two-space-indented member. */
async function bodyOf(file: string, method: string): Promise<string> {
  const text = await Bun.file(join(POSTGRES, file)).text()
  const start = text.indexOf(`  async ${method}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + 1)
  const next = rest.search(/\n {2}(async |get |set |private |public |[a-z]\w*\()/)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('retention deletes are scoped to the environment', () => {
  test.each(PURGES)(
    '%s %s takes an environment, runs in withTenant and filters on it',
    async (file, method) => {
      const body = await bodyOf(file, method)
      expect(body).toMatch(/\(\s*environmentId: string/)
      expect(body).toMatch(/withTenant\(\s*this\.db,\s*environmentId/)
      expect(body).toMatch(
        /environmentId,\s*environmentId\)|environment_id\s*=\s*\$\{environmentId\}/
      )
    }
  )
})
