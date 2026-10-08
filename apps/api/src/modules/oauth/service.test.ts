import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { DEFAULT_ENVIRONMENT_SETTINGS, type EnvironmentSettings } from '@tula/contract'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import type { OAuthProfile } from '~/ports/oauth-provider'
import type { NewUser, SignInMeans } from '~/ports/user-repository'
import { createTestDeps, TEST_ACTOR, TEST_TENANT, type TestDeps } from '~/testing'

const tenant = { ...TEST_TENANT, apiKeyId: 'key' }
const EMAIL = 'maya@northline.app'
const profile: OAuthProfile = { subject: 'sub-1', email: 'Maya@Northline.app', emailVerified: true }
const origin = { ipAddress: '203.0.113.7', userAgent: 'tests' }

let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
})

function newUser(overrides: Partial<NewUser> = {}): NewUser {
  const id = deps.ids.next()
  return {
    id,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    email: EMAIL,
    emailNormalized: EMAIL,
    emailVerifiedAt: deps.clock.now(),
    firstName: null,
    lastName: null,
    createdAt: deps.clock.now(),
    identityId: deps.ids.next(),
    credentialId: deps.ids.next(),
    passwordHash: '$argon2id$hash',
    ...overrides,
  }
}

const resolve = (answer: OAuthProfile = profile) =>
  OAuth.resolveAccount(deps, tenant, 'google', answer, origin, 'web')
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: { code?: string }) => error.code
  )
const types = () => deps.activityLog.entries.map((entry) => entry.type)

describe('resolveAccount: the linking table', () => {
  test('row 1: a known identity is its user, and the provider’s address is not looked at', async () => {
    const owner = newUser({
      oauthIdentity: { id: deps.ids.next(), provider: 'google', subject: 'sub-1' },
    })
    await deps.users.create(owner, Audit.none('fixture'))
    // Someone else now has the address the provider reports: it changes nothing.
    await deps.users.create(
      newUser({ email: 'other@northline.app', emailNormalized: 'other@northline.app' }),
      Audit.none('fixture')
    )
    const byEmail = spyOn(deps.users, 'findByEmail')
    for (const answer of [
      { ...profile, email: 'other@northline.app' },
      { ...profile, email: null, emailVerified: false },
      { ...profile, emailVerified: false },
    ]) {
      const resolved = await resolve(answer)
      expect(resolved).toMatchObject({
        user: { id: owner.id, email: EMAIL },
        created: false,
        linked: false,
      })
    }
    expect(byEmail).not.toHaveBeenCalled()
    byEmail.mockRestore()
  })

  test('row 2: a missing, malformed or unverified address is refused before any lookup by address', async () => {
    await deps.users.create(newUser(), Audit.none('fixture'))
    const byEmail = spyOn(deps.users, 'findByEmail')
    expect(await codeOf(resolve({ ...profile, email: null }))).toBe('oauth.email_missing')
    expect(await codeOf(resolve({ ...profile, email: 'not an address' }))).toBe(
      'oauth.email_missing'
    )
    expect(await codeOf(resolve({ ...profile, emailVerified: false }))).toBe(
      'oauth.email_unverified'
    )
    expect(byEmail).not.toHaveBeenCalled()
    expect(types()).toEqual([])
    byEmail.mockRestore()
  })

  test('row 3: no user has the address: a verified, passwordless user with the identity', async () => {
    const resolved = await resolve({ ...profile, givenName: 'Maya', familyName: 'Okafor' })
    expect(resolved).toMatchObject({
      created: true,
      linked: false,
      user: {
        email: 'Maya@Northline.app',
        emailNormalized: EMAIL,
        firstName: 'Maya',
        lastName: 'Okafor',
      },
    })
    expect(resolved.user.emailVerifiedAt).toEqual(deps.clock.now())
    expect(
      (await deps.users.findByEmailWithPassword(tenant.environmentId, EMAIL))?.passwordHash
    ).toBeNull()
    expect((await deps.users.findByIdentity(tenant.environmentId, 'google', 'sub-1'))?.id).toBe(
      resolved.user.id
    )
    expect(deps.activityLog.entries).toEqual([
      expect.objectContaining({
        type: 'user.created',
        actor: { type: 'user', id: resolved.user.id },
        ipAddress: '203.0.113.7',
        data: { method: 'oauth_google', emailVerified: true, passwordless: true },
      }),
    ])
    // The audit entry holds no address and no provider id.
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain('northline')
    expect(JSON.stringify(deps.activityLog.entries)).not.toContain('sub-1')
  })

  test('row 4: a verified account with that address gets the identity, its password untouched', async () => {
    const owner = newUser()
    await deps.users.create(owner, Audit.none('fixture'))
    const resolved = await resolve()
    expect(resolved).toMatchObject({ user: { id: owner.id }, created: false, linked: true })
    expect(
      (await deps.users.findByEmailWithPassword(tenant.environmentId, EMAIL))?.passwordHash
    ).toBe('$argon2id$hash')
    expect(deps.activityLog.entries.at(-1)).toMatchObject({
      type: 'user.identity_linked',
      actor: { type: 'user', id: owner.id },
      data: { provider: 'google', method: 'auto' },
    })
    await Notices.settled()
    expect(deps.mailer.last()).toMatchObject({ to: EMAIL })
    // And from now on it is row 1.
    expect(await resolve()).toMatchObject({ linked: false, created: false })
  })

  test('row 5: an account whose Tula address is unverified is never linked into', async () => {
    const squatter = newUser({ emailVerifiedAt: null })
    await deps.users.create(squatter, Audit.none('fixture'))
    expect(await codeOf(resolve())).toBe('oauth.account_exists')
    expect(await deps.users.listIdentities(tenant.environmentId, squatter.id)).toEqual([])
    expect(types()).toEqual([])
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
  })

  // Review finding F1: U+212A (KELVIN SIGN) lowercases to an ASCII "k". A provider address
  // spelled with it must never be treated as the ASCII mailbox it looks like.
  test('a look-alike address (Kelvin sign) neither links to nor collides with the ASCII account', async () => {
    const owner = newUser({
      email: 'kelvin@northline.app',
      emailNormalized: 'kelvin@northline.app',
    })
    await deps.users.create(owner, Audit.none('fixture'))
    const lookAlike = { subject: 'attacker', email: 'Kelvin@northline.app', emailVerified: true }
    expect(await codeOf(resolve(lookAlike))).toBe('oauth.email_missing')
    expect(await deps.users.listIdentities(tenant.environmentId, owner.id)).toEqual([])
    expect(await deps.users.findByIdentity(tenant.environmentId, 'google', 'attacker')).toBeNull()
    expect(types()).toEqual([])
    await Notices.settled()
    expect(deps.mailer.outbox).toEqual([])
    // With no such account either, nothing is created under the folded address.
    expect(await codeOf(resolve({ ...lookAlike, email: 'Kai@northline.app' }))).toBe(
      'oauth.email_missing'
    )
    expect(await deps.users.findByEmail(tenant.environmentId, 'kai@northline.app')).toBeNull()
  })

  test('a banned account is connected to nothing', async () => {
    const owner = newUser()
    await deps.users.create(owner, Audit.none('fixture'))
    await deps.users.setBanned(
      tenant.environmentId,
      owner.id,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
    expect(await codeOf(resolve())).toBe('auth.user_banned')
    expect(await deps.users.listIdentities(tenant.environmentId, owner.id)).toEqual([])
  })

  test('an account that already has another account of the provider is not given a second', async () => {
    const owner = newUser({
      oauthIdentity: { id: deps.ids.next(), provider: 'google', subject: 'their-own' },
    })
    await deps.users.create(owner, Audit.none('fixture'))
    expect(await codeOf(resolve())).toBe('oauth.account_exists')
    expect(await deps.users.listIdentities(tenant.environmentId, owner.id)).toHaveLength(1)
  })
})

describe('resolveAccount: races', () => {
  test('two sign-ins with one new identity at once: one user, both resolve to it', async () => {
    const [first, second] = await Promise.all([resolve(), resolve()])
    expect(first.user.id).toBe(second.user.id)
    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(types().filter((type) => type === 'user.created')).toHaveLength(1)
  })

  test('a sign-up that loses to another request’s identity ends as a sign-in', async () => {
    const create = deps.users.create.bind(deps.users)
    const spy = spyOn(deps.users, 'create').mockImplementationOnce(async (user, activity) => {
      // The other request commits first, with the same provider account.
      await create(
        {
          ...user,
          id: deps.ids.next(),
          identityId: deps.ids.next(),
          oauthIdentity: user.oauthIdentity && { ...user.oauthIdentity, id: deps.ids.next() },
        },
        activity
      )
      return create(user, Audit.none('fixture'))
    })
    const resolved = await resolve()
    expect(resolved).toMatchObject({ created: false, linked: false })
    expect(
      (await deps.users.list(tenant.environmentId, { page: 1, size: 10, sort: 'createdAt' }))
        .totalCount
    ).toBe(1)
    spy.mockRestore()
  })

  test('an automatic link that loses to the same identity ends as a sign-in', async () => {
    const owner = newUser()
    await deps.users.create(owner, Audit.none('fixture'))
    const link = deps.users.linkIdentity.bind(deps.users)
    const spy = spyOn(deps.users, 'linkIdentity').mockImplementationOnce(
      async (identity, activity, guard) => {
        await link({ ...identity, id: deps.ids.next() }, activity, guard)
        return link(identity, activity, guard)
      }
    )
    expect(await resolve()).toMatchObject({ user: { id: owner.id }, created: false, linked: false })
    expect(await deps.users.listIdentities(tenant.environmentId, owner.id)).toHaveLength(1)
    spy.mockRestore()
  })

  test('an automatic link racing the user’s deletion links nothing to the deleted user', async () => {
    const owner = newUser()
    await deps.users.create(owner, Audit.none('fixture'))
    const link = deps.users.linkIdentity.bind(deps.users)
    const spy = spyOn(deps.users, 'linkIdentity').mockImplementationOnce(async (...args) => {
      await deps.users.delete(tenant.environmentId, owner.id, Audit.none('fixture'))
      return link(...args)
    })
    // The address is free again, so the second look creates a fresh account: never a 500, and
    // never an identity on the deleted one.
    const resolved = await resolve()
    expect(resolved.created).toBe(true)
    expect(resolved.user.id).not.toBe(owner.id)
    spy.mockRestore()
  })

  test('an automatic link racing a change that unverifies the address is refused', async () => {
    const owner = newUser()
    await deps.users.create(owner, Audit.none('fixture'))
    const spy = spyOn(deps.users, 'linkIdentity').mockResolvedValue('user_changed')
    expect(await codeOf(resolve())).toBe('flow.invalid_step')
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  test('a store that keeps refusing the creation ends in a contract error, not a 500', async () => {
    const spy = spyOn(deps.users, 'create').mockResolvedValue(false)
    expect(await codeOf(resolve())).toBe('flow.invalid_step')
    spy.mockRestore()
  })
})

describe('canStillSignIn', () => {
  const settings = (password: boolean, emailCode: boolean): EnvironmentSettings => ({
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    signIn: {
      methods: {
        password: { enabled: password },
        emailCode: { enabled: emailCode },
        emailLink: { enabled: false },
        passkey: { enabled: false },
      },
    },
  })
  const means = (overrides: Partial<SignInMeans> = {}): SignInMeans => ({
    hasPassword: false,
    emailVerified: false,
    passkeys: 0,
    providers: [],
    ...overrides,
  })

  test.each([
    ['nothing at all', settings(true, true), ['google'], means(), false],
    [
      'a password where passwords are on',
      settings(true, false),
      [],
      means({ hasPassword: true }),
      true,
    ],
    [
      'a password where passwords are off',
      settings(false, true),
      [],
      means({ hasPassword: true }),
      false,
    ],
    [
      'a verified address where the email code is on',
      settings(false, true),
      [],
      means({ emailVerified: true }),
      true,
    ],
    [
      'a verified address where the email code is off',
      settings(true, false),
      [],
      means({ emailVerified: true }),
      false,
    ],
    ['an unverified address where the email code is on', settings(true, true), [], means(), false],
    [
      'another identity of an enabled provider',
      settings(false, false),
      ['github'],
      means({ providers: ['github'] }),
      true,
    ],
    [
      'another identity of a provider that is not enabled',
      settings(true, true),
      ['google'],
      means({ providers: ['github'] }),
      false,
    ],
  ] as [string, EnvironmentSettings, ('google' | 'github' | 'apple')[], SignInMeans, boolean][])(
    '%s → %p',
    (_name, environment, providers, remaining, expected) => {
      expect(OAuth.canStillSignIn(environment, providers, remaining)).toBe(expected)
    }
  )

  test('a passkey counts only where the environment has passkeys on', () => {
    const on: EnvironmentSettings = {
      ...settings(false, false),
      signIn: {
        methods: { ...settings(false, false).signIn.methods, passkey: { enabled: true } },
      },
      passkeys: { rpId: 'northline.app' },
    }
    expect(OAuth.canStillSignIn(on, [], means({ passkeys: 1 }))).toBe(true)
    expect(OAuth.canStillSignIn(on, [], means({ passkeys: 0 }))).toBe(false)
    expect(OAuth.canStillSignIn(settings(false, false), [], means({ passkeys: 2 }))).toBe(false)
  })
})

describe('linking and unlinking from a profile: edge cases', () => {
  const actor = { ...TEST_ACTOR, type: 'user' as const }

  test('a link for a user who no longer exists is unauthenticated', async () => {
    expect(await codeOf(OAuth.link(deps, tenant, deps.ids.next(), 'google', profile, actor))).toBe(
      'auth.unauthenticated'
    )
  })

  test('repeating a link of an identity the user already has answers that identity', async () => {
    const owner = newUser()
    await deps.users.create(owner, Audit.none('fixture'))
    const first = await OAuth.link(deps, tenant, owner.id, 'google', profile, actor)
    const second = await OAuth.link(deps, tenant, owner.id, 'google', profile, actor)
    expect(second).toEqual(first)
    expect(types().filter((type) => type === 'user.identity_linked')).toHaveLength(1)
  })

  test('an unlink that loses a race to another removal is not found, or refused, never an error', async () => {
    const owner = newUser()
    await deps.users.create(owner, Audit.none('fixture'))
    const identity = await OAuth.link(deps, tenant, owner.id, 'google', profile, actor)
    const spy = spyOn(deps.users, 'unlinkIdentity').mockResolvedValueOnce('not_found')
    expect(await codeOf(OAuth.unlink(deps, tenant, owner.id, identity.id, actor))).toBe(
      'resource.not_found'
    )
    spy.mockRestore()
  })

  test('removing a provider that vanished between the read and the delete is not found', async () => {
    await OAuth.update(
      deps,
      tenant,
      'google',
      { clientId: 'c', clientSecret: 's', enabled: true },
      TEST_ACTOR
    )
    const spy = spyOn(deps.oauthProviders, 'delete').mockResolvedValueOnce(false)
    expect(await codeOf(OAuth.remove(deps, tenant, 'google', TEST_ACTOR))).toBe(
      'resource.not_found'
    )
    spy.mockRestore()
  })

  test('the callback URL has no doubled slash when PUBLIC_URL ends in one', () => {
    expect(OAuth.callbackUrl({ publicUrl: 'https://auth.example.com/' }, 'apple')).toBe(
      'https://auth.example.com/v1/oauth/callback/apple'
    )
  })
})
