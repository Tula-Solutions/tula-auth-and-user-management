import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { type CeremonyInput, VirtualAuthenticator } from '@tula/conformance'
import {
  type AccessTokenClaims,
  CAN_STILL_SIGN_IN_HEADER,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  type Passkey,
  type PasskeyCreationOptions,
  type PasskeyList,
  type PasskeyRequestOptions,
  type PasskeySignInStart,
  type HybridSessionTokens as SessionTokens,
  type TotpEnrolment,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { RateLimitError, ServiceUnavailableError } from '~/exceptions'
import { createApp } from '~/index'
import { base32Decode, totp } from '~/lib/totp'
import * as Audit from '~/modules/audit/service'
import * as Flows from '~/modules/flow/service'
import * as Mfa from '~/modules/mfa/service'
import * as Notices from '~/modules/notice/service'
import * as Passwords from '~/modules/password/service'
import * as DeviceBinding from '~/modules/session/device-binding'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import { DPOP_HEADER, generateSoftwareDeviceKey, jwkThumbprint, proofFor } from '~/testing/proofs'

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const PK_B = 'tula_pk_dev_publishableb000000000000000000'
const TENANT_B = {
  projectId: TEST_TENANT.projectId,
  environmentId: TEST_TENANT.productionEnvironmentId,
}
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const RP_ID = 'northline.test'
const ORIGIN = 'https://app.northline.test'
const OTHER_ALLOWED = 'https://other.example.test'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let secrets: Map<string, string>
let revision = 0

interface Switches {
  passkey?: boolean
  password?: boolean
  emailCode?: boolean
  policy?: EnvironmentSettings['mfa']['policy']
  rpId?: string | null
}

function configure(switches: Switches = {}, environmentId: string = TEST_TENANT.environmentId) {
  revision += 1
  const settings: EnvironmentSettings = {
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    signIn: {
      methods: {
        password: { enabled: switches.password ?? true },
        emailCode: { enabled: switches.emailCode ?? false },
        emailLink: { enabled: false },
        passkey: { enabled: switches.passkey ?? true },
        smsCode: { enabled: false },
      },
    },
    urls: { allowedOrigins: [ORIGIN, OTHER_ALLOWED], allowedRedirectUrls: [] },
    mfa: { policy: switches.policy ?? 'optional', smsCode: { enabled: false } },
    passkeys: { rpId: switches.rpId === undefined ? RP_ID : switches.rpId },
  }
  deps.environmentSettings.seed(environmentId, { revision, settings })
}

beforeEach(async () => {
  secrets = new Map()
  deps = createTestDeps()
  for (const [id, kind] of [
    [TEST_TENANT.environmentId, 'development'],
    [TENANT_B.environmentId, 'production'],
  ] as const) {
    deps.environments.add({
      id,
      projectId: TEST_TENANT.projectId,
      kind,
      createdAt: deps.clock.now(),
    })
  }
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  await seedApiKey(deps, PK_B, TENANT_B)
  configure()
  configure({}, TENANT_B.environmentId)
  app = createApp(deps)
})

const ATTEMPT_PATH = /^\/(?:sign-ups|sign-ins|password-resets)\/([^/]+)\//

interface CallOptions {
  token?: string
  origin?: string | null
  key?: string
  client?: string
  secret?: string | null
  userAgent?: string
  /** The `DPoP` header. */
  dpop?: string
}

/** A native client (tokens in the body) on an allowed origin, remembering attempt secrets. */
async function call(method: string, path: string, body?: unknown, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-publishable-key': options.key ?? PK,
    'x-tula-client': options.client ?? 'ios',
  }
  if (options.origin !== null) {
    headers.origin = options.origin ?? ORIGIN
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  if (options.userAgent) {
    headers['user-agent'] = options.userAgent
  }
  if (options.dpop !== undefined) {
    headers[DPOP_HEADER] = options.dpop
  }
  const secret =
    options.secret === undefined
      ? secrets.get(ATTEMPT_PATH.exec(path)?.[1] ?? '')
      : (options.secret ?? undefined)
  if (secret) {
    headers[FLOW_ATTEMPT_HEADER] = secret
  }
  const res = await app.request(`/v1/client${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const parsed = (await res
    .clone()
    .json()
    .catch(() => null)) as (Partial<FlowAttempt> & { attempt?: Partial<FlowAttempt> }) | null
  const started = parsed?.attempt ?? parsed
  if (started?.id && started.attemptSecret) {
    secrets.set(started.id, started.attemptSecret)
  }
  return res
}

const post = (path: string, body: unknown = {}, options: CallOptions = {}) =>
  call('POST', path, body, options)
const json = async <T>(res: Response) => (await res.json()) as T
const errorOf = async (res: Response) =>
  json<{ status: number; code: string; params?: Record<string, unknown> }>(res)
const codeOf = async (res: Response) => (await errorOf(res)).code
const claimsOf = (token: string) => decodeJwt(token) as unknown as AccessTokenClaims
const codeInSubject = () =>
  /^(\d{6}) /.exec(
    [...deps.mailer.outbox].reverse().find((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''
const subjects = () => deps.mailer.outbox.map((mail) => mail.subject)
const auditTypes = async () =>
  (await deps.activityLog.listAudit(TEST_TENANT.environmentId, { page: 1, size: 200 })).entries.map(
    (entry) => entry.type
  )
const sessionCount = async (userId: string) =>
  (await deps.sessions.listActiveByUser(TEST_TENANT.environmentId, userId, deps.clock.now())).length

async function signUp(email = EMAIL, options: CallOptions = {}): Promise<SessionTokens> {
  const started = await json<FlowAttempt>(
    await post('/sign-ups', { email, password: PASSWORD }, options)
  )
  const done = await json<FlowAttempt>(
    await post(`/sign-ups/${started.id}/verify-email`, { code: codeInSubject() }, options)
  )
  return done.session as SessionTokens
}

/** Sign in with the password; the answer is `complete` or a waiting step. */
async function passwordSignIn(email = EMAIL): Promise<FlowAttempt> {
  const started = await json<FlowAttempt>(await post('/sign-ins', { identifier: email }))
  return json<FlowAttempt>(await post(`/sign-ins/${started.id}/password`, { password: PASSWORD }))
}

/** Register a passkey on an authenticator for the session's user. */
async function register(
  token: string,
  authenticator: VirtualAuthenticator,
  input: Partial<CeremonyInput> = {},
  name?: string
): Promise<Passkey> {
  const options = await json<PasskeyCreationOptions>(
    await post('/me/passkeys/options', {}, { token })
  )
  const credential = await authenticator.create(options, { origin: ORIGIN, ...input })
  const res = await post('/me/passkeys', { credential, ...(name && { name }) }, { token })
  expect(res.status).toBe(201)
  return json<Passkey>(res)
}

/** Start a passkey sign-in. */
async function startPasskey(options: CallOptions = {}): Promise<PasskeySignInStart> {
  const res = await post('/sign-ins/passkey', {}, options)
  expect(res.status).toBe(200)
  return json<PasskeySignInStart>(res)
}

/** A whole passkey sign-in: start, sign, submit. */
async function passkeySignIn(
  authenticator: VirtualAuthenticator,
  input: Partial<CeremonyInput> = {},
  options: CallOptions = {}
): Promise<Response> {
  const started = await startPasskey(options)
  const credential = await authenticator.get(started.options, { origin: ORIGIN, ...input })
  return post(`/sign-ins/${started.attempt.id}/passkey`, { credential }, options)
}

/** A signed-up user with one passkey on a fresh authenticator. */
async function withPasskey(input: Partial<CeremonyInput> = {}) {
  const session = await signUp()
  const authenticator = new VirtualAuthenticator()
  const passkey = await register(session.accessToken, authenticator, input)
  await Notices.settled()
  return { session, authenticator, passkey, userId: claimsOf(session.accessToken).sub }
}

/** Turn two-step verification on for a session's user; returns the authenticator secret. */
async function enrolTotp(token: string): Promise<string> {
  const enrolment = await json<TotpEnrolment>(await post('/me/factors/totp', {}, { token }))
  const confirmed = await post(
    '/me/factors/totp/confirm',
    { code: await totp(base32Decode(enrolment.secret), deps.clock.now()) },
    { token }
  )
  expect(confirmed.status).toBe(200)
  await Notices.settled()
  deps.clock.advance('30s')
  return enrolment.secret
}

/** A stale session: its access token no longer counts as recent. */
async function stale(session: SessionTokens): Promise<SessionTokens> {
  deps.clock.advance('11m')
  return json<SessionTokens>(
    await post('/sessions/refresh', { refreshToken: session.refreshToken })
  )
}

describe('registering a passkey', () => {
  test('the options ask for a discoverable, user-verified credential and say nothing guessable about the user', async () => {
    const session = await signUp()
    const res = await post('/me/passkeys/options', {}, { token: session.accessToken })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const options = await json<PasskeyCreationOptions>(res)
    expect(options).toMatchObject({
      rp: { id: RP_ID, name: 'Tula' },
      user: { name: EMAIL, displayName: EMAIL },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 300_000,
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      attestation: 'none',
    })
    expect(Buffer.from(options.challenge, 'base64url')).toHaveLength(32)
    // The handle is 32 opaque bytes: not the user id, not the email.
    const handle = Buffer.from(options.user.id, 'base64url')
    expect(handle).toHaveLength(32)
    const userId = claimsOf(session.accessToken).sub
    expect(handle.toString('utf8')).not.toContain(userId)
    expect(handle.toString('utf8')).not.toContain('maya')
    // The same user gets the same handle and a new challenge every time.
    const again = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token: session.accessToken })
    )
    expect(again.user.id).toBe(options.user.id)
    expect(again.challenge).not.toBe(options.challenge)
    // Another user's handle is different.
    const other = await signUp('zed@northline.app')
    const theirs = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token: other.accessToken })
    )
    expect(theirs.user.id).not.toBe(options.user.id)
  })

  test('a registered passkey is listed by name, synced state and dates, and never by key or credential id', async () => {
    const session = await signUp()
    const authenticator = new VirtualAuthenticator()
    const passkey = await register(session.accessToken, authenticator, { synced: true }, ' Phone ')
    expect(passkey).toEqual({
      id: expect.any(String),
      name: 'Phone',
      synced: true,
      createdAt: deps.clock.now().toISOString(),
      lastUsedAt: null,
    })
    const second = await register(session.accessToken, new VirtualAuthenticator())
    expect(second).toMatchObject({ name: 'Passkey', synced: false })
    const listed = await call('GET', '/me/passkeys', undefined, { token: session.accessToken })
    expect(listed.headers.get('cache-control')).toBe('no-store')
    const text = await listed.clone().text()
    expect(await json<PasskeyList>(listed)).toEqual({ passkeys: [passkey, second] })
    expect(text).not.toContain(authenticator.credentialIds[0] as string)
    expect(text).not.toContain('publicKey')
    // The second registration excluded the first authenticator's credential.
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token: session.accessToken })
    )
    expect(options.excludeCredentials.map((entry) => entry.id)).toContain(
      authenticator.credentialIds[0] as string
    )
  })

  test('adding a passkey is audited without key material and announced to the owner', async () => {
    const { authenticator, passkey, userId } = await withPasskey()
    const { entries } = await deps.activityLog.listAudit(TEST_TENANT.environmentId, {
      action: 'user.passkey_added',
      page: 1,
      size: 10,
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      actor: { type: 'user', id: userId },
      target: { type: 'user', id: userId },
      data: { passkeyId: passkey.id, synced: false },
    })
    const stored = await deps.passkeys.listForUser(TEST_TENANT.environmentId, userId)
    const recorded = JSON.stringify(entries)
    expect(recorded).not.toContain(authenticator.credentialIds[0] as string)
    expect(recorded).not.toContain(Buffer.from(stored[0]?.publicKey ?? []).toString('base64url'))
    expect(subjects()).toContain('A passkey was added to your Tula account')
    const notice = deps.mailer.outbox.find((mail) => mail.subject.startsWith('A passkey was added'))
    expect(notice?.to).toBe(EMAIL)
    expect(notice?.text).not.toContain(authenticator.credentialIds[0] as string)
  })

  test('a registration challenge works once', async () => {
    const session = await signUp()
    const authenticator = new VirtualAuthenticator()
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token: session.accessToken })
    )
    const credential = await authenticator.create(options, { origin: ORIGIN })
    const body = { credential }
    expect((await post('/me/passkeys', body, { token: session.accessToken })).status).toBe(201)
    const replay = await post('/me/passkeys', body, { token: session.accessToken })
    expect(await errorOf(replay)).toMatchObject({
      status: 422,
      code: 'passkey.registration_failed',
    })
    expect(
      await deps.passkeys.listForUser(TEST_TENANT.environmentId, claimsOf(session.accessToken).sub)
    ).toHaveLength(1)
  })

  test('a failed registration uses the challenge up too', async () => {
    const session = await signUp()
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token: session.accessToken })
    )
    const bad = await new VirtualAuthenticator().create(options, {
      origin: ORIGIN,
      userVerified: false,
    })
    expect(
      await codeOf(await post('/me/passkeys', { credential: bad }, { token: session.accessToken }))
    ).toBe('passkey.registration_failed')
    const good = await new VirtualAuthenticator().create(options, { origin: ORIGIN })
    expect(
      await codeOf(await post('/me/passkeys', { credential: good }, { token: session.accessToken }))
    ).toBe('passkey.registration_failed')
  })

  test.each<[string, Partial<CeremonyInput>]>([
    ['client data for another origin', { origin: 'https://evil.test' }],
    ['client data for another allowed origin than the request’s', { origin: OTHER_ALLOWED }],
    ['an RP ID hash for another relying party', { rpId: 'evil.test' }],
    ['no user verification', { userVerified: false }],
  ])('a response with %s is refused and stores nothing', async (_, input) => {
    const session = await signUp()
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token: session.accessToken })
    )
    const credential = await new VirtualAuthenticator().create(options, {
      origin: ORIGIN,
      ...input,
    })
    const res = await post('/me/passkeys', { credential }, { token: session.accessToken })
    expect(await errorOf(res)).toMatchObject({ status: 422, code: 'passkey.registration_failed' })
    expect(
      await call('GET', '/me/passkeys', undefined, { token: session.accessToken }).then(
        json<PasskeyList>
      )
    ).toEqual({ passkeys: [] })
    expect(await auditTypes()).not.toContain('user.passkey_added')
  })

  test('a finish with no challenge, an expired one, or another session’s is refused', async () => {
    const session = await signUp()
    const token = session.accessToken
    const authenticator = new VirtualAuthenticator()
    const fake = await authenticator.create(
      {
        rp: { id: RP_ID },
        user: { id: 'aGFuZGxl' },
        challenge: 'bm8tc3VjaC1jaGFsbGVuZ2U',
        pubKeyCredParams: [{ alg: -7 }],
      },
      { origin: ORIGIN }
    )
    expect(await codeOf(await post('/me/passkeys', { credential: fake }, { token }))).toBe(
      'passkey.registration_failed'
    )
    // Expired: five minutes and no longer.
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token })
    )
    const late = await new VirtualAuthenticator().create(options, { origin: ORIGIN })
    deps.clock.advance('5m')
    const renewed = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    expect(
      await codeOf(await post('/me/passkeys', { credential: late }, { token: renewed.accessToken }))
    ).toBe('passkey.registration_failed')
    // Another session of the same user asked: this session has no challenge.
    const elsewhere = (await passwordSignIn()).session as SessionTokens
    const theirs = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token: elsewhere.accessToken })
    )
    const crossed = await new VirtualAuthenticator().create(theirs, { origin: ORIGIN })
    const fresh = (await passwordSignIn()).session as SessionTokens
    expect(
      await codeOf(
        await post('/me/passkeys', { credential: crossed }, { token: fresh.accessToken })
      )
    ).toBe('passkey.registration_failed')
    // The session that asked can still finish.
    expect(
      (await post('/me/passkeys', { credential: crossed }, { token: elsewhere.accessToken })).status
    ).toBe(201)
  })

  test('a user may have ten passkeys and no more', async () => {
    const session = await signUp()
    for (let count = 0; count < 10; count++) {
      await register(session.accessToken, new VirtualAuthenticator())
    }
    // Past the per-IP window of the registration routes, with a token that is still valid.
    deps.clock.advance('1m')
    const { accessToken } = await json<SessionTokens>(
      await post('/sessions/refresh', { refreshToken: session.refreshToken })
    )
    const refused = await post('/me/passkeys/options', {}, { token: accessToken })
    expect(await errorOf(refused)).toMatchObject({ status: 409, code: 'passkey.limit_reached' })
  })

  test('every route that changes passkeys needs a recent authentication; listing does not', async () => {
    const { session, passkey } = await withPasskey()
    const old = await stale(session)
    const token = old.accessToken
    for (const res of [
      await post('/me/passkeys/options', {}, { token }),
      await post('/me/passkeys', { credential: {} }, { token }),
      await call('PATCH', `/me/passkeys/${passkey.id}`, { name: 'x' }, { token }),
      await call('DELETE', `/me/passkeys/${passkey.id}`, undefined, { token }),
    ]) {
      expect(await errorOf(res)).toMatchObject({
        status: 403,
        code: 'auth.step_up_required',
        params: { methods: 'passkey,password,email_code' },
      })
    }
    expect((await call('GET', '/me/passkeys', undefined, { token })).status).toBe(200)
    expect((await call('GET', '/me/passkeys')).status).toBe(401)
  })

  test('passkeys switched off, or no relying-party id: registration is refused before anything is stored', async () => {
    const session = await signUp()
    const token = session.accessToken
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token })
    )
    const credential = await new VirtualAuthenticator().create(options, { origin: ORIGIN })
    for (const switches of [{ passkey: false }, { passkey: false, rpId: null }]) {
      configure(switches)
      for (const res of [
        await post('/me/passkeys/options', {}, { token }),
        await post('/me/passkeys', { credential }, { token }),
      ]) {
        expect(await errorOf(res)).toMatchObject({
          status: 403,
          code: 'auth.method_disabled',
          params: { method: 'passkey' },
        })
      }
    }
    // Switched back on: the challenge was not used up by the refusals.
    configure()
    expect((await post('/me/passkeys', { credential }, { token })).status).toBe(201)
  })

  test.each<[string, string | null]>([
    ['no Origin header', null],
    ['an origin the environment does not allow', 'https://evil.test'],
    ['an allowed origin that does not belong to the relying party', OTHER_ALLOWED],
    ['a look-alike of the relying party', 'https://northline.test.evil.test'],
  ])('a request with %s cannot register', async (_, origin) => {
    const session = await signUp()
    const token = session.accessToken
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token })
    )
    const credential = await new VirtualAuthenticator().create(options, {
      origin: origin ?? ORIGIN,
    })
    for (const res of [
      await post('/me/passkeys/options', {}, { token, origin }),
      await post('/me/passkeys', { credential }, { token, origin }),
    ]) {
      expect(await errorOf(res)).toMatchObject({ status: 403, code: 'request.origin_not_allowed' })
    }
  })

  test('a subdomain of the relying party and the relying party itself may both register', async () => {
    revision += 1
    deps.environmentSettings.seed(TEST_TENANT.environmentId, {
      revision,
      settings: {
        ...DEFAULT_ENVIRONMENT_SETTINGS,
        signIn: {
          methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, passkey: { enabled: true } },
        },
        urls: {
          allowedOrigins: [ORIGIN, `https://${RP_ID}`],
          allowedRedirectUrls: [],
        },
        passkeys: { rpId: RP_ID },
      },
    })
    const session = await signUp()
    const token = session.accessToken
    for (const origin of [ORIGIN, `https://${RP_ID}`]) {
      const options = await json<PasskeyCreationOptions>(
        await post('/me/passkeys/options', {}, { token, origin })
      )
      const credential = await new VirtualAuthenticator().create(options, { origin })
      expect((await post('/me/passkeys', { credential }, { token, origin })).status).toBe(201)
    }
  })

  test('a malformed body is a validation error', async () => {
    const session = await signUp()
    const token = session.accessToken
    for (const body of [{}, { credential: 'x' }, { credential: { id: 'a', type: 'public-key' } }]) {
      expect((await post('/me/passkeys', body, { token })).status).toBe(422)
    }
  })
})

describe('renaming and removing', () => {
  test('a passkey can be renamed by its owner only', async () => {
    const { session, passkey } = await withPasskey()
    const renamed = await call(
      'PATCH',
      `/me/passkeys/${passkey.id}`,
      { name: 'MacBook' },
      { token: session.accessToken }
    )
    expect(await json<Passkey>(renamed)).toEqual({ ...passkey, name: 'MacBook' })
    expect(await auditTypes()).toContain('user.passkey_renamed')
    const other = await signUp('zed@northline.app')
    for (const id of [passkey.id, '00000000-0000-7000-8000-0000000000ff']) {
      const res = await call(
        'PATCH',
        `/me/passkeys/${id}`,
        { name: 'x' },
        { token: other.accessToken }
      )
      expect(res.status).toBe(404)
    }
    for (const name of ['', '   ', 'a'.repeat(65)]) {
      const res = await call(
        'PATCH',
        `/me/passkeys/${passkey.id}`,
        { name },
        { token: session.accessToken }
      )
      expect(res.status).toBe(422)
    }
    expect(
      (
        await call(
          'PATCH',
          '/me/passkeys/not-a-uuid',
          { name: 'x' },
          { token: session.accessToken }
        )
      ).status
    ).toBe(422)
  })

  test('removing a passkey is audited, announced, and ends its use', async () => {
    const { session, authenticator, passkey, userId } = await withPasskey()
    const removed = await call('DELETE', `/me/passkeys/${passkey.id}`, undefined, {
      token: session.accessToken,
    })
    expect(removed.status).toBe(204)
    await Notices.settled()
    expect(subjects()).toContain('A passkey was removed from your Tula account')
    const { entries } = await deps.activityLog.listAudit(TEST_TENANT.environmentId, {
      action: 'user.passkey_removed',
      page: 1,
      size: 10,
    })
    expect(entries.map((entry) => entry.data)).toEqual([{ passkeyId: passkey.id, method: 'user' }])
    expect(await deps.passkeys.listForUser(TEST_TENANT.environmentId, userId)).toEqual([])
    expect(await codeOf(await passkeySignIn(authenticator))).toBe('auth.invalid_credentials')
    // Gone, and never another user's.
    const again = await call('DELETE', `/me/passkeys/${passkey.id}`, undefined, {
      token: session.accessToken,
    })
    expect(again.status).toBe(404)
  })

  test('another user cannot remove a passkey', async () => {
    const { passkey, userId } = await withPasskey()
    const other = await signUp('zed@northline.app')
    const res = await call('DELETE', `/me/passkeys/${passkey.id}`, undefined, {
      token: other.accessToken,
    })
    expect(res.status).toBe(404)
    expect(await deps.passkeys.listForUser(TEST_TENANT.environmentId, userId)).toHaveLength(1)
  })

  test('the last way to sign in cannot be removed', async () => {
    const { session, passkey, userId } = await withPasskey()
    const second = await register(session.accessToken, new VirtualAuthenticator())
    // Passwords and the email code are switched off: only the passkeys let this user in.
    configure({ password: false, emailCode: false })
    const token = session.accessToken
    expect((await call('DELETE', `/me/passkeys/${passkey.id}`, undefined, { token })).status).toBe(
      204
    )
    const refused = await call('DELETE', `/me/passkeys/${second.id}`, undefined, { token })
    expect(await errorOf(refused)).toMatchObject({
      status: 409,
      code: 'passkey.last_sign_in_method',
    })
    expect(await deps.passkeys.listForUser(TEST_TENANT.environmentId, userId)).toHaveLength(1)
    // A verified address counts once the email code is on.
    configure({ password: false, emailCode: true })
    expect((await call('DELETE', `/me/passkeys/${second.id}`, undefined, { token })).status).toBe(
      204
    )
  })

  test('with passkeys switched off a user can still list and remove theirs', async () => {
    const { session, passkey } = await withPasskey()
    configure({ passkey: false })
    const token = session.accessToken
    expect(
      (await json<PasskeyList>(await call('GET', '/me/passkeys', undefined, { token }))).passkeys
    ).toHaveLength(1)
    expect((await call('DELETE', `/me/passkeys/${passkey.id}`, undefined, { token })).status).toBe(
      204
    )
  })
})

describe('signing in with a passkey', () => {
  test('the start is the same for every caller: no identifier, no allowCredentials, a fresh challenge', async () => {
    await withPasskey()
    const first = await startPasskey()
    const second = await startPasskey({ origin: ORIGIN, userAgent: 'someone-else/1.0' })
    expect(first.attempt).toMatchObject({
      kind: 'sign_in',
      step: { status: 'needs_first_factor', strategies: ['passkey'] },
      attemptSecret: expect.stringMatching(/^tula_at_/),
    })
    expect(first.options).toEqual({
      challenge: expect.any(String),
      timeout: 300_000,
      rpId: RP_ID,
      userVerification: 'required',
    })
    expect(Object.keys(second.options).sort()).toEqual(Object.keys(first.options).sort())
    expect({ ...second.options, challenge: '' }).toEqual({ ...first.options, challenge: '' })
    expect(second.options.challenge).not.toBe(first.options.challenge)
    expect(Buffer.from(first.options.challenge, 'base64url')).toHaveLength(32)
  })

  test('a passkey is offered as a first factor only where the environment has it on', async () => {
    const on = await json<FlowAttempt>(
      await post('/sign-ins', { identifier: 'nobody@northline.app' })
    )
    expect(on.step).toEqual({ status: 'needs_first_factor', strategies: ['password', 'passkey'] })
    configure({ passkey: false })
    const off = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    expect(off.step).toEqual({ status: 'needs_password' })
    expect(await codeOf(await post('/sign-ins/passkey'))).toBe('auth.method_disabled')
  })

  test('an assertion signs the user in, and the session says how: hwk, user and mfa', async () => {
    const { authenticator, passkey, userId } = await withPasskey()
    deps.clock.advance('1m')
    const res = await passkeySignIn(authenticator)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const done = await json<FlowAttempt>(res)
    expect(done.step).toMatchObject({ status: 'complete', userId })
    const claims = claimsOf(done.session?.accessToken as string)
    expect(new Set(claims.amr)).toEqual(new Set(['hwk', 'user', 'mfa']))
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    const [listed] = (
      await json<PasskeyList>(
        await call('GET', '/me/passkeys', undefined, { token: done.session?.accessToken })
      )
    ).passkeys
    expect(listed).toEqual({ ...passkey, lastUsedAt: deps.clock.now().toISOString() })
  })

  test('a synced passkey is recorded as swk', async () => {
    const { authenticator } = await withPasskey({ synced: true })
    const done = await json<FlowAttempt>(await passkeySignIn(authenticator))
    expect(new Set(claimsOf(done.session?.accessToken as string).amr)).toEqual(
      new Set(['swk', 'user', 'mfa'])
    )
  })

  test('a passkey satisfies two-step verification: no second factor is asked, with TOTP or a required policy', async () => {
    const { session, authenticator } = await withPasskey()
    await enrolTotp(session.accessToken)
    // The password now stops at the second factor…
    expect((await passwordSignIn()).step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code', 'passkey'],
    })
    // …and the passkey does not.
    const done = await json<FlowAttempt>(await passkeySignIn(authenticator))
    expect(done.step.status).toBe('complete')
    expect(done.session?.accessToken).toBeDefined()
    configure({ policy: 'required' })
    expect((await json<FlowAttempt>(await passkeySignIn(authenticator))).step.status).toBe(
      'complete'
    )
  })

  test('where a second factor is required, a user whose only factor is a passkey signs in with it and enrols nothing', async () => {
    const { authenticator } = await withPasskey()
    configure({ policy: 'required' })
    const done = await json<FlowAttempt>(await passkeySignIn(authenticator))
    expect(done.step.status).toBe('complete')
  })

  test.each<[string, Partial<CeremonyInput>]>([
    ['client data for another origin', { origin: 'https://evil.test' }],
    ['client data for another allowed origin than the request’s', { origin: OTHER_ALLOWED }],
    ['an RP ID hash for another relying party', { rpId: 'evil.test' }],
    ['no user verification', { userVerified: false }],
  ])('an assertion with %s is the generic failure and creates no session', async (_, input) => {
    const { authenticator, userId } = await withPasskey()
    const before = await sessionCount(userId)
    const res = await passkeySignIn(authenticator, input)
    expect(await errorOf(res)).toMatchObject({ status: 401, code: 'auth.invalid_credentials' })
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await sessionCount(userId)).toBe(before)
  })

  test('an unknown credential, another environment’s, a wrong user handle and a stale challenge fail the same way', async () => {
    const { authenticator, userId } = await withPasskey()
    const before = await sessionCount(userId)
    // A credential the server never saw.
    const stranger = new VirtualAuthenticator()
    await stranger.create(
      {
        rp: { id: RP_ID },
        user: { id: 'aGFuZGxl' },
        challenge: 'YQ',
        pubKeyCredParams: [{ alg: -7 }],
      },
      { origin: ORIGIN }
    )
    expect(await codeOf(await passkeySignIn(stranger))).toBe('auth.invalid_credentials')
    // This environment's passkey presented to another environment.
    expect(await codeOf(await passkeySignIn(authenticator, {}, { key: PK_B }))).toBe(
      'auth.invalid_credentials'
    )
    // The right credential with another user handle.
    const started = await startPasskey()
    const assertion = await authenticator.get(started.options, { origin: ORIGIN })
    expect(
      await codeOf(
        await post(`/sign-ins/${started.attempt.id}/passkey`, {
          credential: { ...assertion, response: { ...assertion.response, userHandle: 'b3RoZXI' } },
        })
      )
    ).toBe('auth.invalid_credentials')
    // No user handle at all: a sign-in has no other way to know whose credential this is.
    const noHandle = await startPasskey()
    const { userHandle: _handle, ...response } = (
      await authenticator.get(noHandle.options, { origin: ORIGIN })
    ).response
    expect(
      await codeOf(
        await post(`/sign-ins/${noHandle.attempt.id}/passkey`, {
          credential: { ...assertion, response },
        })
      )
    ).toBe('auth.invalid_credentials')
    // A challenge older than five minutes, on an attempt that is still open.
    const slow = await startPasskey()
    const late = await authenticator.get(slow.options, { origin: ORIGIN })
    deps.clock.advance('5m')
    expect(
      await codeOf(await post(`/sign-ins/${slow.attempt.id}/passkey`, { credential: late }))
    ).toBe('auth.invalid_credentials')
    expect(await sessionCount(userId)).toBe(before)
  })

  test('a replayed assertion is refused: on its own attempt, and on a new one', async () => {
    const { authenticator, userId } = await withPasskey()
    const started = await startPasskey()
    const credential = await authenticator.get(started.options, { origin: ORIGIN })
    const path = `/sign-ins/${started.attempt.id}/passkey`
    expect((await post(path, { credential })).status).toBe(200)
    const before = await sessionCount(userId)
    // The attempt is complete: it answers like one that never existed.
    expect(await codeOf(await post(path, { credential }))).toBe('flow.not_found')
    // The same assertion presented for another attempt's challenge.
    const next = await startPasskey()
    expect(await codeOf(await post(`/sign-ins/${next.attempt.id}/passkey`, { credential }))).toBe(
      'auth.invalid_credentials'
    )
    expect(await sessionCount(userId)).toBe(before)
  })

  test('the challenge is used up by the first assertion presented, right or wrong', async () => {
    const { authenticator } = await withPasskey()
    const started = await startPasskey()
    const path = `/sign-ins/${started.attempt.id}/passkey`
    const wrong = await authenticator.get(started.options, { origin: ORIGIN, userVerified: false })
    expect(await codeOf(await post(path, { credential: wrong }))).toBe('auth.invalid_credentials')
    const right = await authenticator.get(started.options, { origin: ORIGIN })
    expect(await codeOf(await post(path, { credential: right }))).toBe('auth.invalid_credentials')
  })

  test('two requests with one assertion create one session', async () => {
    const { authenticator, userId } = await withPasskey()
    const before = await sessionCount(userId)
    const started = await startPasskey()
    const credential = await authenticator.get(started.options, { origin: ORIGIN })
    const path = `/sign-ins/${started.attempt.id}/passkey`
    const outcomes = await Promise.all([post(path, { credential }), post(path, { credential })])
    expect(outcomes.map((res) => res.status).sort()).not.toEqual([200, 200])
    expect(outcomes.filter((res) => res.status === 200)).toHaveLength(1)
    expect(await sessionCount(userId)).toBe(before + 1)
  })

  test('a signature counter must grow: one that does not is refused and audited, and zero is fine', async () => {
    const { authenticator, userId } = await withPasskey()
    // An authenticator that keeps no counter: 0 again and again.
    expect((await passkeySignIn(authenticator)).status).toBe(200)
    expect((await passkeySignIn(authenticator)).status).toBe(200)
    // It starts counting.
    expect((await passkeySignIn(authenticator, { counter: 5 })).status).toBe(200)
    const before = await sessionCount(userId)
    for (const counter of [5, 4, 0]) {
      const res = await passkeySignIn(authenticator, { counter })
      expect(await errorOf(res)).toMatchObject({ status: 401, code: 'auth.invalid_credentials' })
    }
    expect(await sessionCount(userId)).toBe(before)
    const { entries } = await deps.activityLog.listAudit(TEST_TENANT.environmentId, {
      action: 'user.passkey_counter_regressed',
      page: 1,
      size: 10,
    })
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ target: { type: 'user', id: userId } })
    expect(JSON.stringify(entries)).not.toContain(authenticator.credentialIds[0] as string)
    // The stored counter did not move: the next higher one works.
    expect((await passkeySignIn(authenticator, { counter: 6 })).status).toBe(200)
  })

  test('the attempt’s secret is required, and a refusal uses nothing up', async () => {
    const { authenticator } = await withPasskey()
    const started = await startPasskey()
    const other = await startPasskey()
    const credential = await authenticator.get(started.options, { origin: ORIGIN })
    const path = `/sign-ins/${started.attempt.id}/passkey`
    for (const secret of [null, 'tula_at_wrong', other.attempt.attemptSecret as string]) {
      const res = await post(path, { credential }, { secret })
      expect(await errorOf(res)).toMatchObject({ status: 404, code: 'flow.not_found' })
    }
    const unknown = await post(
      '/sign-ins/00000000-0000-7000-8000-0000000000ff/passkey',
      { credential },
      { secret: started.attempt.attemptSecret as string }
    )
    expect(await codeOf(unknown)).toBe('flow.not_found')
    expect((await post(path, { credential })).status).toBe(200)
  })

  test('a passkey cannot be submitted to an attempt that was not offered one', async () => {
    const { authenticator } = await withPasskey()
    configure({ passkey: false })
    const password = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    configure()
    const started = await startPasskey()
    const credential = await authenticator.get(started.options, { origin: ORIGIN })
    const res = await post(`/sign-ins/${password.id}/passkey`, { credential })
    expect(await errorOf(res)).toMatchObject({ status: 409, code: 'flow.invalid_step' })
  })

  test('passkeys switched off mid-attempt: the step is refused and nothing is used up', async () => {
    const { authenticator } = await withPasskey()
    const started = await startPasskey()
    const credential = await authenticator.get(started.options, { origin: ORIGIN })
    const path = `/sign-ins/${started.attempt.id}/passkey`
    configure({ passkey: false })
    expect(await errorOf(await post(path, { credential }))).toMatchObject({
      status: 403,
      code: 'auth.method_disabled',
    })
    configure()
    expect((await post(path, { credential })).status).toBe(200)
  })

  test('a browser attempt is refused from an origin the environment does not allow, at the start and at the step', async () => {
    const { authenticator, userId } = await withPasskey()
    const before = await sessionCount(userId)
    const refused = await post(
      '/sign-ins/passkey',
      {},
      { client: 'web', origin: 'https://evil.test' }
    )
    expect(await errorOf(refused)).toMatchObject({
      status: 403,
      code: 'request.origin_not_allowed',
    })
    const started = await startPasskey({ client: 'web' })
    const credential = await authenticator.get(started.options, { origin: ORIGIN })
    const path = `/sign-ins/${started.attempt.id}/passkey`
    const foreign = await post(path, { credential }, { client: 'web', origin: 'https://evil.test' })
    expect(await codeOf(foreign)).toBe('request.origin_not_allowed')
    expect(foreign.headers.get('set-cookie')).toBeNull()
    expect(await sessionCount(userId)).toBe(before)
    // Nothing was used up: the allowed page completes, and gets the cookie.
    const done = await post(path, { credential }, { client: 'web' })
    expect(done.status).toBe(200)
    expect(done.headers.get('set-cookie')).toContain('HttpOnly')
  })

  test('a start with no Origin, or from an origin outside the relying party, is refused', async () => {
    for (const origin of [null, OTHER_ALLOWED]) {
      expect(await codeOf(await post('/sign-ins/passkey', {}, { origin }))).toBe(
        'request.origin_not_allowed'
      )
    }
  })

  test('a banned user learns of the ban only after proving the passkey', async () => {
    const { authenticator, userId } = await withPasskey()
    await deps.users.setBanned(
      TEST_TENANT.environmentId,
      userId,
      deps.clock.now(),
      deps.clock.now(),
      Audit.none('fixture')
    )
    const res = await passkeySignIn(authenticator)
    expect(await errorOf(res)).toMatchObject({ status: 403, code: 'auth.user_banned' })
    expect(await codeOf(await passkeySignIn(authenticator, { userVerified: false }))).toBe(
      'auth.invalid_credentials'
    )
  })

  test('a sign-in from a new device is announced, through the same finish as every sign-in', async () => {
    const { authenticator } = await withPasskey()
    deps.mailer.outbox.length = 0
    const res = await passkeySignIn(
      authenticator,
      {},
      {
        client: 'web',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      }
    )
    expect(res.status).toBe(200)
    await Notices.settled()
    expect(subjects()).toContain('New sign-in to your Tula account')
  })

  test('tries are limited per IP', async () => {
    const started = await startPasskey()
    const statuses: number[] = []
    for (let n = 0; n < 31; n++) {
      statuses.push(
        (await post(`/sign-ins/${started.attempt.id}/passkey`, { credential: {} })).status
      )
    }
    expect(statuses.slice(0, 30).every((status) => status === 422)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe('a passkey sign-in by a user whose address is not verified', () => {
  /** A user with an unverified address and a passkey; a password only when asked. */
  async function unverifiedWithPasskey(options: { password?: boolean } = {}) {
    const userId = deps.ids.next()
    await deps.users.create(
      {
        id: userId,
        projectId: TEST_TENANT.projectId,
        environmentId: TEST_TENANT.environmentId,
        email: EMAIL,
        emailNormalized: EMAIL,
        emailVerifiedAt: null,
        firstName: null,
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: options.password ? await Passwords.hash(PASSWORD) : null,
      },
      Audit.none('fixture')
    )
    const session = await Sessions.create(deps, TEST_TENANT, {
      userId,
      client: 'ios',
      userAgent: null,
      ipAddress: null,
      authMethods: ['pwd'],
    })
    const token = session.accessToken as string
    const authenticator = new VirtualAuthenticator()
    await register(token, authenticator)
    await Notices.settled()
    return { userId, authenticator, token }
  }

  /** A passkey sign-in that stops at `needs_email_verification`; returns the waiting attempt. */
  async function parked(authenticator: VirtualAuthenticator): Promise<FlowAttempt> {
    const waiting = await json<FlowAttempt>(await passkeySignIn(authenticator))
    expect(waiting.step.status).toBe('needs_email_verification')
    return waiting
  }

  test('with passwords off, the emailed code completes the sign-in', async () => {
    const { authenticator, userId } = await unverifiedWithPasskey()
    configure({ password: false })
    const waiting = await parked(authenticator)
    const res = await post(`/sign-ins/${waiting.id}/verify-email`, { code: codeInSubject() })
    expect(res.status).toBe(200)
    const done = await json<FlowAttempt>(res)
    expect(done.step).toMatchObject({ status: 'complete', userId })
    expect(new Set(claimsOf(done.session?.accessToken as string).amr)).toEqual(
      new Set(['hwk', 'user', 'mfa', 'email'])
    )
    expect(
      (await deps.users.findById(TEST_TENANT.environmentId, userId))?.emailVerifiedAt
    ).not.toBeNull()
  })

  test('a user with an authenticator app is not asked for it again: the passkey was the second factor', async () => {
    const { authenticator, token } = await unverifiedWithPasskey()
    await enrolTotp(token)
    const waiting = await parked(authenticator)
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${waiting.id}/verify-email`, { code: codeInSubject() })
    )
    expect(done.step.status).toBe('complete')
    expect(done.session?.accessToken).toBeDefined()
  })

  test('where a second factor is required, nothing is enrolled after the code', async () => {
    const { authenticator } = await unverifiedWithPasskey()
    configure({ policy: 'required', password: false })
    const waiting = await parked(authenticator)
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${waiting.id}/verify-email`, { code: codeInSubject() })
    )
    expect(done.step.status).toBe('complete')
  })

  test('with passwords off, the code can be sent again', async () => {
    const { authenticator } = await unverifiedWithPasskey()
    configure({ password: false })
    const waiting = await parked(authenticator)
    const first = codeInSubject()
    deps.clock.advance('61s')
    const res = await post(`/sign-ins/${waiting.id}/resend-code`)
    expect(res.status).toBe(200)
    expect((await json<FlowAttempt>(res)).step.status).toBe('needs_email_verification')
    expect(codeInSubject()).not.toBe(first)
    const done = await post(`/sign-ins/${waiting.id}/verify-email`, { code: codeInSubject() })
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
  })

  test('passkeys switched off while the attempt waits: the code and the resend are refused, and nothing is used up', async () => {
    const { authenticator, userId } = await unverifiedWithPasskey()
    const waiting = await parked(authenticator)
    const code = codeInSubject()
    const before = await sessionCount(userId)
    configure({ passkey: false })
    const refused = await post(`/sign-ins/${waiting.id}/verify-email`, { code })
    expect(await errorOf(refused)).toMatchObject({ status: 403, code: 'auth.method_disabled' })
    expect(await codeOf(await post(`/sign-ins/${waiting.id}/resend-code`))).toBe(
      'auth.method_disabled'
    )
    expect(await sessionCount(userId)).toBe(before)
    // The code was not spent: it completes once passkeys are back on.
    configure()
    const done = await post(`/sign-ins/${waiting.id}/verify-email`, { code })
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
  })

  test('the code is refused from an origin outside the relying party', async () => {
    const { authenticator } = await unverifiedWithPasskey()
    const waiting = await parked(authenticator)
    const res = await post(
      `/sign-ins/${waiting.id}/verify-email`,
      { code: codeInSubject() },
      { origin: OTHER_ALLOWED }
    )
    expect(await codeOf(res)).toBe('request.origin_not_allowed')
  })

  test('the waiting attempt is stored with the user’s address as its identifier', async () => {
    const { authenticator, userId } = await unverifiedWithPasskey()
    const waiting = await parked(authenticator)
    expect(await deps.flowAttempts.findById(TEST_TENANT.environmentId, waiting.id)).toMatchObject({
      identifier: EMAIL,
      userId,
      status: 'needs_email_verification',
    })
  })

  test('the address verified this way removes a password the verifier never proved', async () => {
    const { authenticator } = await unverifiedWithPasskey({ password: true })
    const waiting = await parked(authenticator)
    const done = await post(`/sign-ins/${waiting.id}/verify-email`, { code: codeInSubject() })
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
    expect(
      (await deps.users.findByEmailWithPassword(TEST_TENANT.environmentId, EMAIL))?.passwordHash
    ).toBeNull()
    await Notices.settled()
  })
})

describe('the environment’s ceilings and a passkey sign-in', () => {
  const tenant = {
    projectId: TEST_TENANT.projectId,
    environmentId: TEST_TENANT.environmentId,
    apiKeyId: '00000000-0000-7000-8000-0000000000aa',
  }
  const context = {
    client: 'ios',
    userAgent: null,
    ipAddress: null,
    originAllowed: true,
    origin: ORIGIN,
  } as const

  test('starts have a ceiling of their own: idle sign-in pages cannot use up the one code steps need', async () => {
    const { session, authenticator } = await withPasskey()
    await enrolTotp(session.accessToken)
    const attempt = await passwordSignIn()
    expect(attempt.step.status).toBe('needs_second_factor')
    // Every open sign-in page asks for a start, signed in to nothing. Ask until refused.
    let starts = 0
    const limit = Math.max(...Object.values(Flows.ENVIRONMENT_RATE_LIMITS)) + 1
    try {
      for (; starts <= limit; starts++) {
        await Flows.startPasskeySignIn(deps, tenant, context)
      }
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError)
    }
    expect(await errorOf(await post('/sign-ins/passkey'))).toMatchObject({
      status: 429,
      code: 'rate_limited',
    })
    // A user in the middle of signing in is not affected.
    const options = await post(`/sign-ins/${attempt.id}/second-factor/passkey/options`)
    expect(options.status).toBe(200)
    const done = await post(`/sign-ins/${attempt.id}/second-factor`, {
      method: 'passkey',
      credential: await authenticator.get(await json<PasskeyRequestOptions>(options), {
        origin: ORIGIN,
      }),
    })
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
    expect(starts).toBe(Flows.ENVIRONMENT_RATE_LIMITS.passkeyStart)
  })

  test.each<[string, () => unknown, number, string]>([
    [
      'at its ceiling',
      () => ({ allowed: false, remaining: 0, retryAfterMs: 1000 }),
      429,
      'rate_limited',
    ],
    [
      'unable to answer',
      () => {
        throw new ServiceUnavailableError()
      },
      503,
      'service.unavailable',
    ],
  ])(
    'a limiter %s does not use up the challenge: the same assertion signs in next time',
    async (_, refuse, status, code) => {
      const { authenticator, userId } = await withPasskey()
      const started = await startPasskey()
      const credential = await authenticator.get(started.options, { origin: ORIGIN })
      const hit = deps.rateLimiter.hit.bind(deps.rateLimiter)
      let refusals = 1
      const limiter = spyOn(deps.rateLimiter, 'hit').mockImplementation(async (key, ...rest) => {
        if (key === Flows.environmentKey('verify', tenant) && refusals-- > 0) {
          return refuse() as Awaited<ReturnType<typeof hit>>
        }
        return hit(key, ...rest)
      })
      const refused = await post(`/sign-ins/${started.attempt.id}/passkey`, { credential })
      expect(await errorOf(refused)).toMatchObject({ status, code })
      expect(await sessionCount(userId)).toBe(1)
      const done = await post(`/sign-ins/${started.attempt.id}/passkey`, { credential })
      limiter.mockRestore()
      expect(done.status).toBe(200)
      expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
    }
  )
})

describe('a passkey as the second factor', () => {
  /** A user with a password, an authenticator app and a passkey, waiting on the second factor. */
  async function waiting() {
    const made = await withPasskey()
    const secret = await enrolTotp(made.session.accessToken)
    const attempt = await passwordSignIn()
    return { ...made, secret, attempt }
  }
  const optionsFor = async (attemptId: string, options: CallOptions = {}) =>
    post(`/sign-ins/${attemptId}/second-factor/passkey/options`, {}, options)

  test('after the password, the passkey completes the sign-in: pwd, hwk, user and mfa', async () => {
    const { authenticator, attempt, userId } = await waiting()
    expect(attempt.step).toEqual({
      status: 'needs_second_factor',
      options: ['totp', 'backup_code', 'passkey'],
    })
    const res = await optionsFor(attempt.id)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const options = await json<PasskeyRequestOptions>(res)
    // The user is known by now: the options name their own credentials.
    expect(options.allowCredentials).toEqual([
      {
        type: 'public-key',
        id: authenticator.credentialIds[0] as string,
        transports: ['internal'],
      },
    ])
    const credential = await authenticator.get(options, { origin: ORIGIN })
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${attempt.id}/second-factor`, { method: 'passkey', credential })
    )
    expect(done.step).toMatchObject({ status: 'complete', userId })
    expect(new Set(claimsOf(done.session?.accessToken as string).amr)).toEqual(
      new Set(['pwd', 'hwk', 'user', 'mfa'])
    )
  })

  test('a passkey alone is asked after the password only where a second factor is required', async () => {
    await withPasskey()
    // Optional policy and no authenticator app: the password is enough.
    expect((await passwordSignIn()).step.status).toBe('complete')
    configure({ policy: 'required' })
    // Required: the passkey is the second factor, and no enrolment is forced.
    const attempt = await passwordSignIn()
    expect(attempt.step).toEqual({ status: 'needs_second_factor', options: ['passkey'] })
    expect(attempt.session).toBeUndefined()
    // With passkeys switched off it does not count: the user must enrol an authenticator.
    configure({ policy: 'required', passkey: false })
    expect((await passwordSignIn()).step).toEqual({
      status: 'needs_factor_enrolment',
      methods: ['totp'],
    })
  })

  test('a wrong assertion is mfa.invalid_code, uses the challenge up and counts against the lockout', async () => {
    const { authenticator, attempt, userId } = await waiting()
    const before = await sessionCount(userId)
    const submit = (credential: unknown) =>
      post(`/sign-ins/${attempt.id}/second-factor`, { method: 'passkey', credential })
    // No options were asked for: there is no challenge to match.
    const blind = await authenticator.get({ challenge: 'YQ', rpId: RP_ID }, { origin: ORIGIN })
    expect(await errorOf(await submit(blind))).toMatchObject({
      status: 422,
      code: 'mfa.invalid_code',
    })
    const options = await json<PasskeyRequestOptions>(await optionsFor(attempt.id))
    const unverified = await authenticator.get(options, { origin: ORIGIN, userVerified: false })
    const second = await submit(unverified)
    // Counted like every second-factor guess: by now the user is backing off.
    expect([422, 429]).toContain(second.status)
    // The challenge went with the wrong assertion.
    const right = await authenticator.get(options, { origin: ORIGIN })
    const third = await submit(right)
    expect([422, 429]).toContain(third.status)
    expect(await sessionCount(userId)).toBe(before)
  })

  test('another user’s passkey proves nothing as this user’s second factor', async () => {
    const { attempt, userId } = await waiting()
    const before = await sessionCount(userId)
    const other = await signUp('zed@northline.app')
    const theirs = new VirtualAuthenticator()
    await register(other.accessToken, theirs)
    const options = await json<PasskeyRequestOptions>(await optionsFor(attempt.id))
    const credential = await theirs.get(
      { ...options, allowCredentials: undefined },
      { origin: ORIGIN }
    )
    const res = await post(`/sign-ins/${attempt.id}/second-factor`, {
      method: 'passkey',
      credential,
    })
    expect(await codeOf(res)).toBe('mfa.invalid_code')
    expect(await sessionCount(userId)).toBe(before)
  })

  test('the options need the attempt’s secret, the right step, an offered passkey and an allowed origin', async () => {
    const { attempt } = await waiting()
    expect(await codeOf(await optionsFor(attempt.id, { secret: null }))).toBe('flow.not_found')
    expect(await codeOf(await optionsFor(attempt.id, { origin: OTHER_ALLOWED }))).toBe(
      'request.origin_not_allowed'
    )
    // A passkey sign-in attempt is not waiting on a second factor.
    const started = await startPasskey()
    expect(await codeOf(await optionsFor(started.attempt.id))).toBe('flow.invalid_step')
    // Switched off mid-attempt: refused, and the guess is not counted.
    configure({ passkey: false })
    expect(await codeOf(await optionsFor(attempt.id))).toBe('auth.method_disabled')
    const res = await post(`/sign-ins/${attempt.id}/second-factor`, {
      method: 'passkey',
      credential: await new VirtualAuthenticator()
        .create(
          {
            rp: { id: RP_ID },
            user: { id: 'aA' },
            challenge: 'YQ',
            pubKeyCredParams: [{ alg: -7 }],
          },
          { origin: ORIGIN }
        )
        .then(() => ({
          id: 'YQ',
          rawId: 'YQ',
          type: 'public-key',
          response: { clientDataJSON: 'YQ', authenticatorData: 'YQ', signature: 'YQ' },
        })),
    })
    expect(await codeOf(res)).toBe('auth.method_disabled')
  })

  test('an attempt that was not offered a passkey cannot be completed with one', async () => {
    const session = await signUp()
    await enrolTotp(session.accessToken)
    const attempt = await passwordSignIn()
    expect(attempt.step).toMatchObject({ options: ['totp', 'backup_code'] })
    expect(await codeOf(await optionsFor(attempt.id))).toBe('flow.invalid_step')
  })

  test('a password reset stops at the second factor, which a passkey can prove', async () => {
    const { authenticator } = await waiting()
    // Past the cooldown of the address the sign-up emailed.
    deps.clock.advance('2m')
    const reset = await json<FlowAttempt>(await post('/password-resets', { email: EMAIL }))
    const submitted = await json<FlowAttempt>(
      await post(`/password-resets/${reset.id}/password`, {
        code: codeInSubject(),
        password: 'a new and longer passphrase 42',
      })
    )
    expect(submitted.step).toMatchObject({ status: 'needs_second_factor' })
    expect(submitted.session).toBeUndefined()
    const options = await json<PasskeyRequestOptions>(
      await post(`/password-resets/${reset.id}/second-factor/passkey/options`)
    )
    const credential = await authenticator.get(options, { origin: ORIGIN })
    const done = await json<FlowAttempt>(
      await post(`/password-resets/${reset.id}/second-factor`, { method: 'passkey', credential })
    )
    expect(done.step.status).toBe('complete')
  })
})

describe('a passkey as the second factor, after the first factor was switched off', () => {
  test('the options and the assertion are refused: the password that parked the attempt no longer counts', async () => {
    const { session, authenticator } = await withPasskey()
    await enrolTotp(session.accessToken)
    const started = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const waiting = await json<FlowAttempt>(
      await post(`/sign-ins/${started.id}/password`, { password: PASSWORD })
    )
    expect(waiting.step).toMatchObject({ status: 'needs_second_factor' })
    const options = await json<PasskeyRequestOptions>(
      await post(`/sign-ins/${started.id}/second-factor/passkey/options`)
    )
    const credential = await authenticator.get(options, { origin: ORIGIN })

    configure({ password: false })
    const counted = spyOn(deps.lockout, 'attempt')
    expect(await codeOf(await post(`/sign-ins/${started.id}/second-factor/passkey/options`))).toBe(
      'auth.method_disabled'
    )
    expect(
      await codeOf(
        await post(`/sign-ins/${started.id}/second-factor`, { method: 'passkey', credential })
      )
    ).toBe('auth.method_disabled')
    expect(counted).not.toHaveBeenCalled()
    counted.mockRestore()

    // The challenge was not used up: the same assertion completes once passwords are back.
    configure()
    const done = await post(`/sign-ins/${started.id}/second-factor`, {
      method: 'passkey',
      credential,
    })
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
  })
})

describe('stepping up with a passkey', () => {
  const stepUpOptions = (token: string, options: CallOptions = {}) =>
    post('/sessions/step-up/passkey', {}, { token, ...options })

  test('a stale session proves the passkey and gets a token that is recent and strong', async () => {
    const { session, authenticator } = await withPasskey()
    const old = await stale(session)
    const res = await stepUpOptions(old.accessToken)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const options = await json<PasskeyRequestOptions>(res)
    expect(options.allowCredentials?.map((entry) => entry.id)).toEqual(authenticator.credentialIds)
    const credential = await authenticator.get(options, { origin: ORIGIN })
    const stepped = await post(
      '/sessions/step-up',
      { method: 'passkey', credential },
      { token: old.accessToken }
    )
    expect(stepped.status).toBe(200)
    const fresh = await json<SessionTokens>(stepped)
    const claims = claimsOf(fresh.accessToken)
    expect(claims.auth_time).toBe(Math.floor(deps.clock.now().getTime() / 1000))
    expect(new Set(claims.amr)).toEqual(new Set(['email', 'hwk', 'user', 'mfa']))
    expect((await post('/me/passkeys/options', {}, { token: fresh.accessToken })).status).toBe(200)
    expect(await auditTypes()).toContain('session.stepped_up')
  })

  test('a user with an authenticator app may step up with their passkey, and never with the password', async () => {
    const { session, authenticator } = await withPasskey()
    await enrolTotp(session.accessToken)
    const attempt = await passwordSignIn()
    const options = await json<PasskeyRequestOptions>(
      await post(`/sign-ins/${attempt.id}/second-factor/passkey/options`)
    )
    const done = await json<FlowAttempt>(
      await post(`/sign-ins/${attempt.id}/second-factor`, {
        method: 'passkey',
        credential: await authenticator.get(options, { origin: ORIGIN }),
      })
    )
    const old = await stale(done.session as SessionTokens)
    const refused = await post('/me/passkeys/options', {}, { token: old.accessToken })
    expect(await errorOf(refused)).toMatchObject({
      code: 'auth.step_up_required',
      params: { methods: 'totp,backup_code,passkey' },
    })
    expect(
      await codeOf(
        await post(
          '/sessions/step-up',
          { method: 'password', password: PASSWORD },
          { token: old.accessToken }
        )
      )
    ).toBe('auth.step_up_required')
    const stepOptions = await json<PasskeyRequestOptions>(await stepUpOptions(old.accessToken))
    const stepped = await post(
      '/sessions/step-up',
      { method: 'passkey', credential: await authenticator.get(stepOptions, { origin: ORIGIN }) },
      { token: old.accessToken }
    )
    expect(stepped.status).toBe(200)
  })

  test('a step-up challenge belongs to one session and works once', async () => {
    const { session, authenticator, userId } = await withPasskey()
    const token = session.accessToken
    const other = (await passwordSignIn()).session as SessionTokens
    const options = await json<PasskeyRequestOptions>(await stepUpOptions(token))
    const credential = await authenticator.get(options, { origin: ORIGIN })
    const body = { method: 'passkey', credential }
    // Another session of the same user has no such challenge.
    expect(
      await errorOf(await post('/sessions/step-up', body, { token: other.accessToken }))
    ).toMatchObject({
      status: 401,
      code: 'auth.invalid_credentials',
    })
    expect((await post('/sessions/step-up', body, { token })).status).toBe(200)
    expect(await codeOf(await post('/sessions/step-up', body, { token }))).toBe(
      'auth.invalid_credentials'
    )
    // A registration challenge is not a step-up challenge.
    const creation = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token })
    )
    const crossed = await authenticator.get(
      { challenge: creation.challenge, rpId: RP_ID },
      { origin: ORIGIN }
    )
    expect(
      await codeOf(
        await post('/sessions/step-up', { method: 'passkey', credential: crossed }, { token })
      )
    ).toBe('auth.invalid_credentials')
    expect(await deps.passkeys.listForUser(TEST_TENANT.environmentId, userId)).toHaveLength(1)
  })

  test.each<[string, Partial<CeremonyInput>]>([
    ['no user verification', { userVerified: false }],
    ['client data for another origin', { origin: 'https://evil.test' }],
    ['a counter that went backwards', { counter: 0 }],
  ])('a step-up assertion with %s is refused and moves nothing', async (_, input) => {
    const { session, authenticator } = await withPasskey()
    // Put the stored counter above zero, so that a zero is a regression.
    expect((await passkeySignIn(authenticator, { counter: 3 })).status).toBe(200)
    const old = await stale(session)
    const options = await json<PasskeyRequestOptions>(await stepUpOptions(old.accessToken))
    const credential = await authenticator.get(options, { origin: ORIGIN, counter: 9, ...input })
    const res = await post(
      '/sessions/step-up',
      { method: 'passkey', credential },
      { token: old.accessToken }
    )
    expect(await errorOf(res)).toMatchObject({ status: 401, code: 'auth.invalid_credentials' })
    expect(await codeOf(await post('/me/passkeys/options', {}, { token: old.accessToken }))).toBe(
      'auth.step_up_required'
    )
  })

  test('another user’s passkey steps up nothing', async () => {
    const { session } = await withPasskey()
    const other = await signUp('zed@northline.app')
    const theirs = new VirtualAuthenticator()
    await register(other.accessToken, theirs)
    const options = await json<PasskeyRequestOptions>(await stepUpOptions(session.accessToken))
    const credential = await theirs.get(
      { ...options, allowCredentials: undefined },
      { origin: ORIGIN }
    )
    expect(
      await codeOf(
        await post(
          '/sessions/step-up',
          { method: 'passkey', credential },
          { token: session.accessToken }
        )
      )
    ).toBe('auth.invalid_credentials')
  })

  test.each<[string, () => CallOptions, string]>([
    [
      'passkeys switched off',
      () => {
        configure({ passkey: false })
        return {}
      },
      'auth.method_disabled',
    ],
    ['no Origin', () => ({ origin: null }), 'request.origin_not_allowed'],
    ['a foreign Origin', () => ({ origin: 'https://evil.test' }), 'request.origin_not_allowed'],
    [
      'an allowed Origin outside the relying party',
      () => ({ origin: OTHER_ALLOWED }),
      'request.origin_not_allowed',
    ],
  ])(
    'a step-up with %s is refused before a second-factor guess is counted',
    async (_, arrange, code) => {
      const { session, authenticator, userId } = await withPasskey()
      await enrolTotp(session.accessToken)
      const options = await json<PasskeyRequestOptions>(await stepUpOptions(session.accessToken))
      const credential = await authenticator.get(options, { origin: ORIGIN })
      const counted = spyOn(deps.lockout, 'attempt')
      const refused = await post(
        '/sessions/step-up',
        { method: 'passkey', credential },
        { token: session.accessToken, ...arrange() }
      )
      expect(await codeOf(refused)).toBe(code)
      // The budget is shared with the authenticator code of a sign-in: nothing of it is used.
      expect(counted.mock.calls.map(([key]) => key)).not.toContain(
        Mfa.secondFactorLockKey(TEST_TENANT.environmentId, userId)
      )
      counted.mockRestore()
      // Nothing was used up either: the same response steps up once the request is in order.
      configure()
      const stepped = await post(
        '/sessions/step-up',
        { method: 'passkey', credential },
        { token: session.accessToken }
      )
      expect(stepped.status).toBe(200)
    }
  )

  test('a user with no passkey, passkeys switched off, or a foreign origin gets no options', async () => {
    const session = await signUp()
    const none = await stepUpOptions(session.accessToken)
    expect(await errorOf(none)).toMatchObject({
      status: 403,
      code: 'auth.step_up_required',
      params: { methods: 'password,email_code' },
    })
    expect(
      await codeOf(
        await post(
          '/sessions/step-up',
          {
            method: 'passkey',
            credential: {
              id: 'YQ',
              rawId: 'YQ',
              type: 'public-key',
              response: { clientDataJSON: 'YQ', authenticatorData: 'YQ', signature: 'YQ' },
            },
          },
          { token: session.accessToken }
        )
      )
    ).toBe('auth.step_up_required')
    expect(await codeOf(await stepUpOptions(session.accessToken, { origin: OTHER_ALLOWED }))).toBe(
      'request.origin_not_allowed'
    )
    configure({ passkey: false })
    expect(await codeOf(await stepUpOptions(session.accessToken))).toBe('auth.method_disabled')
    expect((await post('/sessions/step-up/passkey')).status).toBe(401)
  })
})

describe('the admin reset', () => {
  test('removes the user’s passkeys, ends their sessions and tells them', async () => {
    const { session, authenticator, userId } = await withPasskey()
    deps.mailer.outbox.length = 0
    const res = await app.request(`/v1/admin/users/${userId}/factors`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(res.status).toBe(204)
    await Notices.settled()
    expect(await deps.passkeys.listForUser(TEST_TENANT.environmentId, userId)).toEqual([])
    expect(await sessionCount(userId)).toBe(0)
    expect(
      (await call('GET', '/me/passkeys', undefined, { token: session.accessToken })).status
    ).toBe(401)
    expect(await codeOf(await passkeySignIn(authenticator))).toBe('auth.invalid_credentials')
    expect(subjects()).toContain('Two-step verification was reset for your Tula account')
    const { entries } = await deps.activityLog.listAudit(TEST_TENANT.environmentId, {
      action: 'user.passkey_removed',
      page: 1,
      size: 10,
    })
    expect(entries.map((entry) => entry.data)).toEqual([
      { method: 'admin_reset', canStillSignIn: true },
    ])
    expect(entries[0]?.actor).toMatchObject({ type: 'admin' })
  })

  test.each<[string, Switches, string]>([
    [
      'whose passkey was the only way in (password and emailed code off)',
      { password: false },
      'false',
    ],
    ['who has a password the environment accepts', {}, 'true'],
    [
      'with a verified address where the emailed code is on',
      { password: false, emailCode: true },
      'true',
    ],
  ])(
    'a reset of a user %s says whether they can still sign in: %o → %s',
    async (_, switches, canStillSignIn) => {
      const { userId } = await withPasskey()
      configure(switches)
      const res = await app.request(`/v1/admin/users/${userId}/factors`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${SK}` },
      })
      // Still 204 and no body, as before: the outcome is a header.
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      expect(res.headers.get(CAN_STILL_SIGN_IN_HEADER)).toBe(canStillSignIn)
      expect(await deps.passkeys.listForUser(TEST_TENANT.environmentId, userId)).toEqual([])
      const { entries } = await deps.activityLog.listAudit(TEST_TENANT.environmentId, {
        action: 'user.passkey_removed',
        page: 1,
        size: 10,
      })
      // A boolean and nothing else: no method names, no address.
      expect(entries.map((entry) => entry.data)).toEqual([
        { method: 'admin_reset', canStillSignIn: canStillSignIn === 'true' },
      ])
    }
  )

  test('a reset of a user with nothing removes nothing and sends nothing', async () => {
    const session = await signUp()
    const userId = claimsOf(session.accessToken).sub
    deps.mailer.outbox.length = 0
    const res = await app.request(`/v1/admin/users/${userId}/factors`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${SK}` },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get(CAN_STILL_SIGN_IN_HEADER)).toBe('true')
    await Notices.settled()
    expect(subjects()).toEqual([])
    expect(await auditTypes()).not.toContain('user.passkey_removed')
  })
})

describe('a user with no email address (an account made through X or Facebook)', () => {
  /** Such a user, signed in, with a fresh authenticator. */
  async function addressless() {
    const userId = deps.ids.next()
    await deps.users.create(
      {
        id: userId,
        projectId: TEST_TENANT.projectId,
        environmentId: TEST_TENANT.environmentId,
        email: null,
        emailNormalized: null,
        emailVerifiedAt: null,
        firstName: 'Nelly',
        lastName: null,
        createdAt: deps.clock.now(),
        identityId: deps.ids.next(),
        credentialId: deps.ids.next(),
        passwordHash: null,
        oauthIdentity: { id: deps.ids.next(), provider: 'x', subject: '2244994945' },
      },
      Audit.none('fixture')
    )
    const session = await Sessions.create(deps, TEST_TENANT, {
      userId,
      client: 'ios',
      userAgent: null,
      ipAddress: null,
      authMethods: ['fed'],
    })
    return {
      userId,
      token: session.accessToken as string,
      authenticator: new VirtualAuthenticator(),
    }
  }

  test('registers a passkey named by the account’s name, never "null" and never an address', async () => {
    const { token } = await addressless()
    const options = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { token })
    )
    expect(options.user.name).toBe('Nelly')
    expect(options.user.displayName).toBe('Nelly')
  })

  test('signs in with the passkey and is never sent to prove an address it does not have', async () => {
    const { userId, token, authenticator } = await addressless()
    await register(token, authenticator)
    await Notices.settled()
    const sent = deps.mailer.outbox.length
    const res = await passkeySignIn(authenticator)
    expect(res.status).toBe(200)
    const done = await json<FlowAttempt>(res)
    expect(done.step).toMatchObject({ status: 'complete', userId })
    await Notices.settled()
    // No code and no notice: there is no address to send either to.
    expect(deps.mailer.outbox.length).toBe(sent)
    expect(sent).toBe(0)
    expect(
      (await deps.users.findById(TEST_TENANT.environmentId, userId))?.emailVerifiedAt
    ).toBeNull()
  })
})

describe('a passkey sign-in bound to a device key (ADR 0043)', () => {
  test('the key the start proved is the session’s, whatever the last step carries', async () => {
    const { authenticator } = await withPasskey()
    const key = await generateSoftwareDeviceKey()
    const dpop = await proofFor(key, {
      now: deps.clock.now(),
      path: '/v1/client/sign-ins/passkey',
      nonce: await DeviceBinding.nonce(deps, TEST_TENANT),
    })
    // The same header rides on the step that completes: it is not read there.
    const res = await passkeySignIn(authenticator, {}, { dpop })
    expect(res.status).toBe(200)
    const done = await json<FlowAttempt>(res)
    const session = await deps.sessions.findById(
      TEST_TENANT.environmentId,
      done.session?.sessionId ?? ''
    )
    expect(session?.deviceThumbprint).toBe(await jwkThumbprint(key.publicJwk))
    expect(claimsOf(done.session?.accessToken ?? '').cnf).toEqual({
      jkt: session?.deviceThumbprint as string,
    })
  })

  test('an invalid proof at the start is refused before a challenge is made', async () => {
    const res = await post('/sign-ins/passkey', {}, { dpop: 'not.a.proof' })
    expect(res.status).toBe(401)
    expect(await codeOf(res)).toBe('device.proof_invalid')
  })
})
