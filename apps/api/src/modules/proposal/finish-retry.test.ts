import { beforeEach, expect, spyOn, test } from 'bun:test'
import type { Proposal, User } from '@tula-tech/contract'
import { createApp } from '~/index'
import * as logger from '~/lib/logger'
import { createInstanceTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createInstanceTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
  app = createApp(deps)
})

function call(method: string, path: string, key: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// H-179: a transient failure of the last write must not leave an executed change "approved".
test('a failed write of the outcome is retried once, and the proposal ends executed', async () => {
  const created = await call('POST', '/v1/admin/users', SK, {
    email: 'maya@northline.app',
    password: 'correct horse battery staple',
  })
  const maya = (await created.json()) as User
  const proposal = (await (
    await call('POST', '/v1/agent/proposals', AK, {
      operation: 'ban_user',
      target: { type: 'user', id: maya.id },
    })
  ).json()) as Proposal
  const error = spyOn(logger, 'error').mockImplementation(() => undefined)
  const finish = spyOn(deps.proposals, 'finish').mockRejectedValueOnce(new Error('connection lost'))
  try {
    const res = await call('POST', `/v1/admin/proposals/${proposal.id}/approve`, SK, {
      operation: proposal.operation,
      target: proposal.target,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'executed' })
    expect(finish).toHaveBeenCalledTimes(2)
  } finally {
    finish.mockRestore()
    error.mockRestore()
  }
})
