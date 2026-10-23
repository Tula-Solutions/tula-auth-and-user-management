import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ImportUserRow, ImportUsersResult } from '@tula-tech/contract'
import { createApp, MAX_BODY_BYTES, MAX_IMPORT_BODY_BYTES } from '~/index'
import * as Flows from '~/modules/flow/service'
import * as Foreign from '~/modules/password/foreign-hash'
import * as Passwords from '~/modules/password/service'
import { USER_IMPORT_RATE_LIMIT } from '~/modules/user/router'
import { InvalidUserDataError } from '~/ports/user-repository'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import { ARGON2I_REFERENCE, BCRYPT_PHP_COST_7 } from '~/testing/password-vectors'

// Bulk user import (ADR 0066, TULA-114).

const SK = 'tula_sk_dev_admin000000000000000000000000000000'
const OTHER_SK = 'tula_sk_prod_admin00000000000000000000000000000'
const AK = 'tula_ak_dev_agent000000000000000000000000000000'
const PK = 'tula_pk_dev_publishable0000000000000000000'
const tenant = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.environmentId,
  apiKeyId: 'key_1',
}
const web: Flows.ClientContext = {
  client: 'web',
  userAgent: 'Mozilla/5.0',
  ipAddress: '203.0.113.7',
  originAllowed: true,
}
const PASSWORD = 'correct horse battery staple'

// One hash of each kind for the whole file: bcrypt at the floor and argon2 at its floor are
// what an import is most likely to carry, and making them per test would dominate the run.
const BCRYPT = await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 10 })
const ARGON2ID_FLOOR = await Bun.password.hash(PASSWORD, {
  algorithm: 'argon2id',
  memoryCost: 19_456,
  timeCost: 2,
})
const ARGON2I_FLOOR = await Bun.password.hash(PASSWORD, {
  algorithm: 'argon2i',
  memoryCost: 19_456,
  timeCost: 2,
})

let deps: TestDeps
let app: ReturnType<typeof createApp>
const spies: ReturnType<typeof spyOn>[] = []

beforeEach(async () => {
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TEST_TENANT.productionEnvironmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, SK)
  await seedApiKey(deps, AK)
  await seedApiKey(deps, PK)
  await seedApiKey(deps, OTHER_SK, { environmentId: TEST_TENANT.productionEnvironmentId })
  app = createApp(deps)
})

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore()
  }
})

function post(body: unknown, key: string | null = SK, raw?: string) {
  return app.request('/v1/admin/users/import', {
    method: 'POST',
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      'content-type': 'application/json',
    },
    body: raw ?? JSON.stringify(body),
  })
}

async function importRows(
  users: Partial<ImportUserRow>[],
  key: string | null = SK
): Promise<ImportUsersResult> {
  const res = await post({ users }, key)
  expect(res.status).toBe(200)
  return (await res.json()) as ImportUsersResult
}

const row = (email: string, extra: Partial<ImportUserRow> = {}): ImportUserRow => ({
  email,
  emailVerified: true,
  ...extra,
})

const stored = (email: string) => deps.users.findByEmailWithPassword(tenant.environmentId, email)

const signIn = async (identifier: string, password: string) => {
  const { attempt } = await Flows.signIn(deps, tenant, { identifier }, web)
  return Flows.submitPassword(
    deps,
    tenant,
    { id: attempt.id, secret: attempt.attemptSecret },
    password,
    web
  )
}

describe('POST /v1/admin/users/import: the answer', () => {
  test('reports each row in order: created, skipped and refused', async () => {
    await importRows([row('taken@northline.app')])
    const result = await importRows([
      row('maya@northline.app', { password: { algorithm: 'bcrypt', hash: BCRYPT } }),
      row('taken@northline.app'),
      row('not an email'),
      row('MAYA@northline.app'),
      row('lee@northline.app', { password: { algorithm: 'bcrypt', hash: 'nonsense' } }),
    ])
    expect(result.results.map((entry) => [entry.index, entry.status])).toEqual([
      [0, 'created'],
      [1, 'skipped'],
      [2, 'refused'],
      [3, 'skipped'],
      [4, 'refused'],
    ])
    expect([result.created, result.skipped, result.refused]).toEqual([1, 2, 2])
    const created = result.results[0]
    const known = await deps.users.findByEmail(tenant.environmentId, 'maya@northline.app')
    expect(created).toEqual({ index: 0, status: 'created', id: known?.id as string })
    expect(result.results[1]).toEqual({ index: 1, status: 'skipped', reason: 'email_exists' })
    expect(result.results[3]).toEqual({ index: 3, status: 'skipped', reason: 'repeated_in_batch' })
  })

  test('a refused row stops nobody else, and a hash is never in the answer', async () => {
    const res = await post({
      users: [
        row('a@northline.app', { password: { algorithm: 'bcrypt', hash: BCRYPT } }),
        row('b@northline.app', { password: { algorithm: 'scrypt', hash: 'x' } }),
        row('c@northline.app', { password: { algorithm: 'argon2id', hash: ARGON2ID_FLOOR } }),
      ],
    })
    const text = await res.text()
    expect(text).not.toContain(BCRYPT)
    expect(text).not.toContain('argon2id$')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const result = JSON.parse(text) as ImportUsersResult
    expect(result.results.map((entry) => entry.status)).toEqual(['created', 'refused', 'created'])
  })

  test('importing the same file twice creates nobody twice', async () => {
    const file = [
      row('maya@northline.app', { password: { algorithm: 'bcrypt', hash: BCRYPT } }),
      row('lee@northline.app'),
    ]
    expect((await importRows(file)).created).toBe(2)
    const again = await importRows(file)
    expect([again.created, again.skipped]).toEqual([0, 2])
    expect(again.results.every((entry) => entry.status === 'skipped')).toBe(true)
    expect(deps.activityLog.ofType('user.imported')).toHaveLength(2)
  })

  test('an address is the same user whatever its case', async () => {
    await importRows([row('Maya@Northline.app')])
    const result = await importRows([row('maya@northline.APP')])
    expect(result.results).toEqual([{ index: 0, status: 'skipped', reason: 'email_exists' }])
  })

  test('a duplicate that came after a refused row is not reported as repeated', async () => {
    const result = await importRows([
      row('maya@northline.app', { password: { algorithm: 'bcrypt', hash: 'nonsense' } }),
      row('maya@northline.app', { password: { algorithm: 'bcrypt', hash: BCRYPT } }),
    ])
    expect(result.results.map((entry) => entry.status)).toEqual(['refused', 'created'])
  })

  test('another environment is not touched, and does not shadow', async () => {
    await importRows([row('maya@northline.app')], OTHER_SK)
    const result = await importRows([row('maya@northline.app')])
    expect(result.created).toBe(1)
  })
})

describe('the refusals, row by row', () => {
  const refusal = async (user: Partial<ImportUserRow>) => {
    const { results } = await importRows([user])
    const [only] = results
    return only?.status === 'refused' ? only : null
  }

  test.each([
    ['an invalid email', { email: 'nobody' }, 'email.invalid'],
    [
      'an email of the reserved test domain',
      { email: 'tula-test-ab12@test.tula.invalid' },
      'email.invalid',
    ],
    ['a non-ASCII email', { email: 'mäya@northline.app' }, 'email.invalid'],
    [
      'an unsupported algorithm',
      { password: { algorithm: 'md5', hash: 'abc' } },
      'import.unsupported_algorithm',
    ],
    [
      'a malformed bcrypt hash',
      { password: { algorithm: 'bcrypt', hash: BCRYPT.slice(0, 40) } },
      'import.hash_malformed',
    ],
    [
      'a hash that is not the declared algorithm',
      { password: { algorithm: 'argon2id', hash: BCRYPT } },
      'import.hash_malformed',
    ],
    [
      'bcrypt below cost 10 (the PHP example)',
      { password: { algorithm: 'bcrypt', hash: BCRYPT_PHP_COST_7 } },
      'import.hash_parameters_too_weak',
    ],
    [
      'argon2 with too little memory',
      {
        password: {
          algorithm: 'argon2id',
          hash: '$argon2id$v=19$m=4096,t=3,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG',
        },
      },
      'import.hash_parameters_too_weak',
    ],
    [
      'bcrypt that costs too much to verify',
      { password: { algorithm: 'bcrypt', hash: BCRYPT.replace('$10$', '$20$') } },
      'import.hash_parameters_too_costly',
    ],
  ] as const)('%s', async (_name, change, code) => {
    const refused = await refusal({ ...row('maya@northline.app'), ...change })
    expect(refused?.code).toBe(code)
    expect(refused?.message).toBeString()
    // Refused is refused whole: no user, no credential, no entry.
    if (!('email' in change)) {
      expect(await stored('maya@northline.app')).toBeNull()
    }
    expect(deps.activityLog.ofType('user.imported')).toEqual([])
  })

  test('metadata over 4 KiB', async () => {
    expect(
      (await refusal({ ...row('a@northline.app'), metadata: { blob: 'x'.repeat(4096) } }))?.code
    ).toBe('validation.failed')
    expect(
      await refusal({ ...row('b@northline.app'), metadata: { blob: 'x'.repeat(4000) } })
    ).toBeNull()
  })

  // The database measures `metadata::text`, which jsonb prints with a space after every ':' and
  // ',': a row that is under 4096 bytes as compact JSON can be over it as stored, and one
  // such row must be refused alone, never fail the call after earlier rows were committed.
  test('metadata that is under 4 KiB compact and over it as jsonb prints it', async () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${String(i).padStart(2, '0')}`, 'v'.repeat(31)])
    )
    const compact = JSON.stringify(metadata).length
    expect(compact).toBeLessThanOrEqual(4096)
    expect(compact + 100 + 99).toBeGreaterThan(4096)
    const { results } = await importRows([
      row('before@northline.app'),
      { ...row('hostile@northline.app'), metadata },
      row('after@northline.app'),
    ])
    expect(results.map((entry) => entry.status)).toEqual(['created', 'refused', 'created'])
    expect(results[1]).toMatchObject({ code: 'validation.failed' })
    expect(await deps.users.findByEmail(tenant.environmentId, 'hostile@northline.app')).toBeNull()
  })

  test.each([
    ['a NUL in a metadata value', { metadata: { a: 'x\u0000y' } }],
    ['a NUL in a metadata key', { metadata: { 'a\u0000b': 'x' } }],
    ['a NUL nested in an array', { metadata: { a: [{ b: ['\u0000'] }] } }],
    ['a lone surrogate in a metadata value', { metadata: { a: '\ud800' } }],
    ['a number with an exponent', { metadata: { a: 1e300 } }],
    ['a NUL in the name', { name: 'Maya\u0000 Lee' }],
    ['a NUL in the external id', { externalId: 'ext\u00001' }],
  ] as const)('%s is refused alone, and the rows around it are created', async (_name, change) => {
    const { results } = await importRows([
      row('before@northline.app'),
      { ...row('hostile@northline.app'), ...change } as ImportUserRow,
      row('after@northline.app'),
    ])
    expect(results.map((entry) => entry.status)).toEqual(['created', 'refused', 'created'])
    expect(results[1]).toMatchObject({ code: 'validation.failed' })
  })

  // A depth the contract's z.unknown() does not bound: recursing over it (or stringifying it)
  // overflows the stack, which would be the whole call's 500 after earlier rows committed.
  test('metadata nested 100000 deep is refused alone, whole call 200', async () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`
    const good = (email: string) => JSON.stringify(row(email))
    const raw = `{"users":[${good('before@northline.app')},{"email":"deep@northline.app","emailVerified":true,"metadata":{"a":${deep}}},${good('after@northline.app')}]}`
    const res = await post(null, SK, raw)
    expect(res.status).toBe(200)
    const result = (await res.json()) as ImportUsersResult
    expect(result.results.map((entry) => entry.status)).toEqual(['created', 'refused', 'created'])
    expect(result.results[1]).toMatchObject({ code: 'validation.failed' })
  })

  test('metadata nested 32 deep is allowed and 33 deep is refused', async () => {
    const nest = (levels: number) => {
      let value: unknown = 1
      for (let i = 0; i < levels; i += 1) {
        value = [value]
      }
      return { a: value }
    }
    // `metadata` itself is level 1, so `a` holds 31 more arrays at the limit.
    const { results } = await importRows([
      { ...row('ok@northline.app'), metadata: nest(31) },
      { ...row('deep@northline.app'), metadata: nest(32) },
    ])
    expect(results.map((entry) => entry.status)).toEqual(['created', 'refused'])
  })

  test('a row the store itself refuses is refused alone and earlier rows stay', async () => {
    const create = deps.users.create.bind(deps.users)
    spies.push(
      spyOn(deps.users, 'create').mockImplementation(async (user, activity) => {
        if (user.email?.startsWith('bad')) {
          throw new InvalidUserDataError()
        }
        return create(user, activity)
      })
    )
    const { results } = await importRows([
      row('before@northline.app'),
      row('bad@northline.app'),
      row('after@northline.app'),
    ])
    expect(results.map((entry) => entry.status)).toEqual(['created', 'refused', 'created'])
    expect(results[1]).toMatchObject({ code: 'validation.failed' })
    expect(
      await deps.users.findByEmail(tenant.environmentId, 'before@northline.app')
    ).not.toBeNull()
  })

  test('another failure of the store is still the call’s failure', async () => {
    spies.push(spyOn(deps.users, 'create').mockRejectedValue(new Error('connection lost')))
    const res = await post({ users: [row('a@northline.app')] })
    expect(res.status).toBe(500)
  })

  test('a refused hash is not stored anywhere', async () => {
    await refusal({ ...row('maya@northline.app'), password: { algorithm: 'bcrypt', hash: 'x' } })
    expect(await deps.users.findByEmail(tenant.environmentId, 'maya@northline.app')).toBeNull()
  })
})

describe('the batch', () => {
  test('takes 500 rows and refuses 501, whole', async () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, i) => row(`user${i}@northline.app`))
    const ok = await importRows(rows(500))
    expect(ok.created).toBe(500)

    const tooMany = await post({ users: rows(501) })
    expect(tooMany.status).toBe(422)
    expect(await deps.users.findByEmail(tenant.environmentId, 'user500@northline.app')).toBeNull()
  })

  test('refuses an empty batch and a body of the wrong shape', async () => {
    expect((await post({ users: [] })).status).toBe(422)
    expect((await post({})).status).toBe(422)
    expect((await post({ users: [{ email: 'a@northline.app' }] })).status).toBe(422)
    expect((await post(null, SK, 'not json')).status).toBe(400)
  })

  test('500 rows with bcrypt hashes fit the import’s body limit, which others do not get', async () => {
    const users = Array.from({ length: 500 }, (_, i) =>
      row(`user${i}@northline.app`, { password: { algorithm: 'bcrypt', hash: BCRYPT } })
    )
    const body = JSON.stringify({ users })
    expect(body.length).toBeGreaterThan(MAX_BODY_BYTES)
    expect(body.length).toBeLessThan(MAX_IMPORT_BODY_BYTES)
    const res = await post(null, SK, body)
    expect(res.status).toBe(200)
    // The ordinary limit still holds everywhere else.
    const create = await app.request('/v1/admin/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@northline.app', firstName: 'x'.repeat(MAX_BODY_BYTES) }),
    })
    expect(create.status).toBe(413)
  })

  test('500 rows each with about 4000 bytes of metadata fit the import’s limit', async () => {
    const users = Array.from({ length: 500 }, (_, i) =>
      row(`user${i}@northline.app`, { metadata: { blob: 'x'.repeat(4000) } })
    )
    const body = JSON.stringify({ users })
    // Above the 1 MiB the route used to have: the metadata-heavy file is the reason for 4 MiB.
    expect(body.length).toBeGreaterThan(1024 * 1024)
    expect(body.length).toBeLessThan(MAX_IMPORT_BODY_BYTES)
    const res = await post(null, SK, body)
    expect(res.status).toBe(200)
    expect(((await res.json()) as ImportUsersResult).created).toBe(500)
  })

  test('the import’s body limit is 4 MiB', () => {
    expect(MAX_IMPORT_BODY_BYTES).toBe(4 * 1024 * 1024)
  })

  test('refuses a body over the import’s own limit', async () => {
    const res = await post(null, SK, JSON.stringify({ pad: 'x'.repeat(MAX_IMPORT_BODY_BYTES) }))
    expect(res.status).toBe(413)
  })
})

describe('who may import', () => {
  const file = [row('maya@northline.app')]

  test('needs a key', async () => {
    expect((await post({ users: file }, null)).status).toBe(401)
  })

  test('refuses a publishable key', async () => {
    expect((await post({ users: file }, PK)).status).toBe(401)
  })

  test('refuses an agent key: it is a write', async () => {
    const res = await post({ users: file }, AK)
    expect(res.status).toBe(401)
    expect(await deps.users.findByEmail(tenant.environmentId, 'maya@northline.app')).toBeNull()
  })

  test(`is limited per environment to ${USER_IMPORT_RATE_LIMIT} calls a minute`, async () => {
    for (let call = 0; call < USER_IMPORT_RATE_LIMIT; call += 1) {
      expect((await post({ users: [row(`u${call}@northline.app`)] })).status).toBe(200)
    }
    const limited = await post({ users: [row('late@northline.app')] })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).not.toBeNull()
    // Another environment has its own allowance.
    expect((await post({ users: [row('late@northline.app')] }, OTHER_SK)).status).toBe(200)
  })
})

describe('what an import records', () => {
  test('one user.imported entry per user, by the admin, and no user.created', async () => {
    const result = await importRows([
      row('a@northline.app', { password: { algorithm: 'bcrypt', hash: BCRYPT } }),
      row('b@northline.app', { emailVerified: false }),
      row('c@northline.app', { password: { algorithm: 'argon2i', hash: ARGON2I_FLOOR } }),
      row('a@northline.app'),
    ])
    expect(deps.activityLog.ofType('user.created')).toEqual([])
    const entries = deps.activityLog.ofType('user.imported')
    expect(entries).toHaveLength(3)
    const ids = result.results.flatMap((entry) => (entry.status === 'created' ? [entry.id] : []))
    expect(entries.map((entry) => entry.target)).toEqual(ids.map((id) => ({ type: 'user', id })))
    expect(entries.map((entry) => entry.data)).toEqual([
      { emailVerified: true, passwordAlgorithm: 'bcrypt' },
      { emailVerified: false, passwordless: true },
      { emailVerified: true, passwordAlgorithm: 'argon2i' },
    ])
    for (const entry of entries) {
      expect(entry.actor.type).toBe('admin')
      expect(entry.environmentId).toBe(tenant.environmentId)
    }
  })

  test('an entry holds no address, name, hash or metadata', async () => {
    await importRows([
      row('maya@northline.app', {
        name: 'Maya Chen',
        externalId: 'auth0|abc',
        metadata: { plan: 'zzmeta' },
        password: { algorithm: 'bcrypt', hash: BCRYPT },
      }),
    ])
    const text = JSON.stringify(deps.activityLog.ofType('user.imported'))
    for (const secret of ['maya@', 'Maya', 'Chen', BCRYPT, 'auth0', 'zzmeta']) {
      expect(text).not.toContain(secret)
    }
  })

  test('a row whose entry cannot be written leaves no user', async () => {
    // The entry is written with the user by the store: if the store fails, nothing stays.
    const spy = spyOn(deps.users, 'create').mockRejectedValueOnce(new Error('store down'))
    spies.push(spy)
    const res = await post({ users: [row('maya@northline.app')] })
    expect(res.status).toBe(500)
    expect(await deps.users.findByEmail(tenant.environmentId, 'maya@northline.app')).toBeNull()
    expect(deps.activityLog.ofType('user.imported')).toEqual([])
  })

  test('the name is split at the first space and kept', async () => {
    await importRows([
      row('a@northline.app', { name: 'Maya Chen-Smith' }),
      row('b@northline.app', { name: 'Cher' }),
      row('c@northline.app'),
    ])
    const names = async (email: string) => {
      const user = await deps.users.findByEmail(tenant.environmentId, email)
      return [user?.firstName, user?.lastName]
    }
    expect(await names('a@northline.app')).toEqual(['Maya', 'Chen-Smith'])
    expect(await names('b@northline.app')).toEqual(['Cher', null])
    expect(await names('c@northline.app')).toEqual([null, null])
  })

  test('the password’s age starts at the import and no history is made', async () => {
    deps.clock.advance('1h')
    await importRows([
      row('maya@northline.app', { password: { algorithm: 'bcrypt', hash: BCRYPT } }),
    ])
    const user = await stored('maya@northline.app')
    expect(user?.passwordHash).toBe(BCRYPT)
    expect(user?.passwordChangedAt?.getTime()).toBe(deps.clock.now().getTime())
    expect(
      await deps.users.storedPasswords(tenant.environmentId, user?.user.id as string, 5)
    ).toEqual({
      current: BCRYPT,
      previous: [],
    })
  })

  test('the email is verified only when the row says so', async () => {
    await importRows([row('a@northline.app'), row('b@northline.app', { emailVerified: false })])
    expect((await stored('a@northline.app'))?.user.emailVerifiedAt).not.toBeNull()
    expect((await stored('b@northline.app'))?.user.emailVerifiedAt).toBeNull()
  })
})

describe('signing in with the old password', () => {
  test.each([
    ['bcrypt', BCRYPT],
    ['argon2id', ARGON2ID_FLOOR],
    ['argon2i', ARGON2I_FLOOR],
  ] as const)(
    'a %s hash signs the user in, and is replaced by argon2id',
    async (algorithm, hash) => {
      await importRows([row('maya@northline.app', { password: { algorithm, hash } })])
      const upgrade = spyOn(deps.users, 'upgradePasswordHash')
      spies.push(upgrade)

      const wrong = await signIn('maya@northline.app', 'not the password').catch((err) => err)
      expect(wrong.code).toBe('auth.invalid_credentials')
      expect((await stored('maya@northline.app'))?.passwordHash).toBe(hash)
      expect(upgrade).not.toHaveBeenCalled()

      const result = await signIn('maya@northline.app', PASSWORD)
      expect(result.tokens).toBeDefined()
      expect(upgrade).toHaveBeenCalledTimes(1)
      const after = (await stored('maya@northline.app'))?.passwordHash as string
      expect(after).not.toBe(hash)
      expect(after.startsWith('$argon2id$v=19$m=65536,t=2,p=1$')).toBe(true)
      expect(Passwords.needsRehash(after)).toBe(false)
      expect(await Bun.password.verify(PASSWORD, after)).toBe(true)

      // The second sign-in uses the new hash and upgrades nothing.
      expect((await signIn('maya@northline.app', PASSWORD)).tokens).toBeDefined()
      expect(upgrade).toHaveBeenCalledTimes(1)
    }
  )

  test('the upgrade does not move the password’s age', async () => {
    await importRows([
      row('maya@northline.app', { password: { algorithm: 'bcrypt', hash: BCRYPT } }),
    ])
    const before = (await stored('maya@northline.app'))?.passwordChangedAt
    deps.clock.advance('2h')
    await signIn('maya@northline.app', PASSWORD)
    expect((await stored('maya@northline.app'))?.passwordChangedAt).toEqual(before as Date)
  })

  test('the reference argon2i vector signs in with its own password', async () => {
    const { results } = await importRows([
      row('ref@northline.app', { password: { algorithm: 'argon2i', hash: ARGON2I_REFERENCE } }),
    ])
    expect(results[0]?.status).toBe('created')
    expect((await signIn('ref@northline.app', 'password')).tokens).toBeDefined()
  })

  test('a user imported without a password has none to sign in with', async () => {
    await importRows([row('maya@northline.app')])
    const err = await signIn('maya@northline.app', PASSWORD).catch((e) => e)
    expect(err.code).toBe('auth.invalid_credentials')
  })

  test('an imported user with an unverified address is not signed in by the old password alone', async () => {
    await importRows([
      row('maya@northline.app', {
        emailVerified: false,
        password: { algorithm: 'bcrypt', hash: BCRYPT },
      }),
    ])
    const result = await signIn('maya@northline.app', PASSWORD)
    expect(result.tokens).toBeUndefined()
  })
})

// PBKDF2-SHA256 and Firebase's scrypt (ADR 0066, TULA-118).
const DJANGO_PBKDF2 =
  'pbkdf2_sha256$260000$Xp9aBcDeFgHi$tPuMiTl59uBGuxPihVmXj2h4nxk2jFn28PP+eoHlEI0='
// firebase/scrypt's README example.
const FIREBASE_PARAMS = {
  signerKey:
    'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memCost: 14,
}
const FIREBASE_PASSWORD = 'user1password'
const firebaseRow = (email: string): ImportUserRow =>
  row(email, {
    password: {
      algorithm: 'firebase_scrypt',
      hash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
      params: { salt: '42xEC+ixf3L2lw==' },
    },
  })

async function importFirebase(users: ImportUserRow[], firebaseScrypt: unknown = FIREBASE_PARAMS) {
  const res = await post({ users, ...(firebaseScrypt !== null && { firebaseScrypt }) })
  expect(res.status).toBe(200)
  return (await res.json()) as ImportUsersResult
}

const outcomes = (result: ImportUsersResult) =>
  result.results.map((entry) => (entry.status === 'refused' ? entry.code : entry.status))

describe('PBKDF2-SHA256 and Firebase scrypt: the first sign-in', () => {
  test('a Django PBKDF2 hash signs in, is replaced by argon2id, and a wrong password does not', async () => {
    const result = await importRows([
      row('dj@northline.app', { password: { algorithm: 'pbkdf2_sha256', hash: DJANGO_PBKDF2 } }),
    ])
    expect(result.created).toBe(1)
    const before = (await stored('dj@northline.app'))?.passwordHash as string
    expect(before.startsWith('$pbkdf2-sha256$i=260000$')).toBe(true)

    const wrong = await signIn('dj@northline.app', 'not the password').catch((err) => err)
    expect(wrong.code).toBe('auth.invalid_credentials')
    expect((await stored('dj@northline.app'))?.passwordHash).toBe(before)

    expect((await signIn('dj@northline.app', PASSWORD)).tokens).toBeDefined()
    const after = (await stored('dj@northline.app'))?.passwordHash as string
    expect(after.startsWith('$argon2id$v=19$m=65536,t=2,p=1$')).toBe(true)
    expect(await Bun.password.verify(PASSWORD, after)).toBe(true)
    expect((await signIn('dj@northline.app', PASSWORD)).tokens).toBeDefined()
  })

  test('a Firebase hash signs in, is replaced by argon2id, and a wrong password does not', async () => {
    const result = await importFirebase([firebaseRow('fb@northline.app')])
    expect(result.created).toBe(1)
    const before = (await stored('fb@northline.app'))?.passwordHash as string
    expect(before.startsWith('$tula-firebase-scrypt$v1$')).toBe(true)

    const wrong = await signIn('fb@northline.app', PASSWORD).catch((err) => err)
    expect(wrong.code).toBe('auth.invalid_credentials')
    expect((await stored('fb@northline.app'))?.passwordHash).toBe(before)

    expect((await signIn('fb@northline.app', FIREBASE_PASSWORD)).tokens).toBeDefined()
    const after = (await stored('fb@northline.app'))?.passwordHash as string
    expect(after.startsWith('$argon2id$v=19$m=65536,t=2,p=1$')).toBe(true)
    // Nothing of the project's parameters is left in the row once the user has signed in.
    expect(after).not.toContain('tula-firebase')
    expect((await signIn('fb@northline.app', FIREBASE_PASSWORD)).tokens).toBeDefined()
  })

  test('the project parameters are in no answer, no entry and no event', async () => {
    const res = await post({
      users: [firebaseRow('fb@northline.app'), firebaseRow('fb2@northline.app')],
      firebaseScrypt: FIREBASE_PARAMS,
    })
    const text = JSON.stringify([
      await res.text(),
      deps.activityLog.ofType('user.imported'),
      deps.activityLog.ofType('user.created'),
    ])
    expect(text).toContain('firebase_scrypt')
    for (const secret of [FIREBASE_PARAMS.signerKey, FIREBASE_PARAMS.saltSeparator, '42xEC']) {
      expect(text).not.toContain(secret)
    }
    const entries = deps.activityLog.ofType('user.imported')
    expect(entries.map((entry) => entry.data)).toEqual([
      { emailVerified: true, passwordAlgorithm: 'firebase_scrypt' },
      { emailVerified: true, passwordAlgorithm: 'firebase_scrypt' },
    ])
  })

  test('the stored hash keeps the project key sealed, not in the clear', async () => {
    await importFirebase([firebaseRow('fb@northline.app')])
    const hash = (await stored('fb@northline.app'))?.passwordHash as string
    expect(hash).not.toContain(FIREBASE_PARAMS.signerKey)
    expect(hash).not.toContain(FIREBASE_PARAMS.signerKey.slice(0, 24))
  })

  test('a Firebase row in a call without the project parameters is refused alone', async () => {
    const result = await importFirebase(
      [row('ok@northline.app'), firebaseRow('fb@northline.app')],
      null
    )
    expect(outcomes(result)).toEqual(['created', 'import.hash_malformed'])
    expect(await stored('fb@northline.app')).toBeNull()
  })

  test.each([
    ['weak', { ...FIREBASE_PARAMS, memCost: 10 }, 'import.hash_parameters_too_weak'],
    ['costly', { ...FIREBASE_PARAMS, memCost: 20 }, 'import.hash_parameters_too_costly'],
    [
      'costly by the product',
      { ...FIREBASE_PARAMS, memCost: 16, rounds: 16 },
      'import.hash_parameters_too_costly',
    ],
    ['malformed', { ...FIREBASE_PARAMS, signerKey: '***' }, 'import.hash_malformed'],
  ])(
    'project parameters that are %s refuse the Firebase rows, one by one',
    async (_n, params, code) => {
      const result = await importFirebase(
        [firebaseRow('a@northline.app'), firebaseRow('b@northline.app')],
        params
      )
      expect(outcomes(result)).toEqual([code, code])
      expect(result.created).toBe(0)
    }
  )

  test('PBKDF2 under the floor, over the ceiling or malformed is refused per row', async () => {
    const pbkdf2 = (hash: string) => ({ algorithm: 'pbkdf2_sha256', hash })
    const result = await importRows([
      row('a@northline.app', {
        password: pbkdf2(DJANGO_PBKDF2.replace('$260000$', '$99999$')),
      }),
      row('b@northline.app', {
        password: pbkdf2(DJANGO_PBKDF2.replace('$260000$', '$2000001$')),
      }),
      row('c@northline.app', { password: pbkdf2(DJANGO_PBKDF2.replace('tPuM', 'tP*M')) }),
      row('d@northline.app', { password: pbkdf2(DJANGO_PBKDF2) }),
    ])
    expect(outcomes(result)).toEqual([
      'import.hash_parameters_too_weak',
      'import.hash_parameters_too_costly',
      'import.hash_malformed',
      'created',
    ])
  })

  test('the imported Firebase hash opens only for its own user', async () => {
    await importFirebase([firebaseRow('fb@northline.app')])
    const found = await stored('fb@northline.app')
    const hash = found?.passwordHash ?? null
    const own = Foreign.opener(deps, tenant.environmentId, found?.user.id as string)
    expect(await Passwords.verify(hash, FIREBASE_PASSWORD, own)).toBe(true)
    expect(await Passwords.verify(hash, FIREBASE_PASSWORD)).toBe(false)
    expect(
      await Passwords.verify(
        hash,
        FIREBASE_PASSWORD,
        Foreign.opener(deps, tenant.environmentId, 'x')
      )
    ).toBe(false)
  })
})
