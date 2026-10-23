import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { ImportUserRow, ImportUsersResult } from '@tula-tech/contract'
import { createApp, MAX_BODY_BYTES, MAX_IMPORT_BODY_BYTES } from '~/index'
import * as Flows from '~/modules/flow/service'
import * as Passwords from '~/modules/password/service'
import { USER_IMPORT_RATE_LIMIT } from '~/modules/user/router'
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
