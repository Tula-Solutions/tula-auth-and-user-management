import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { VirtualAuthenticator } from '@tula/conformance'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  MAX_PASSKEYS_PER_USER,
} from '@tula/contract'
import { AuthError, NotFoundError } from '~/exceptions'
import * as WebAuthn from '~/lib/webauthn'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as Passkeys from '~/modules/passkey/service'
import type { PasskeyRecord } from '~/ports/passkey-store'
import { createTestDeps, TEST_TENANT, type TestDeps } from '~/testing'

const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
const RP_ID = 'northline.test'
const ORIGIN = 'https://app.northline.test'
/** A browser's request from the allowed page. */
const REQUEST = { origin: ORIGIN, client: 'web' } as const
const USER = '00000000-0000-7000-8000-0000000000a1'
const self = { userId: USER, sessionId: '00000000-0000-7000-8000-0000000000b1' }
const actor = { type: 'user', id: USER, ipAddress: null, userAgent: null } as const
let deps: TestDeps
let revision = 0

function settings(overrides: Partial<EnvironmentSettings> = {}): EnvironmentSettings {
  return {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    signIn: {
      methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, passkey: { enabled: true } },
    },
    urls: { allowedOrigins: [ORIGIN, 'https://other.example.test'], allowedRedirectUrls: [] },
    passkeys: { rpId: RP_ID },
    ...overrides,
  }
}

function configure(overrides: Partial<EnvironmentSettings> = {}) {
  revision += 1
  deps.environmentSettings.seed(tenant.environmentId, { revision, settings: settings(overrides) })
}

async function addUser(id = USER, email = 'maya@northline.app') {
  await deps.users.create(
    {
      id,
      ...tenant,
      email,
      emailNormalized: email,
      emailVerifiedAt: deps.clock.now(),
      firstName: 'Maya',
      lastName: 'Okafor',
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: null,
    },
    Audit.none('fixture')
  )
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return error instanceof AuthError ? error.code : `threw ${String(error)}`
  }
  return 'resolved'
}

beforeEach(async () => {
  deps = createTestDeps()
  configure()
  await addUser()
})

afterEach(async () => {
  await Notices.settled()
})

describe('available', () => {
  test.each<[boolean, string | null, boolean]>([
    [true, RP_ID, true],
    [false, RP_ID, false],
    [true, null, false],
    [false, null, false],
  ])('method on: %p, relying-party id %p: %p', (enabled, rpId, expected) => {
    expect(
      Passkeys.available({
        ...settings(),
        signIn: { methods: { ...settings().signIn.methods, passkey: { enabled } } },
        passkeys: { rpId },
      })
    ).toBe(expected)
  })
})

describe('relyingParty', () => {
  test('answers the relying-party id and the request’s own origin', async () => {
    expect(await Passkeys.relyingParty(deps, tenant, REQUEST)).toEqual({
      rpId: RP_ID,
      origins: [ORIGIN],
    })
  })

  test.each<[string, string | null | undefined, string]>([
    ['no origin', undefined, 'request.origin_not_allowed'],
    ['a null origin', null, 'request.origin_not_allowed'],
    ['an empty origin', '', 'request.origin_not_allowed'],
    ['an origin the environment does not allow', 'https://evil.test', 'request.origin_not_allowed'],
    [
      'an allowed origin outside the relying party',
      'https://other.example.test',
      'request.origin_not_allowed',
    ],
    ['the allowed origin with a path', `${ORIGIN}/`, 'request.origin_not_allowed'],
    ['the allowed origin in another case', ORIGIN.toUpperCase(), 'request.origin_not_allowed'],
  ])('%s is refused', async (_, origin, code) => {
    expect(await codeOf(Passkeys.relyingParty(deps, tenant, { origin, client: 'web' }))).toBe(code)
  })

  test('passkeys off, or no relying-party id, is method_disabled whatever the origin', async () => {
    configure({
      signIn: { methods: { ...settings().signIn.methods, passkey: { enabled: false } } },
    })
    expect(await codeOf(Passkeys.relyingParty(deps, tenant, REQUEST))).toBe('auth.method_disabled')
    expect(
      await codeOf(
        Passkeys.relyingParty(deps, tenant, { origin: 'https://evil.test', client: 'web' })
      )
    ).toBe('auth.method_disabled')
    // A stored document that has the method on without an id (written by hand) is still off.
    configure({ passkeys: { rpId: null } })
    expect(await codeOf(Passkeys.relyingParty(deps, tenant, REQUEST))).toBe('auth.method_disabled')
  })

  test('another environment’s settings do not apply', async () => {
    const other = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
    expect(await codeOf(Passkeys.relyingParty(deps, other, REQUEST))).toBe('auth.method_disabled')
  })
})

describe('requestOptions', () => {
  const rp = { rpId: RP_ID, origins: [ORIGIN] }

  test('a sign-in’s options carry no allowCredentials', () => {
    expect(Passkeys.requestOptions(rp, 'challenge')).toEqual({
      challenge: 'challenge',
      timeout: 300_000,
      rpId: RP_ID,
      userVerification: 'required',
    })
  })

  test('a known user’s options list their credentials, with transports where known', () => {
    const passkey = (credentialId: string, transports: string[]) =>
      ({ credentialId, transports }) as PasskeyRecord
    expect(
      Passkeys.requestOptions(rp, 'challenge', [passkey('one', ['internal']), passkey('two', [])])
        .allowCredentials
    ).toEqual([
      { type: 'public-key', id: 'one', transports: ['internal'] },
      { type: 'public-key', id: 'two' },
    ])
    expect(Passkeys.requestOptions(rp, 'challenge', []).allowCredentials).toEqual([])
  })
})

describe('challenges of a session', () => {
  test('a challenge is taken once, by the user it was issued to', async () => {
    const challenge = await Passkeys.issueChallenge(deps, tenant, self, 'registration')
    expect(
      await Passkeys.takeChallenge(
        deps,
        tenant,
        { ...self, userId: deps.ids.next() },
        'registration'
      )
    ).toBeNull()
    // Taking it for the wrong user used it up: it is gone for the right one too.
    expect(await Passkeys.takeChallenge(deps, tenant, self, 'registration')).toBeNull()
    const again = await Passkeys.issueChallenge(deps, tenant, self, 'registration')
    expect(again).not.toBe(challenge)
    expect(await Passkeys.takeChallenge(deps, tenant, self, 'step_up')).toBeNull()
    expect(await Passkeys.takeChallenge(deps, tenant, self, 'registration')).toBe(again)
    expect(await Passkeys.takeChallenge(deps, tenant, self, 'registration')).toBeNull()
  })

  test('a challenge lasts five minutes', async () => {
    await Passkeys.issueChallenge(deps, tenant, self, 'step_up')
    deps.clock.advance('299s')
    expect(await Passkeys.takeChallenge(deps, tenant, self, 'step_up')).not.toBeNull()
    await Passkeys.issueChallenge(deps, tenant, self, 'step_up')
    deps.clock.advance('5m')
    expect(await Passkeys.takeChallenge(deps, tenant, self, 'step_up')).toBeNull()
  })
})

describe('registration', () => {
  async function registered(authenticator = new VirtualAuthenticator(), who = self) {
    const options = await Passkeys.startRegistration(deps, tenant, who, REQUEST)
    const credential = await authenticator.create(options, { origin: ORIGIN })
    return Passkeys.finishRegistration(deps, tenant, who, { credential }, REQUEST, {
      ...actor,
      id: who.userId,
    })
  }

  test('the display name is the user’s name, and the app name is the relying party’s', async () => {
    configure({ app: { name: 'Northline', supportEmail: null } })
    const options = await Passkeys.startRegistration(deps, tenant, self, REQUEST)
    expect(options.rp).toEqual({ id: RP_ID, name: 'Northline' })
    expect(options.user).toMatchObject({ name: 'maya@northline.app', displayName: 'Maya Okafor' })
  })

  test('a user who does not exist cannot start or finish', async () => {
    const ghost = { ...self, userId: deps.ids.next() }
    await expect(Passkeys.startRegistration(deps, tenant, ghost, REQUEST)).rejects.toBeInstanceOf(
      NotFoundError
    )
    await Passkeys.issueChallenge(deps, tenant, ghost, 'registration')
    const verify = spyOn(WebAuthn, 'verifyRegistration').mockResolvedValue({
      credentialId: 'credential',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      transports: [],
      aaguid: 'aaguid',
      backupEligible: false,
      backedUp: false,
    })
    try {
      expect(
        await codeOf(
          Passkeys.finishRegistration(
            deps,
            tenant,
            ghost,
            { credential: {} as never },
            REQUEST,
            actor
          )
        )
      ).toBe('passkey.registration_failed')
    } finally {
      verify.mockRestore()
    }
  })

  test('a credential that is already a passkey is refused, for its owner and for anyone else', async () => {
    const authenticator = new VirtualAuthenticator()
    await registered(authenticator)
    const [stored] = await deps.passkeys.listForUser(tenant.environmentId, USER)
    const other = { userId: '00000000-0000-7000-8000-0000000000a2', sessionId: deps.ids.next() }
    await addUser(other.userId, 'zed@northline.app')
    const verify = spyOn(WebAuthn, 'verifyRegistration').mockResolvedValue({
      credentialId: stored?.credentialId as string,
      publicKey: new Uint8Array([1]),
      signCount: 0,
      transports: [],
      aaguid: 'aaguid',
      backupEligible: false,
      backedUp: false,
    })
    try {
      for (const who of [self, other]) {
        await Passkeys.issueChallenge(deps, tenant, who, 'registration')
        expect(
          await codeOf(
            Passkeys.finishRegistration(
              deps,
              tenant,
              who,
              { credential: {} as never },
              REQUEST,
              actor
            )
          )
        ).toBe('passkey.already_registered')
      }
    } finally {
      verify.mockRestore()
    }
    expect(await deps.passkeys.listForUser(tenant.environmentId, other.userId)).toEqual([])
  })

  test('the limit holds at the finish too, for registrations started before it was reached', async () => {
    const pending = []
    for (let count = 0; count < MAX_PASSKEYS_PER_USER + 1; count++) {
      const who = { ...self, sessionId: deps.ids.next() }
      const options = await Passkeys.startRegistration(deps, tenant, who, REQUEST)
      pending.push({
        who,
        credential: await new VirtualAuthenticator().create(options, { origin: ORIGIN }),
      })
    }
    const outcomes = []
    for (const { who, credential } of pending) {
      outcomes.push(
        await codeOf(Passkeys.finishRegistration(deps, tenant, who, { credential }, REQUEST, actor))
      )
    }
    expect(outcomes).toEqual([
      ...Array.from({ length: MAX_PASSKEYS_PER_USER }, () => 'resolved'),
      'passkey.limit_reached',
    ])
    expect(await Passkeys.list(deps, tenant, USER)).toHaveLength(MAX_PASSKEYS_PER_USER)
  })
})

describe('assert', () => {
  async function setUp() {
    const authenticator = new VirtualAuthenticator()
    const options = await Passkeys.startRegistration(deps, tenant, self, REQUEST)
    const credential = await authenticator.create(options, { origin: ORIGIN })
    await Passkeys.finishRegistration(deps, tenant, self, { credential }, REQUEST, actor)
    const rp = { rpId: RP_ID, origins: [ORIGIN] }
    const sign = async (challenge: string, input: object = {}) =>
      authenticator.get(Passkeys.requestOptions(rp, challenge), { origin: ORIGIN, ...input })
    return { rp, sign }
  }

  test('a right assertion answers the passkey and its amr values, and records the use', async () => {
    const { rp, sign } = await setUp()
    deps.clock.advance('1m')
    const asserted = await Passkeys.assert(deps, tenant, {
      credential: await sign('c1', { counter: 2, synced: true }),
      challenge: 'c1',
      rp,
      actor,
    })
    expect(asserted?.methods).toEqual(['swk', 'user'])
    expect(asserted?.passkey.userId).toBe(USER)
    const [stored] = await deps.passkeys.listForUser(tenant.environmentId, USER)
    expect(stored).toMatchObject({
      signCount: 2,
      backupEligible: true,
      backedUp: true,
      lastUsedAt: deps.clock.now(),
    })
  })

  test('the user must match where one is given, and the handle where none is', async () => {
    const { rp, sign } = await setUp()
    const credential = await sign('c1')
    const base = { credential, challenge: 'c1', rp, actor }
    expect(await Passkeys.assert(deps, tenant, { ...base, userId: deps.ids.next() })).toBeNull()
    const { userHandle: _handle, ...response } = credential.response
    const withoutHandle = { ...credential, response }
    expect(await Passkeys.assert(deps, tenant, { ...base, credential: withoutHandle })).toBeNull()
    // With the user known (a second factor, a step-up) the handle may be absent.
    expect(
      await Passkeys.assert(deps, tenant, { ...base, credential: withoutHandle, userId: USER })
    ).not.toBeNull()
    // And a wrong one is refused even then.
    expect(
      await Passkeys.assert(deps, tenant, {
        ...base,
        userId: USER,
        credential: { ...credential, response: { ...credential.response, userHandle: 'b3RoZXI' } },
      })
    ).toBeNull()
  })

  test('another environment, another challenge and a lost race are all null', async () => {
    const { rp, sign } = await setUp()
    const credential = await sign('c1', { counter: 1 })
    const base = { credential, challenge: 'c1', rp, actor }
    const elsewhere = { ...tenant, environmentId: TEST_TENANT.productionEnvironmentId }
    expect(await Passkeys.assert(deps, elsewhere, base)).toBeNull()
    expect(await Passkeys.assert(deps, tenant, { ...base, challenge: 'c2' })).toBeNull()
    // Two requests holding one assertion from a counting authenticator: one records the use.
    const outcomes = await Promise.all([
      Passkeys.assert(deps, tenant, base),
      Passkeys.assert(deps, tenant, base),
    ])
    expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(1)
  })
})
