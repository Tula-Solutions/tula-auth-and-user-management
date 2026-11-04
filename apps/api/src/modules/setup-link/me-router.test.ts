import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type CurrentUser,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type FlowAttempt,
  type Organization,
  type HybridSessionTokens as SessionTokens,
} from '@tula-tech/contract'
import { createApp } from '~/index'
import * as Organizations from '~/modules/organization/service'
import { createTestDeps, seedApiKey, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const TENANT = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'https://app.northline.test'

let deps: TestDeps
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  deps = createTestDeps()
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
      urls: { allowedOrigins: [ORIGIN], allowedRedirectUrls: [] },
      organizations: { ...DEFAULT_ENVIRONMENT_SETTINGS.organizations, enabled: true },
      sso: { enabled: true },
    } as never,
  })
  await seedApiKey(deps, PK)
  app = createApp(deps)
})

const json = async <T>(res: Response) => (await res.json()) as T

function client(method: string, path: string, body?: unknown, token?: string, secret?: string) {
  return app.request(`/v1/client${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tula-client': 'ios',
      origin: ORIGIN,
      'x-tula-publishable-key': PK,
      ...(token && { authorization: `Bearer ${token}` }),
      ...(secret && { 'x-tula-attempt': secret }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

const emailedCode = () =>
  /^(\d{6}) /.exec(
    deps.mailer.outbox.findLast((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''

async function signUp(email: string): Promise<SessionTokens & { userId: string }> {
  const started = await json<FlowAttempt>(
    await client('POST', '/sign-ups', { email, password: PASSWORD })
  )
  const done = await json<FlowAttempt>(
    await client(
      'POST',
      `/sign-ups/${started.id}/verify-email`,
      { code: emailedCode() },
      undefined,
      started.attemptSecret
    )
  )
  const session = done.session as SessionTokens
  const user = await json<CurrentUser>(await client('GET', '/me', undefined, session.accessToken))
  return { ...session, userId: user.id }
}

async function member(org: Organization, email: string, role: string) {
  const user = await signUp(email)
  await Organizations.addMember(deps, TENANT, org.id, { userId: user.userId, role }, TEST_ACTOR)
  return user
}

describe('an administrator’s setup links', () => {
  test('lists, creates and revokes; a plain member is refused', async () => {
    const org = await Organizations.create(deps, TENANT, { name: 'acme', slug: 'acme' }, TEST_ACTOR)
    const maya = await member(org, 'maya@northline.app', 'admin')
    const ada = await member(org, 'ada@northline.app', 'member')
    const path = `/me/organizations/${org.id}/setup-links`

    const created = await client('POST', path, { name: 'IT', expiresInDays: 7 }, maya.accessToken)
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    const made = await json<{ id: string }>(created)

    const listed = await json<{ links: Array<{ id: string }> }>(
      await client('GET', path, undefined, maya.accessToken)
    )
    expect(listed.links.map((l) => l.id)).toEqual([made.id])

    expect((await client('GET', path, undefined, ada.accessToken)).status).toBe(403)
    expect(
      (await client('POST', path, { name: 'IT', expiresInDays: 7 }, ada.accessToken)).status
    ).toBe(403)
    expect((await client('DELETE', `${path}/${made.id}`, undefined, ada.accessToken)).status).toBe(
      403
    )

    const revoked = await client('DELETE', `${path}/${made.id}`, undefined, maya.accessToken)
    expect(revoked.status).toBe(204)
  })
})
