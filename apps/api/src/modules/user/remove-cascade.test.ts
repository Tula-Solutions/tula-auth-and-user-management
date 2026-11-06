import { describe, expect, spyOn, test } from 'bun:test'
import type { Tenant } from '~/dependencies'
import * as Audit from '~/modules/audit/service'
import * as Sessions from '~/modules/session/service'
import * as Users from '~/modules/user/service'
import { createTestDeps, TEST_ACTOR, TEST_TENANT } from '~/testing'

const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}

function makeDeps() {
  const deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  return deps
}

const signIn = (deps: ReturnType<typeof createTestDeps>, userId: string) =>
  Sessions.create(deps, tenant, { userId, client: 'web', userAgent: null, ipAddress: null })

// Postgres cascades a user's sessions with the user (`sessions_user_fk`), so a sweep after the
// delete finds nothing: the store has to report what the delete ended (H-229).
describe('removing a user whose session appears after the first sweep (H-229)', () => {
  test('the store reports the sessions the delete cascaded away, and the service denylists them', async () => {
    const deps = makeDeps()
    const user = await Users.create(
      deps,
      tenant,
      { email: 'maya@northline.app', password: 'correct horse battery staple' },
      TEST_ACTOR
    )
    const del = deps.users.delete.bind(deps.users)
    let stray = ''
    spyOn(deps.users, 'delete').mockImplementation(async (...args) => {
      stray = (await signIn(deps, user.id)).sessionId
      return del(...args)
    })
    await Users.remove(deps, tenant, user.id, TEST_ACTOR)
    expect(await deps.sessions.findById(tenant.environmentId, stray)).toBeNull()
    expect(await deps.revokedSessions.has(stray, deps.clock.now())).toBe(true)
  })

  test('delete reports the ids of the sessions that were still active', async () => {
    const deps = makeDeps()
    const user = await Users.create(
      deps,
      tenant,
      { email: 'maya@northline.app', password: 'correct horse battery staple' },
      TEST_ACTOR
    )
    const { sessionId } = await signIn(deps, user.id)
    const result = await deps.users.delete(tenant.environmentId, user.id, Audit.none('fixture'))
    expect(result).toEqual({ outcome: 'deleted', endedSessionIds: [sessionId] })
  })
})
