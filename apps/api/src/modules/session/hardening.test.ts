import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { base32Decode, totp } from '~/lib/totp'
import { requestMayUseSessionCookie } from '~/middleware/cors'
import * as Audit from '~/modules/audit/service'
import * as Mfa from '~/modules/mfa/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, TEST_TENANT } from '~/testing'

/** Ask `requestMayUseSessionCookie` about one request, through a real Hono context. */
async function mayUse(method: string, headers: Record<string, string>): Promise<boolean> {
  const deps = createTestDeps()
  const app = new Hono()
  app.all('/', async (c) => {
    c.set('deps' as never, deps as never)
    c.set('tenant' as never, TEST_TENANT as never)
    return c.json({ ok: await requestMayUseSessionCookie(c as never) })
  })
  const res = await app.request('/', { method, headers })
  return ((await res.json()) as { ok: boolean }).ok
}

describe('H-098: the literal null origin never carries a session cookie', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'GET']) {
    test(`Origin: null is refused on ${method}`, async () => {
      expect(await mayUse(method, { origin: 'null' })).toBe(false)
    })
  }
  test('an unsafe method with no Origin is refused, a safe one is served', async () => {
    expect(await mayUse('POST', {})).toBe(false)
    expect(await mayUse('GET', {})).toBe(true)
  })
})

describe('H-097: only the start of an attempt fixes its device key', () => {
  test('the device thumbprint is written by asked() alone', () => {
    const source = readFileSync(`${import.meta.dir}/../flow/service.ts`, 'utf8')
    const writes = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /deviceThumbprint\b/.test(line))
      // The declaration, the zod field, asked()'s two lines and the one read at finish.
      .filter(
        (line) =>
          !/^deviceThumbprint\??: (string|z\.string\(\)\.optional\(\)),?$/.test(line) &&
          line !==
            '...(context.deviceThumbprint && { deviceThumbprint: context.deviceThumbprint }),' &&
          line !== 'deviceThumbprint: state.deviceThumbprint,' &&
          !line.includes("'deviceThumbprint'")
      )
    expect(writes).toEqual([])
  })
})

describe('H-103: a revoked session spends no step-up proof', () => {
  const tenant = {
    projectId: TEST_TENANT.projectId,
    environmentId: TEST_TENANT.environmentId,
    apiKeyId: 'key_1',
  }

  async function setup() {
    const deps = createTestDeps()
    deps.environments.add({
      id: tenant.environmentId,
      projectId: tenant.projectId,
      kind: 'development',
      createdAt: deps.clock.now(),
    })
    const id = deps.ids.next()
    await deps.users.create(
      {
        id,
        projectId: tenant.projectId,
        environmentId: tenant.environmentId,
        email: 'maya@northline.app',
        emailNormalized: 'maya@northline.app',
        emailVerifiedAt: deps.clock.now(),
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: null,
      },
      Audit.none('fixture')
    )
    const actor = {
      type: 'user' as const,
      id,
      ipAddress: '203.0.113.7',
      userAgent: 'tula-tests/1.0',
    }
    const enrolment = await Mfa.startTotp(deps, tenant, id)
    const { codes } = await Mfa.confirmTotp(
      deps,
      tenant,
      { userId: id },
      totp(base32Decode(enrolment.secret), deps.clock.now()),
      actor
    )
    deps.clock.advance('30s')
    const open = () =>
      Sessions.create(deps, tenant, {
        userId: id,
        client: 'web',
        userAgent: 'Mozilla/5.0',
        authMethods: ['pwd', 'otp', 'mfa'],
      })
    return { deps, id, codes, open, actor }
  }

  test('a backup code offered on a revoked session still works on a live one', async () => {
    const { deps, id, codes, open, actor } = await setup()
    const dead = await open()
    await Sessions.revoke(deps, tenant, { userId: id, sessionId: dead.sessionId, actor })
    const live = await open()
    const ctx = { ipAddress: '203.0.113.7', userAgent: 'tula-tests/1.0' }
    const proof = { method: 'backup_code', code: codes[0] as string } as const

    await expect(
      Mfa.stepUp(deps, tenant, { userId: id, sessionId: dead.sessionId }, proof, ctx)
    ).rejects.toMatchObject({ code: 'session.revoked' })
    await expect(
      Mfa.stepUp(deps, tenant, { userId: id, sessionId: live.sessionId }, proof, ctx)
    ).resolves.toBeDefined()
  })
})
