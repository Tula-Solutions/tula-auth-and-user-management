import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS } from '@tula-tech/contract'
import * as Users from '~/modules/user/service'
import { createInstanceTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'
import * as Organizations from './service'

const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

let deps: TestDeps

beforeEach(() => {
  deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: 1,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
    } as never,
  })
})

describe('changeMemberRole: the actor', () => {
  test('a setup link’s actor cannot give a privileged role, whoever calls', async () => {
    const org = await Organizations.create(deps, TENANT, { name: 'A', slug: 'a' }, TEST_ACTOR)
    const admin = await Users.create(deps, TENANT, { email: 'a@acme.test' }, TEST_ACTOR)
    const lee = await Users.create(deps, TENANT, { email: 'lee@acme.test' }, TEST_ACTOR)
    for (const [user, role] of [
      [admin, 'admin'],
      [lee, 'member'],
    ] as const) {
      await Organizations.addMember(deps, TENANT, org.id, { userId: user.id, role }, TEST_ACTOR)
    }
    const link = { ...TEST_ACTOR, type: 'setup_link' as const, id: Bun.randomUUIDv7() }
    await expect(
      Organizations.changeMemberRole(deps, TENANT, org.id, lee.id, { role: 'admin' }, link)
    ).rejects.toMatchObject({ code: 'organization.permission_required' })
    expect(
      (await deps.organizations.findMembership(TEST_TENANT.environmentId, org.id, lee.id))?.roleKey
    ).toBe('member')
    // An operator's own change and an unprivileged role for a link both still go through.
    await Organizations.changeMemberRole(
      deps,
      TENANT,
      org.id,
      lee.id,
      { role: 'admin' },
      TEST_ACTOR
    )
    await Organizations.changeMemberRole(deps, TENANT, org.id, lee.id, { role: 'member' }, link)
  })
})
