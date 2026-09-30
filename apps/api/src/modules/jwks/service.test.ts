import { beforeEach, describe, expect, test } from 'bun:test'
import { ACCESS_TOKEN_VERSION, environmentIssuer } from '@tula/contract'
import { SignJWT } from 'jose'
import type { Tenant } from '~/dependencies'
import { ConflictError, NotFoundError } from '~/exceptions'
import { verifyAccessToken } from '~/middleware/session-auth'
import * as Jwks from '~/modules/jwks/service'
import { RETIRED_KEY_RETENTION_MS } from '~/ports/signing-key-store'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

let deps: TestDeps
const tenant: Tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: '00000000-0000-7000-8000-00000000c0de',
}

beforeEach(() => {
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
})

async function statuses(environmentId: string = tenant.environmentId) {
  return (await deps.signingKeys.list(environmentId)).map((key) => key.status).sort()
}

async function signWith(key: { kid: string; privateKey: CryptoKey }) {
  const iat = Math.floor(deps.clock.now().getTime() / 1000)
  return new SignJWT({
    sid: 's1',
    pid: tenant.projectId,
    eid: tenant.environmentId,
    v: ACCESS_TOKEN_VERSION,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .setIssuer(environmentIssuer(deps.config.publicUrl, tenant.environmentId))
    .setAudience(tenant.environmentId)
    .setSubject('user-1')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .sign(key.privateKey)
}

describe('ensureKeys', () => {
  test('bootstraps one active and one next key', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    expect(await statuses()).toEqual(['active', 'next'])
  })

  test('is idempotent', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    await Jwks.ensureKeys(deps, tenant.environmentId)
    expect(await statuses()).toEqual(['active', 'next'])
  })

  test('concurrent bootstraps leave exactly one active key', async () => {
    await Promise.all([
      Jwks.ensureKeys(deps, tenant.environmentId),
      Jwks.ensureKeys(deps, tenant.environmentId),
      Jwks.ensureKeys(deps, tenant.environmentId),
    ])
    expect(await statuses()).toEqual(['active', 'next'])
  })

  test('stores the private key encrypted, bound to its row', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    const [key] = await deps.signingKeys.list(tenant.environmentId)
    expect(key?.privateKeyCiphertext).toMatch(/^v1\./)
    expect(key?.privateKeyCiphertext).not.toContain('PRIVATE')
    const aad = Jwks.ciphertextAad(key?.id ?? '', tenant.environmentId)
    const pkcs8 = await deps.secretBox.open(
      Jwks.SECRET_BOX_PURPOSE,
      key?.privateKeyCiphertext ?? '',
      aad
    )
    expect(pkcs8.byteLength).toBeGreaterThan(32)
    await expect(
      deps.secretBox.open(Jwks.SECRET_BOX_PURPOSE, key?.privateKeyCiphertext ?? '', `${aad}x`)
    ).rejects.toThrow()
  })

  test('publishes only public Ed25519 JWKs', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    for (const key of await deps.signingKeys.list(tenant.environmentId)) {
      expect(Object.keys(key.publicJwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x'])
      expect(key.publicJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', kid: key.id })
    }
  })

  test('rejects an unknown environment', async () => {
    await expect(
      Jwks.ensureKeys(deps, '00000000-0000-7000-8000-0000000000ff')
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('activeSigningKey', () => {
  test('bootstraps on first use and signs tokens that sessionAuth accepts', async () => {
    const key = await Jwks.activeSigningKey(deps, tenant.environmentId)
    const claims = await verifyAccessToken(deps, await signWith(key), tenant)
    expect(claims.sub).toBe('user-1')
  })

  test('returns the same key until rotation', async () => {
    const a = await Jwks.activeSigningKey(deps, tenant.environmentId)
    const b = await Jwks.activeSigningKey(deps, tenant.environmentId)
    expect(b.kid).toBe(a.kid)
  })

  test('the private key cannot be exported from memory', async () => {
    const { privateKey } = await Jwks.activeSigningKey(deps, tenant.environmentId)
    expect(privateKey.extractable).toBe(false)
    expect(privateKey.usages).toEqual(['sign'])
  })
})

describe('ciphertext binding', () => {
  test('a ciphertext copied into another environment’s row does not sign, even when cached', async () => {
    deps.environments.add({
      id: TEST_TENANT.productionEnvironmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'production',
      createdAt: deps.clock.now(),
    })
    // Decrypt and cache environment A's active key.
    await Jwks.activeSigningKey(deps, tenant.environmentId)
    const [stolen] = (await deps.signingKeys.list(tenant.environmentId)).filter(
      (key) => key.status === 'active'
    )
    // Someone with database write access copies it into environment B.
    await deps.signingKeys.insert(TEST_TENANT.productionEnvironmentId, [
      {
        ...(stolen as NonNullable<typeof stolen>),
        id: '00000000-0000-7000-8000-00000000beef',
        environmentId: TEST_TENANT.productionEnvironmentId,
      },
    ])
    await expect(Jwks.activeSigningKey(deps, TEST_TENANT.productionEnvironmentId)).rejects.toThrow()
  })
})

describe('publicKeySet', () => {
  test('bootstraps keys on first read, so a verifier never caches an empty set', async () => {
    const set = await Jwks.publicKeySet(deps, tenant.environmentId)
    expect(set.keys).toHaveLength(2)
    const first = await Jwks.activeSigningKey(deps, tenant.environmentId)
    expect(set.keys.map((key) => key.kid)).toContain(first.kid)
  })

  test('serves the environment’s next and active keys', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    const set = await Jwks.publicKeySet(deps, tenant.environmentId)
    expect(set.keys).toHaveLength(2)
    expect(JSON.stringify(set)).not.toMatch(/"d"/)
  })

  test('404s for an unknown environment', async () => {
    await expect(
      Jwks.publicKeySet(deps, '00000000-0000-7000-8000-0000000000ff')
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('rotate', () => {
  test('refuses while the next key is too new for caches to have seen it', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    deps.clock.advance(Jwks.NEXT_KEY_MIN_AGE_MS - 1000)
    const attempt = Jwks.rotate(deps, tenant)
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    await expect(attempt).rejects.toMatchObject({ params: { retryAfter: 1 } })
  })

  test('next → active, active → retired, and a new next key', async () => {
    const before = await Jwks.activeSigningKey(deps, tenant.environmentId)
    const [next] = (await deps.signingKeys.list(tenant.environmentId)).filter(
      (key) => key.status === 'next'
    )
    deps.clock.advance(Jwks.NEXT_KEY_MIN_AGE_MS)
    const keys = await Jwks.rotate(deps, tenant)
    expect(keys.map((key) => key.status)).toEqual(['next', 'active', 'retired'])
    const after = await Jwks.activeSigningKey(deps, tenant.environmentId)
    expect(after.kid).toBe(next?.id ?? '')
    expect(after.kid).not.toBe(before.kid)
  })

  test('tokens from the retired key verify until the retention window ends', async () => {
    const old = await Jwks.activeSigningKey(deps, tenant.environmentId)
    deps.clock.advance(Jwks.NEXT_KEY_MIN_AGE_MS)
    const token = await signWith(old)
    await Jwks.rotate(deps, tenant)
    expect((await verifyAccessToken(deps, token, tenant)).sub).toBe('user-1')
    deps.clock.advance(RETIRED_KEY_RETENTION_MS)
    const later = await signWith(old)
    await expect(verifyAccessToken(deps, later, tenant)).rejects.toMatchObject({
      code: 'session.invalid_token',
    })
  })

  test('a concurrent rotation loses cleanly instead of corrupting state', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    deps.clock.advance(Jwks.NEXT_KEY_MIN_AGE_MS)
    const results = await Promise.allSettled([Jwks.rotate(deps, tenant), Jwks.rotate(deps, tenant)])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason
    ).toBeInstanceOf(ConflictError)
    expect(await statuses()).toEqual(['active', 'next', 'retired'])
  })

  test('bootstraps an environment with no keys before rotating', async () => {
    const attempt = Jwks.rotate(deps, tenant)
    await expect(attempt).rejects.toBeInstanceOf(ConflictError)
    expect(await statuses()).toEqual(['active', 'next'])
  })
})

describe('listKeys', () => {
  test('lists lifecycle metadata without key material', async () => {
    await Jwks.ensureKeys(deps, tenant.environmentId)
    const keys = await Jwks.listKeys(deps, tenant)
    expect(Object.keys(keys[0] ?? {}).sort()).toEqual([
      'activatedAt',
      'createdAt',
      'id',
      'retiredAt',
      'status',
    ])
  })
})

describe('ensureAllEnvironments', () => {
  test('bootstraps every environment and survives one failing', async () => {
    deps.environments.add({
      id: TEST_TENANT.productionEnvironmentId,
      projectId: TEST_TENANT.projectId,
      kind: 'production',
      createdAt: deps.clock.now(),
    })
    const insert = deps.signingKeys.insert.bind(deps.signingKeys)
    deps.signingKeys.insert = async (environmentId, keys) => {
      if (environmentId === TEST_TENANT.productionEnvironmentId) {
        throw new Error('database down')
      }
      return insert(environmentId, keys)
    }
    expect(await Jwks.ensureAllEnvironments(deps)).toEqual({ ensured: 1, failed: 1 })
    expect(await statuses()).toEqual(['active', 'next'])
  })
})
