import { describe, expect, test } from 'bun:test'
import { sha256Hex } from '~/lib/crypto'
import {
  DASHBOARD_SESSION_LEEWAY_MS,
  DASHBOARD_SESSION_PURPOSE,
  DASHBOARD_SESSION_TTL_MS,
  mintDashboardSession,
  verifyDashboardSession,
} from '~/lib/dashboard-session'
import { createKeyedHash } from '~/lib/keyed-hash'
import { createInstanceTestDeps, TEST_CONFIG, TEST_MASTER_KEY, type TestDeps } from '~/testing'

// The signed cookie value by itself, without a route around it: what verifies, and every way
// a value does not.

const SID = '00000000-0000-7000-8000-0000000000aa'

/** Sign a payload exactly as the library does, so a test can make a "correctly signed" lie. */
async function signed(deps: TestDeps, claims: unknown, version = 'v1'): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const mac = await deps.keyedHash.hmac(
    DASHBOARD_SESSION_PURPOSE,
    `${version}.${payload}.${deps.config.instanceAdminTokenHash}`
  )
  return `${version}.${payload}.${mac}`
}

function seconds(deps: TestDeps): number {
  return Math.floor(deps.clock.now().getTime() / 1000)
}

describe('mintDashboardSession', () => {
  test('a minted value verifies and names its session and its end', async () => {
    const deps = createInstanceTestDeps()
    const { value, session } = await mintDashboardSession(deps, SID)
    expect(value).toMatch(/^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/)
    expect(session.id).toBe(SID)
    expect(session.expiresAt.getTime()).toBe(seconds(deps) * 1000 + DASHBOARD_SESSION_TTL_MS)
    expect(await verifyDashboardSession(deps, value)).toEqual(session)
  })

  test('nothing derived from the admin token is in the value', async () => {
    const deps = createInstanceTestDeps()
    const { value } = await mintDashboardSession(deps, SID)
    const [, payload = ''] = value.split('.')
    const text = Buffer.from(payload, 'base64url').toString('utf8')
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['exp', 'iat', 'sid'])
    expect(value).not.toContain(deps.config.instanceAdminTokenHash ?? '')
    expect(text).not.toContain((deps.config.instanceAdminTokenHash ?? '').slice(0, 16))
  })

  test('a deployment without an admin token mints nothing and verifies nothing', async () => {
    const withToken = createInstanceTestDeps()
    const { value } = await mintDashboardSession(withToken, SID)
    const without = createInstanceTestDeps()
    without.config = { ...without.config, instanceAdminTokenHash: null }
    expect(mintDashboardSession(without, SID)).rejects.toThrow()
    expect(await verifyDashboardSession(without, value)).toBeNull()
  })
})

describe('verifyDashboardSession', () => {
  test('a missing or empty value is no session', async () => {
    const deps = createInstanceTestDeps()
    expect(await verifyDashboardSession(deps, undefined)).toBeNull()
    expect(await verifyDashboardSession(deps, '')).toBeNull()
  })

  test('any change to the payload or the MAC is refused', async () => {
    const deps = createInstanceTestDeps()
    const { value } = await mintDashboardSession(deps, SID)
    const [version = '', payload = '', mac = ''] = value.split('.')
    const flip = (text: string, at: number) =>
      `${text.slice(0, at)}${text[at] === 'a' ? 'b' : 'a'}${text.slice(at + 1)}`
    const longer = Buffer.from(
      JSON.stringify({ sid: SID, iat: seconds(deps), exp: seconds(deps) + 10 * 365 * 86_400 })
    ).toString('base64url')
    for (const forged of [
      `${version}.${flip(payload, 3)}.${mac}`,
      `${version}.${longer}.${mac}`,
      `${version}.${payload}.${flip(mac, 0)}`,
      `${version}.${payload}.${flip(mac, 63)}`,
      `${version}.${payload}.${mac.slice(0, -1)}`,
      `${version}.${payload}.${mac}0`,
      `${version}.${payload}.${mac.toUpperCase()}`,
      `${version}.${payload}.`,
      `${version}.${payload}`,
      `${version}..${mac}`,
      `${payload}.${mac}`,
      `${value}.extra`,
    ]) {
      expect(await verifyDashboardSession(deps, forged), forged).toBeNull()
    }
    expect(await verifyDashboardSession(deps, value)).not.toBeNull()
  })

  test('another version is refused, even when signed with the right key', async () => {
    const deps = createInstanceTestDeps()
    const claims = { sid: SID, iat: seconds(deps), exp: seconds(deps) + 3600 }
    expect(await verifyDashboardSession(deps, await signed(deps, claims))).not.toBeNull()
    expect(await verifyDashboardSession(deps, await signed(deps, claims, 'v2'))).toBeNull()
    expect(await verifyDashboardSession(deps, await signed(deps, claims, 'v0'))).toBeNull()
    // A v2 MAC under a v1 label does not verify either: the version is part of what is signed.
    const [, payload, mac] = (await signed(deps, claims, 'v2')).split('.')
    expect(await verifyDashboardSession(deps, `v1.${payload}.${mac}`)).toBeNull()
  })

  test('it ends at its expiry, to the second, and is not valid before it was issued', async () => {
    const deps = createInstanceTestDeps()
    const { value } = await mintDashboardSession(deps, SID)
    deps.clock.advance(DASHBOARD_SESSION_TTL_MS - 1000)
    expect(await verifyDashboardSession(deps, value)).not.toBeNull()
    deps.clock.advance(1000)
    expect(await verifyDashboardSession(deps, value)).toBeNull()

    const fresh = createInstanceTestDeps()
    const now = seconds(fresh)
    // Issued in the future (a clock that ran ahead, or a forged payload with the key).
    const future = await signed(fresh, { sid: SID, iat: now + 60, exp: now + 3600 })
    expect(await verifyDashboardSession(fresh, future)).toBeNull()
    fresh.clock.advance(61_000)
    expect(await verifyDashboardSession(fresh, future)).not.toBeNull()
  })

  test('an instance whose clock is a little behind the one that signed accepts the session', async () => {
    // Two instances behind one address: one mints, the next request lands on the other.
    const minter = createInstanceTestDeps()
    const { value, session } = await mintDashboardSession(minter, SID)
    const behind = createInstanceTestDeps()
    behind.clock.set(new Date(minter.clock.now().getTime() - 2_000))
    expect(await verifyDashboardSession(behind, value)).toEqual(session)
    // Exactly at the allowance, and one second past it.
    behind.clock.set(new Date(minter.clock.now().getTime() - DASHBOARD_SESSION_LEEWAY_MS))
    expect(await verifyDashboardSession(behind, value)).not.toBeNull()
    behind.clock.set(new Date(minter.clock.now().getTime() - DASHBOARD_SESSION_LEEWAY_MS - 1000))
    expect(await verifyDashboardSession(behind, value)).toBeNull()
  })

  test('an instance a minute behind refuses it: the allowance is for drift, not for the future', async () => {
    const minter = createInstanceTestDeps()
    const { value } = await mintDashboardSession(minter, SID)
    const behind = createInstanceTestDeps()
    behind.clock.set(new Date(minter.clock.now().getTime() - 60_000))
    expect(await verifyDashboardSession(behind, value)).toBeNull()
  })

  test('the allowance does not move the end: a session expires on its own clock, to the second', async () => {
    const minter = createInstanceTestDeps()
    const { value } = await mintDashboardSession(minter, SID)
    const behind = createInstanceTestDeps()
    behind.clock.set(new Date(minter.clock.now().getTime() - 2_000))
    behind.clock.advance(DASHBOARD_SESSION_TTL_MS + 2_000 - 1000)
    expect(await verifyDashboardSession(behind, value)).not.toBeNull()
    behind.clock.advance(1000)
    expect(await verifyDashboardSession(behind, value)).toBeNull()
  })

  test('a correctly signed payload that claims more than eight hours is refused', async () => {
    const deps = createInstanceTestDeps()
    const now = seconds(deps)
    const ttl = DASHBOARD_SESSION_TTL_MS / 1000
    expect(
      await verifyDashboardSession(deps, await signed(deps, { sid: SID, iat: now, exp: now + ttl }))
    ).not.toBeNull()
    expect(
      await verifyDashboardSession(
        deps,
        await signed(deps, { sid: SID, iat: now, exp: now + ttl + 1 })
      )
    ).toBeNull()
  })

  test('a correctly signed payload that is not a session is refused', async () => {
    const deps = createInstanceTestDeps()
    const now = seconds(deps)
    for (const claims of [
      null,
      [],
      'text',
      {},
      { sid: '', iat: now, exp: now + 60 },
      { sid: 42, iat: now, exp: now + 60 },
      { sid: SID, iat: `${now}`, exp: now + 60 },
      { sid: SID, iat: now, exp: now + 0.5 },
      { sid: SID, iat: now },
      { sid: SID, iat: now, exp: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      expect(
        await verifyDashboardSession(deps, await signed(deps, claims)),
        JSON.stringify(claims)
      ).toBeNull()
    }
    const mac = await deps.keyedHash.hmac(
      DASHBOARD_SESSION_PURPOSE,
      `v1.not-json.${deps.config.instanceAdminTokenHash}`
    )
    expect(await verifyDashboardSession(deps, `v1.not-json.${mac}`)).toBeNull()
  })

  test('a value past the length cap is refused before anything is computed', async () => {
    const deps = createInstanceTestDeps()
    let hashed = 0
    const hmac = deps.keyedHash.hmac.bind(deps.keyedHash)
    deps.keyedHash = {
      hmac: (purpose, message) => {
        hashed += 1
        return hmac(purpose, message)
      },
    }
    // Correctly signed, and too long: a session id no real session has.
    const now = seconds(deps)
    const long = await signed(deps, { sid: 'x'.repeat(600), iat: now, exp: now + 60 })
    expect(long.length).toBeGreaterThan(512)
    hashed = 0
    expect(await verifyDashboardSession(deps, long)).toBeNull()
    expect(
      await verifyDashboardSession(deps, `v1.${'a'.repeat(100_000)}.${'0'.repeat(64)}`)
    ).toBeNull()
    expect(hashed).toBe(0)
    // Just under the cap still verifies.
    const under = await signed(deps, { sid: 'x'.repeat(200), iat: now, exp: now + 60 })
    expect(under.length).toBeLessThanOrEqual(512)
    expect(await verifyDashboardSession(deps, under)).not.toBeNull()
  })

  test('rotating the master key ends every session, and the old key does not come back by itself', async () => {
    const deps = createInstanceTestDeps()
    const { value } = await mintDashboardSession(deps, SID)
    const rotated = createInstanceTestDeps({ keyedHash: createKeyedHash('cd'.repeat(32)) })
    expect(await verifyDashboardSession(rotated, value)).toBeNull()
    // A session made under the new key verifies there, and not under the old one.
    const after = await mintDashboardSession(rotated, SID)
    expect(await verifyDashboardSession(rotated, after.value)).not.toBeNull()
    expect(await verifyDashboardSession(deps, after.value)).toBeNull()
    // Putting the old key back makes the old session verify again until it expires: rotation
    // is what ends sessions, so a key must not be rolled back to one an attacker's session
    // was made under.
    const back = createInstanceTestDeps({ keyedHash: createKeyedHash(TEST_MASTER_KEY) })
    expect(await verifyDashboardSession(back, value)).not.toBeNull()
  })

  test('rotating the admin token ends every session', async () => {
    const deps = createInstanceTestDeps()
    const { value } = await mintDashboardSession(deps, SID)
    const rotated = createInstanceTestDeps()
    rotated.config = {
      ...TEST_CONFIG,
      instanceAdminTokenHash: sha256Hex('another-admin-token-0123456789abcdef'),
    }
    expect(await verifyDashboardSession(rotated, value)).toBeNull()
  })

  test('a MAC made for another purpose with the same key is not a session', async () => {
    const deps = createInstanceTestDeps()
    const now = seconds(deps)
    const payload = Buffer.from(JSON.stringify({ sid: SID, iat: now, exp: now + 60 })).toString(
      'base64url'
    )
    const mac = await deps.keyedHash.hmac(
      'verification-codes',
      `v1.${payload}.${deps.config.instanceAdminTokenHash}`
    )
    expect(await verifyDashboardSession(deps, `v1.${payload}.${mac}`)).toBeNull()
  })
})
