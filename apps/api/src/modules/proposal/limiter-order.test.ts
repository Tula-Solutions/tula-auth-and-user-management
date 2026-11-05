import { beforeEach, expect, test } from 'bun:test'
import { createApp } from '~/index'
import * as Proposals from '~/modules/proposal/service'
import { createInstanceTestDeps, seedApiKey, TEST_TENANT } from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'

let app: ReturnType<typeof createApp>

beforeEach(async () => {
  const deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, AK)
  await seedApiKey(deps, SK)
  app = createApp(deps)
})

function propose(body: unknown) {
  return app.request('/v1/agent/proposals', {
    method: 'POST',
    headers: { authorization: `Bearer ${AK}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// H-188: the per-operation limiter reads the validated body, so it must run after the
// validator; a body that fails validation must neither reach it nor use up its count.
test('requests the validator refuses do not use up the per-operation limit', async () => {
  for (let i = 0; i <= Proposals.PROPOSALS_PER_OPERATION_PER_MINUTE; i++) {
    const res = await propose({
      operation: 'ban_user',
      target: { type: 'user', id: 'NOT A UUID!' },
    })
    expect(res.status).toBe(422)
  }
  const created = await app.request('/v1/admin/users', {
    method: 'POST',
    headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'maya@northline.app', password: 'correct horse battery staple' }),
  })
  const maya = (await created.json()) as { id: string }
  const ok = await propose({ operation: 'ban_user', target: { type: 'user', id: maya.id } })
  expect(ok.status).toBe(201)
})
