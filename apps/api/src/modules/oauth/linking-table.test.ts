import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { OAUTH_PROVIDERS, type OAuthProvider } from '@tula/contract'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as OAuth from '~/modules/oauth/service'
import type { NewUser } from '~/ports/user-repository'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

/**
 * The account-linking outcome, per provider (ADR 0026, "Which account: the linking table").
 *
 * This table is the rule, written out; it is not derived from the code. A provider added to
 * the contract's `OAUTH_PROVIDERS` must be given its rows here, or the first test below fails.
 */

/** What the provider's answer says about the address. */
type Address =
  /** An address, and the provider's own evidence that it is verified. */
  | 'verified'
  /** An address without that evidence. */
  | 'unverified'
  /** No address at all. */
  | 'none'

/** The Tula account that has the address the provider reports. */
type Account = 'verified' | 'unverified' | 'absent'

type Outcome =
  /** The user the identity already belongs to signs in. Nothing is looked up by address. */
  | 'signs_in_known_user'
  /** A new user: the identity, the address verified, no password. */
  | 'creates'
  /** The identity is connected to the account that has the address, and that user signs in. */
  | 'links'
  /** Refused, nothing connected. */
  | 'oauth.account_exists'
  /** Refused before any lookup by address. */
  | 'oauth.email_unverified'
  /** Refused before any lookup by address. */
  | 'oauth.email_missing'

/** [the provider's address, the Tula account with that address, identity already known, outcome] */
type Row = [Address, Account, 'known' | 'new', Outcome]

/**
 * The rows every provider has today. They are the same for all of them **because the rule is
 * about the evidence, not the provider**; what counts as the evidence differs and is named in
 * {@link TABLE}. A provider whose rule ever differs gets rows of its own there.
 */
const RULE: Row[] = [
  // A known identity is its user, whatever the provider says about the address and whoever
  // has that address in Tula.
  ['verified', 'verified', 'known', 'signs_in_known_user'],
  ['verified', 'unverified', 'known', 'signs_in_known_user'],
  ['verified', 'absent', 'known', 'signs_in_known_user'],
  ['unverified', 'verified', 'known', 'signs_in_known_user'],
  ['unverified', 'unverified', 'known', 'signs_in_known_user'],
  ['unverified', 'absent', 'known', 'signs_in_known_user'],
  ['none', 'verified', 'known', 'signs_in_known_user'],
  ['none', 'unverified', 'known', 'signs_in_known_user'],
  ['none', 'absent', 'known', 'signs_in_known_user'],
  // A new identity with a verified address: created, linked (both sides verified), or refused.
  ['verified', 'absent', 'new', 'creates'],
  ['verified', 'verified', 'new', 'links'],
  ['verified', 'unverified', 'new', 'oauth.account_exists'],
  // A new identity whose address the provider does not vouch for: refused the same way with
  // and without an account, before the address is looked up.
  ['unverified', 'absent', 'new', 'oauth.email_unverified'],
  ['unverified', 'verified', 'new', 'oauth.email_unverified'],
  ['unverified', 'unverified', 'new', 'oauth.email_unverified'],
  ['none', 'absent', 'new', 'oauth.email_missing'],
  ['none', 'verified', 'new', 'oauth.email_missing'],
  ['none', 'unverified', 'new', 'oauth.email_missing'],
]

/**
 * Every provider: what its adapter takes as evidence that the address is verified, and its
 * rows. Typed by `string` and not by the contract's union on purpose: a provider missing here
 * must fail a test with a message, not a build.
 */
const TABLE: Record<string, { evidence: string; rows: Row[] }> = {
  google: { evidence: 'the ID token’s email_verified', rows: RULE },
  github: { evidence: 'the primary address’s own verified flag from /user/emails', rows: RULE },
  apple: { evidence: 'the ID token’s email_verified (true or "true")', rows: RULE },
  microsoft: {
    evidence:
      'the ID token’s xms_edov, the boolean true; the email claim alone is what a tenant administrator typed',
    rows: RULE,
  },
  discord: {
    evidence:
      'the verified field of /users/@me, the boolean true, beside an email; Discord is OAuth 2.0 and signs nothing',
    rows: RULE,
  },
  linkedin: {
    evidence:
      'the ID token’s email_verified, the boolean true and nothing else (LinkedIn documents a Boolean)',
    rows: RULE,
  },
}

const ADDRESSES: Address[] = ['verified', 'unverified', 'none']
const ACCOUNTS: Account[] = ['verified', 'unverified', 'absent']
const IDENTITIES = ['known', 'new'] as const

const tenant = { ...TEST_TENANT, apiKeyId: 'key' }
const EMAIL = 'maya@northline.app'
const SUBJECT = 'the-providers-id-for-the-account'
const origin = { ipAddress: '203.0.113.7', userAgent: 'tests' }

let deps: TestDeps

beforeEach(() => {
  deps = createTestDeps()
})

async function userCount(): Promise<number> {
  const page = await deps.users.list(tenant.environmentId, { page: 1, size: 100, sort: 'email' })
  return page.totalCount
}

function newUser(overrides: Partial<NewUser>): NewUser {
  return {
    id: deps.ids.next(),
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

describe('the table is complete', () => {
  test('every provider of the contract has rows, and no provider has rows without being one', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...OAUTH_PROVIDERS].sort())
  })

  test.each(Object.entries(TABLE))(
    '%s: one row for every combination, and its evidence is named',
    (_provider, { evidence, rows }) => {
      expect(evidence).not.toBe('')
      const combinations = ADDRESSES.flatMap((address) =>
        ACCOUNTS.flatMap((account) =>
          IDENTITIES.map((identity) => `${address}/${account}/${identity}`)
        )
      )
      expect(
        rows.map(([address, account, identity]) => `${address}/${account}/${identity}`).sort()
      ).toEqual(combinations.sort())
    }
  )
})

const cases = Object.entries(TABLE).flatMap(([provider, { rows }]) =>
  rows.map((row) => [provider, ...row] as [string, ...Row])
)

describe('resolveAccount, by provider', () => {
  test.each(cases)(
    '%s: address %s, Tula account %s, identity %s → %s',
    async (name, address, account, identity, outcome) => {
      const provider = name as OAuthProvider
      // The account that has the address the provider reports, if any.
      const holder =
        account === 'absent'
          ? null
          : newUser({ emailVerifiedAt: account === 'verified' ? deps.clock.now() : null })
      if (holder) {
        await deps.users.create(holder, Audit.none('fixture'))
      }
      // The user the identity already belongs to, if any: someone with another address.
      const known =
        identity === 'known'
          ? newUser({
              email: 'known@northline.app',
              emailNormalized: 'known@northline.app',
              oauthIdentity: { id: deps.ids.next(), provider, subject: SUBJECT },
            })
          : null
      if (known) {
        await deps.users.create(known, Audit.none('fixture'))
      }
      const usersBefore = await userCount()
      const byEmail = spyOn(deps.users, 'findByEmail')

      const result = await OAuth.resolveAccount(
        deps,
        tenant,
        provider,
        {
          subject: SUBJECT,
          email: address === 'none' ? null : EMAIL,
          emailVerified: address === 'verified',
        },
        origin,
        'web'
      ).then(
        (resolved) => ({ resolved, code: undefined }),
        (error: { code?: string }) => ({ resolved: undefined, code: error.code })
      )
      const lookedUpByAddress = byEmail.mock.calls.length > 0
      byEmail.mockRestore()
      await Notices.settled()

      const usersAfter = await userCount()
      const types = deps.activityLog.entries.map((entry) => entry.type)
      const holderIdentities = holder
        ? await deps.users.listIdentities(tenant.environmentId, holder.id)
        : []

      switch (outcome) {
        case 'signs_in_known_user':
          expect(result.resolved).toMatchObject({
            user: { id: known?.id, email: 'known@northline.app' },
            created: false,
            linked: false,
          })
          expect(lookedUpByAddress).toBe(false)
          expect(usersAfter).toBe(usersBefore)
          expect(types).toEqual([])
          expect(holderIdentities).toEqual([])
          break
        case 'creates':
          expect(result.resolved).toMatchObject({ created: true, linked: false })
          expect(result.resolved?.user.emailVerifiedAt).toEqual(deps.clock.now())
          expect(usersAfter).toBe(usersBefore + 1)
          expect(types).toEqual(['user.created'])
          expect(
            (await deps.users.findByEmailWithPassword(tenant.environmentId, EMAIL))?.passwordHash
          ).toBeNull()
          expect(
            (await deps.users.findByIdentity(tenant.environmentId, provider, SUBJECT))?.id
          ).toBe(result.resolved?.user.id)
          break
        case 'links':
          expect(result.resolved).toMatchObject({
            user: { id: holder?.id },
            created: false,
            linked: true,
          })
          expect(usersAfter).toBe(usersBefore)
          expect(types).toEqual(['user.identity_linked'])
          expect(holderIdentities.map((entry) => entry.provider)).toEqual([provider])
          break
        case 'oauth.account_exists':
          expect(result.code).toBe('oauth.account_exists')
          expect(usersAfter).toBe(usersBefore)
          expect(types).toEqual([])
          expect(holderIdentities).toEqual([])
          break
        case 'oauth.email_unverified':
        case 'oauth.email_missing':
          expect(result.code).toBe(outcome)
          // Before any lookup by address: the answer cannot differ by whether an account exists.
          expect(lookedUpByAddress).toBe(false)
          expect(usersAfter).toBe(usersBefore)
          expect(types).toEqual([])
          expect(holderIdentities).toEqual([])
          break
        default:
          throw new Error(`no assertions for the outcome ${String(outcome satisfies never)}`)
      }
      // Nobody is told anything unless something was connected.
      expect(deps.mailer.outbox.length).toBe(outcome === 'links' ? 1 : 0)
    }
  )
})
