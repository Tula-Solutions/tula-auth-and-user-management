import { beforeAll, describe, expect, test } from 'bun:test'
import { permissionsHash } from '@tula-tech/contract/organization-lookup'
import { NextRequest } from 'next/server'
import { authenticate } from './helpers'
import { tulaMiddleware } from './middleware'
import { APP, createFakeApi, createSigner, type Signer } from './testing/keys'

// A role too large for the token: the token names it by version and hash (ADR 0068, § 5).
const PERMS = ['org:leads:view', 'org:leads:edit']
const LOOKUP = {
  org_id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  org_role: 'iso_manager',
  org_rv: 7,
  org_ph: '',
}
const PATH = 'GET /v1/client/me/organizations/active/permissions'

let signer: Signer
beforeAll(async () => {
  signer = await createSigner('key-1')
  LOOKUP.org_ph = await permissionsHash(PERMS)
})

async function setup(reply?: () => Response) {
  const api = createFakeApi([signer])
  api.on(
    PATH,
    reply ??
      (() =>
        Response.json({ role: 'iso_manager', version: 7, permissions: PERMS, hash: LOOKUP.org_ph }))
  )
  const cookie = `tula_at=${await signer.sign(LOOKUP)}`
  // One middleware per permission, as an app has: each keeps its own checker and cache.
  const guards = new Map<string, ReturnType<typeof tulaMiddleware>>()
  const guard = (permission: string) => {
    if (!guards.has(permission)) {
      guards.set(
        permission,
        tulaMiddleware({
          ...api.options,
          publicRoutes: ['/'],
          access: [{ routes: '/leads(.*)', permission }],
        })
      )
    }
    return (guards.get(permission) as ReturnType<typeof tulaMiddleware>)(
      new NextRequest(`${APP}/leads`, { headers: { cookie } })
    )
  }
  return { api, cookie, guard }
}

describe('a token whose role is looked up', () => {
  test('the middleware allows a permission the role holds and refuses one it does not', async () => {
    const { guard, api } = await setup()
    expect((await guard('org:leads:view')).headers.get('x-middleware-next')).toBe('1')
    expect((await guard('org:leads:view')).headers.get('x-middleware-next')).toBe('1')
    expect(api.count('/v1/client/me/organizations/active/permissions')).toBe(1)
    expect((await guard('org:leads:view')).headers.get('x-middleware-next')).toBe('1')
    expect(api.count('/v1/client/me/organizations/active/permissions')).toBe(1) // cached by hash
    expect((await guard('org:leads:delete')).status).toBe(403)
  })

  test('a lookup that fails is an error, never an allowed request', async () => {
    const { guard } = await setup(() => new Response('no', { status: 500 }))
    await expect(guard('org:leads:view')).rejects.toThrow('access lookup')
  })

  test('the synchronous has() of auth() is false: it cannot wait for a lookup', async () => {
    const { api, cookie } = await setup()
    const auth = await authenticate(new Request(`${APP}/x`, { headers: { cookie } }), api.options)
    expect(auth.isSignedIn).toBe(true)
    expect(auth.has({ permission: 'org:leads:view' })).toBe(false)
    expect(auth.has({ role: 'iso_manager' })).toBe(false)
  })
})
