import { describe, expect, spyOn, test } from 'bun:test'
import { permissionsHash } from '@tula-tech/contract/custom-claims'
import { environmentIssuer } from '@tula-tech/contract/issuer'
import { AccessUnavailableError, createAccessChecker } from './access'

const API = 'https://auth.example.com'
const ENV = 'env_1'
const ISS = environmentIssuer(API, ENV)
const ORG = 'org_1'

const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' }

const b64 = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function mint(
  claims: Record<string, unknown>,
  over: { iss?: string; exp?: number; kid?: string } = {}
) {
  const header = b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: over.kid ?? 'k1' }))
  const payload = b64(
    JSON.stringify({
      iss: over.iss ?? ISS,
      aud: ENV,
      sub: 'u1',
      sid: 's1',
      exp: over.exp ?? Math.floor(Date.now() / 1000) + 60,
      ...claims,
    })
  )
  const sig = await crypto.subtle.sign(
    'Ed25519',
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`)
  )
  return `${header}.${payload}.${b64(new Uint8Array(sig))}`
}

const PERMS = ['org:leads:view', 'org:leads:edit']

async function lookupToken(perms = PERMS) {
  return mint({
    org_id: ORG,
    org_role: 'iso_manager',
    org_rv: 7,
    org_ph: await permissionsHash(perms),
  })
}

type Reply = () => Response | Promise<Response>
function setup(
  opts: {
    permissions?: unknown
    hash?: string
    reply?: Reply
    cacheBytes?: number
    timeoutMs?: number
  } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/.well-known/jwks.json')) {
      return Response.json({ keys: [jwk] })
    }
    if (opts.reply) {
      return opts.reply()
    }
    const permissions = opts.permissions ?? PERMS
    return Response.json({
      role: 'iso_manager',
      version: 7,
      permissions,
      hash: opts.hash ?? (await permissionsHash(permissions as string[])),
    })
  }) as typeof fetch
  const access = createAccessChecker({
    apiUrl: API,
    environmentId: ENV,
    publishableKey: 'tula_pk_dev_x',
    fetch: fetchFake,
    cacheBytes: opts.cacheBytes,
    timeoutMs: opts.timeoutMs,
  })
  const lookups = () => calls.filter((c) => c.url.includes('/permissions'))
  return { access, calls, lookups }
}

describe('createAccessChecker', () => {
  test('inline: grants and denies offline, no lookup', async () => {
    const { access, lookups } = setup()
    const token = await mint({ org_id: ORG, org_role: 'admin', org_perms: ['org:billing:read'] })
    expect(await access.check(token, 'org:billing:read')).toEqual({
      allowed: true,
      orgId: ORG,
      role: 'admin',
      version: undefined,
    })
    expect(await access.check(token, 'org:billing:write')).toEqual({
      allowed: false,
      reason: 'not_granted',
    })
    expect(lookups()).toHaveLength(0)
  })

  test('no organization', async () => {
    const { access } = setup()
    expect(await access.check(await mint({}), 'org:a:b')).toEqual({
      allowed: false,
      reason: 'no_organization',
    })
  })

  test('lookup: grants and denies, calling the route with the token and key', async () => {
    const { access, lookups } = setup()
    const token = await lookupToken()
    expect(await access.check(token, 'org:leads:view')).toEqual({
      allowed: true,
      orgId: ORG,
      role: 'iso_manager',
      version: 7,
    })
    expect(await access.check(token, 'org:leads:delete')).toEqual({
      allowed: false,
      reason: 'not_granted',
    })
    expect(lookups()).toHaveLength(1)
    expect(lookups()[0]?.url).toBe(`${API}/v1/client/me/organizations/active/permissions`)
    const headers = lookups()[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${token}`)
    expect(headers['x-tula-publishable-key']).toBe('tula_pk_dev_x')
  })

  test('concurrent checks share one request', async () => {
    const { access, lookups } = setup()
    const token = await lookupToken()
    const all = await Promise.all(
      Array.from({ length: 10 }, () => access.check(token, 'org:leads:view'))
    )
    expect(all.every((d) => d.allowed)).toBe(true)
    expect(lookups()).toHaveLength(1)
  })

  test('a cached hash serves a second user with no fetch', async () => {
    const { access, lookups } = setup()
    await access.check(await lookupToken(), 'org:leads:view')
    const other = await mint({
      sub: 'u2',
      org_id: 'org_2',
      org_role: 'iso_manager',
      org_rv: 7,
      org_ph: await permissionsHash(PERMS),
    })
    expect((await access.check(other, 'org:leads:edit')).allowed).toBe(true)
    expect(lookups()).toHaveLength(1)
  })

  test('a list that does not hash to org_ph throws and is not cached', async () => {
    let poisoned = true
    const { access, lookups } = setup({
      reply: async () =>
        Response.json({
          role: 'iso_manager',
          version: 7,
          permissions: poisoned ? ['org:leads:view', 'org:sys:organization:delete'] : PERMS,
          hash: await permissionsHash(
            poisoned ? ['org:leads:view', 'org:sys:organization:delete'] : PERMS
          ),
        }),
    })
    const token = await lookupToken()
    await expect(access.check(token, 'org:leads:view')).rejects.toBeInstanceOf(
      AccessUnavailableError
    )
    poisoned = false
    expect((await access.check(token, 'org:leads:view')).allowed).toBe(true)
    expect(lookups()).toHaveLength(2)
  })

  test('a reply whose hash field differs from org_ph throws', async () => {
    const { access } = setup({ hash: await permissionsHash(['org:x:y']) })
    await expect(access.check(await lookupToken(), 'org:leads:view')).rejects.toBeInstanceOf(
      AccessUnavailableError
    )
  })

  test('a key outside the grammar throws', async () => {
    const bad = ['org:leads:view', 'Billing.Read']
    const { access } = setup({ permissions: bad })
    await expect(access.check(await lookupToken(bad), 'org:leads:view')).rejects.toBeInstanceOf(
      AccessUnavailableError
    )
  })

  test('500 throws and a malformed body throws', async () => {
    const a = setup({ reply: () => new Response('no', { status: 500 }) })
    await expect(a.access.check(await lookupToken(), 'org:leads:view')).rejects.toBeInstanceOf(
      AccessUnavailableError
    )
    const b = setup({ reply: () => new Response('not json') })
    await expect(b.access.check(await lookupToken(), 'org:leads:view')).rejects.toBeInstanceOf(
      AccessUnavailableError
    )
  })

  test('a timeout throws', async () => {
    const { access } = setup({
      timeoutMs: 20,
      reply: () => new Promise<Response>(() => {}),
    })
    await expect(access.check(await lookupToken(), 'org:leads:view')).rejects.toBeInstanceOf(
      AccessUnavailableError
    )
  })

  test('wrong issuer, expired, bad signature and garbage are invalid_token', async () => {
    const { access, calls } = setup()
    const invalid = { allowed: false, reason: 'invalid_token' } as const
    const claims = { org_id: ORG, org_role: 'admin', org_perms: ['org:billing:read'] }
    expect(
      await access.check(
        await mint(claims, { iss: 'https://evil.example/v1/environments/env_1' }),
        'org:billing:read'
      )
    ).toEqual(invalid)
    expect(
      await access.check(
        await mint(claims, { exp: Math.floor(Date.now() / 1000) - 60 }),
        'org:billing:read'
      )
    ).toEqual(invalid)
    const good = await mint(claims)
    const tampered = `${good.slice(0, good.lastIndexOf('.') + 1)}${b64(new Uint8Array(64))}`
    expect(await access.check(tampered, 'org:billing:read')).toEqual(invalid)
    expect(await access.check('garbage', 'org:billing:read')).toEqual(invalid)
    expect(calls.every((c) => c.url.startsWith(API))).toBe(true)
  })

  test('an unknown kid inside the refetch cooldown is unavailable, after a real refetch invalid', async () => {
    const { access } = setup()
    const claims = { org_id: ORG, org_role: 'admin', org_perms: ['org:a:b'] }
    const fresh = await mint(claims, { kid: 'k2' })
    // The first lookup is a real refetch, and k2 is not in it.
    expect(await access.check(fresh, 'org:a:b')).toEqual({
      allowed: false,
      reason: 'invalid_token',
    })
    // A second one is inside the cooldown: the key may be new, so ask the caller to retry.
    expect(access.check(fresh, 'org:a:b')).rejects.toBeInstanceOf(AccessUnavailableError)
  })

  test('a token that is not yet valid (nbf) is invalid_token, within 5 seconds of skew', async () => {
    const { access } = setup()
    const now = Math.floor(Date.now() / 1000)
    const claims = { org_id: ORG, org_role: 'admin', org_perms: ['org:a:b'] }
    expect((await access.check(await mint({ ...claims, nbf: now + 60 }), 'org:a:b')).allowed).toBe(
      false
    )
    expect((await access.check(await mint({ ...claims, nbf: now + 3 }), 'org:a:b')).allowed).toBe(
      true
    )
  })

  test('one key that cannot be imported does not drop the others', async () => {
    const bad = { kty: 'OKP', crv: 'Ed25519', kid: 'bad', x: 'AAAA' }
    const access = createAccessChecker({
      apiUrl: API,
      environmentId: ENV,
      publishableKey: 'tula_pk_dev_x',
      fetch: (async () => Response.json({ keys: [bad, jwk] })) as unknown as typeof fetch,
    })
    const token = await mint({ org_id: ORG, org_role: 'admin', org_perms: ['org:a:b'] })
    expect((await access.check(token, 'org:a:b')).allowed).toBe(true)
  })

  test('the cache is bounded in bytes, least recently used out', async () => {
    const { access, lookups } = setup({ cacheBytes: 1 })
    const token = await lookupToken()
    await access.check(token, 'org:leads:view')
    await access.check(token, 'org:leads:view')
    expect(lookups()).toHaveLength(2)

    const two = [
      await lookupToken(['org:a:b']),
      await lookupToken(['org:c:d']),
      await lookupToken(['org:e:f']),
    ]
    const reply = (perms: string[]) => async () =>
      Response.json({
        role: 'iso_manager',
        version: 7,
        permissions: perms,
        hash: await permissionsHash(perms),
      })
    let current: string[] = []
    const s = setup({ cacheBytes: 400, reply: () => reply(current)() })
    for (const [i, perms] of [['org:a:b'], ['org:c:d'], ['org:e:f']].entries()) {
      current = perms
      await s.access.check(two[i] as string, perms[0] as string)
    }
    const before = s.lookups().length
    await s.access.check(two[2] as string, 'org:e:f')
    expect(s.lookups()).toHaveLength(before)
    current = ['org:a:b']
    await s.access.check(two[0] as string, 'org:a:b')
    expect(s.lookups()).toHaveLength(before + 1)
  })
})

describe('access.apply: closing the window with webhooks', () => {
  const nowIso = () => new Date().toISOString()
  const event = (type: string, target: string, data: Record<string, unknown>, at = nowIso()) => ({
    id: 'evt_1',
    type,
    schemaVersion: 1,
    occurredAt: at,
    actor: { type: 'admin', id: null },
    target: { type: 'x', id: target },
    data,
  })

  /** A checker whose `/latest` answers with `latest`; the other lookup answers with `PERMS`. */
  function withLatest(
    latest: { version: number; permissions: string[] } | 'fail',
    cacheBytes?: number
  ) {
    const calls: string[] = []
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/.well-known/jwks.json')) {
        return Response.json({ keys: [jwk] })
      }
      if (url.endsWith('/latest')) {
        if (latest === 'fail') {
          return new Response(null, { status: 503 })
        }
        return Response.json({
          role: 'iso_manager',
          version: latest.version,
          permissions: latest.permissions,
          hash: await permissionsHash(latest.permissions),
        })
      }
      return Response.json({
        role: 'iso_manager',
        version: 7,
        permissions: PERMS,
        hash: await permissionsHash(PERMS),
      })
    }) as typeof fetch
    const access = createAccessChecker({
      apiUrl: API,
      environmentId: ENV,
      publishableKey: 'tula_pk_dev_x',
      fetch: fetchFake,
      cacheBytes,
    })
    return {
      access,
      latestCalls: () => calls.filter((u) => u.endsWith('/latest')),
      listCalls: () => calls.filter((u) => u.endsWith('/permissions')),
    }
  }

  const roleUpdated = (version: number, data: Record<string, unknown> = {}) =>
    event('organization_role.updated', 'role_1', {
      role: 'iso_manager',
      version,
      hash: '1.x',
      changed: ['permissions'],
      permissions: 1,
      ...data,
    })

  test('a removed permission is denied right after the event, with one lookup', async () => {
    const { access, latestCalls } = withLatest({ version: 8, permissions: ['org:leads:view'] })
    const token = await lookupToken()
    expect((await access.check(token, 'org:leads:edit')).allowed).toBe(true)
    access.apply(roleUpdated(8))
    expect(await access.check(token, 'org:leads:edit')).toEqual({
      allowed: false,
      reason: 'not_granted',
    })
    expect((await access.check(token, 'org:leads:view')).allowed).toBe(true)
    expect(latestCalls()).toHaveLength(1)
  })

  test('an added permission is not granted until the token is refreshed', async () => {
    const { access } = withLatest({
      version: 8,
      permissions: [...PERMS, 'org:leads:delete'],
    })
    const token = await lookupToken()
    access.apply(roleUpdated(8))
    expect((await access.check(token, 'org:leads:delete')).allowed).toBe(false)
    expect((await access.check(token, 'org:leads:view')).allowed).toBe(true)
  })

  test('a lost webhook leaves the token valid until it expires, then it is invalid', async () => {
    const { access, latestCalls } = withLatest({ version: 8, permissions: [] })
    const live = await lookupToken()
    expect((await access.check(live, 'org:leads:edit')).allowed).toBe(true)
    expect(latestCalls()).toHaveLength(0)
    const expired = await mint(
      { org_id: ORG, org_role: 'iso_manager', org_rv: 7, org_ph: await permissionsHash(PERMS) },
      { exp: Math.floor(Date.now() / 1000) - 60 }
    )
    expect(await access.check(expired, 'org:leads:edit')).toEqual({
      allowed: false,
      reason: 'invalid_token',
    })
  })

  test('a failed latest lookup is unavailable, never allowed', async () => {
    const { access } = withLatest('fail')
    const token = await lookupToken()
    access.apply(roleUpdated(8))
    await expect(access.check(token, 'org:leads:view')).rejects.toBeInstanceOf(
      AccessUnavailableError
    )
  })

  test('a removed membership and a revoked session are denied; others are not', async () => {
    const { access } = withLatest({ version: 7, permissions: PERMS })
    const token = await lookupToken()
    const other = await mint({
      sub: 'u2',
      sid: 's2',
      org_id: ORG,
      org_role: 'a',
      org_perms: ['org:a:b'],
    })
    access.apply(
      event('organization_membership.removed', 'm1', {
        organizationId: ORG,
        userId: 'u1',
        role: 'iso_manager',
      })
    )
    expect(await access.check(token, 'org:leads:view')).toEqual({
      allowed: false,
      reason: 'not_granted',
    })
    expect((await access.check(other, 'org:a:b')).allowed).toBe(true)
    access.apply(event('session.revoked', 's2', { userId: 'u2', reason: 'sign_out' }))
    expect((await access.check(other, 'org:a:b')).allowed).toBe(false)
  })

  test('a role change denies the older tokens of that member until they refresh', async () => {
    const { access } = withLatest({ version: 7, permissions: PERMS })
    const old = await mint({
      iat: Math.floor(Date.now() / 1000) - 30,
      org_id: ORG,
      org_role: 'admin',
      org_perms: ['org:a:b'],
    })
    access.apply(
      event('organization_membership.role_changed', 'm1', {
        organizationId: ORG,
        userId: 'u1',
        role: 'viewer',
        previousRole: 'admin',
      })
    )
    expect((await access.check(old, 'org:a:b')).allowed).toBe(false)
    const fresh = await mint({
      iat: Math.floor(Date.now() / 1000) + 5,
      org_id: ORG,
      org_role: 'viewer',
      org_perms: ['org:a:b'],
    })
    expect((await access.check(fresh, 'org:a:b')).allowed).toBe(true)
  })

  test('forged, unknown and test events can only deny, and a test event does nothing', async () => {
    const { access, latestCalls } = withLatest({ version: 7, permissions: PERMS })
    const token = await lookupToken()
    for (const junk of [
      null,
      'x',
      {},
      event('user.created', 'u1', { userId: 'u1' }),
      event('organization_role.updated', 'r', {
        role: 5,
        version: 'x',
        permissions: ['org:leads:delete'],
      }),
      event('organization_membership.removed', 'm', { userId: 3 }),
      event('session.revoked', '', {}),
      {
        ...event('organization_membership.removed', 'm', { organizationId: ORG, userId: 'u1' }),
        test: true,
      },
    ]) {
      access.apply(junk)
    }
    expect(await access.check(token, 'org:leads:delete')).toEqual({
      allowed: false,
      reason: 'not_granted',
    })
    expect((await access.check(token, 'org:leads:view')).allowed).toBe(true)
    expect(latestCalls()).toHaveLength(0)
  })

  test('a denial lapses after 15 minutes, the longest an access token lives', async () => {
    const { access } = withLatest({ version: 7, permissions: PERMS })
    const token = await mint(
      { org_id: ORG, org_role: 'a', org_perms: ['org:a:b'] },
      { exp: Math.floor(Date.now() / 1000) + 3600 }
    )
    access.apply(event('session.revoked', 's1', { userId: 'u1', reason: 'sign_out' }))
    expect((await access.check(token, 'org:a:b')).allowed).toBe(false)
    const real = Date.now()
    const spy = spyOn(Date, 'now').mockReturnValue(real + 15 * 60_000 + 1000)
    try {
      expect((await access.check(token, 'org:a:b')).allowed).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  test('a late role_changed does not lift an earlier removal', async () => {
    const { access } = withLatest({ version: 7, permissions: PERMS })
    const token = await mint({
      iat: Math.floor(Date.now() / 1000),
      org_id: ORG,
      org_role: 'a',
      org_perms: ['org:a:b'],
    })
    const data = { organizationId: ORG, userId: 'u1' }
    access.apply(event('organization_membership.removed', 'm1', data))
    access.apply(
      event('organization_membership.role_changed', 'm1', data, new Date(0).toISOString())
    )
    expect((await access.check(token, 'org:a:b')).allowed).toBe(false)
  })

  test('remembering a key twice does not double its bytes', async () => {
    const hash = await permissionsHash(PERMS)
    const size = (key: string) => key.length * 2 + PERMS.reduce((n, p) => n + p.length * 2, 0)
    const max = size(`${ISS}|${hash}`) + size(`${ISS}|iso_manager|9`)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let listFetches = 0
    const fetchFake = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/.well-known/jwks.json')) {
        return Response.json({ keys: [jwk] })
      }
      if (url.endsWith('/latest')) {
        await gate
      } else {
        listFetches++
      }
      return Response.json({ role: 'iso_manager', version: 9, permissions: PERMS, hash })
    }) as typeof fetch
    const access = createAccessChecker({
      apiUrl: API,
      environmentId: ENV,
      publishableKey: 'tula_pk_dev_x',
      fetch: fetchFake,
      cacheBytes: max,
    })
    const token = await lookupToken()
    await access.check(token, 'org:leads:view')
    access.apply(roleUpdated(8))
    const first = access.check(token, 'org:leads:view')
    await Bun.sleep(5)
    access.apply(roleUpdated(10)) // a second flight, which the server also answers with 9
    const second = access.check(token, 'org:leads:view')
    await Bun.sleep(5)
    release()
    await Promise.all([first, second])
    const before = listFetches
    await access.check(token, 'org:leads:view')
    expect(listFetches).toBe(before)
  })

  test('the deny maps are bounded: the oldest entry goes past the cap', async () => {
    const { access } = withLatest({ version: 7, permissions: PERMS })
    for (let i = 0; i <= 10_000; i++) {
      access.apply(event('session.revoked', `s${i}`, {}))
    }
    const claims = { org_id: ORG, org_role: 'a', org_perms: ['org:a:b'] }
    expect((await access.check(await mint({ ...claims, sid: 's0' }), 'org:a:b')).allowed).toBe(true)
    expect((await access.check(await mint({ ...claims, sid: 's10000' }), 'org:a:b')).allowed).toBe(
      false
    )
  })
})
