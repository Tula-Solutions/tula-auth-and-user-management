import { describe, expect, test } from 'bun:test'
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

async function mint(claims: Record<string, unknown>, over: { iss?: string; exp?: number } = {}) {
  const header = b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' }))
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
