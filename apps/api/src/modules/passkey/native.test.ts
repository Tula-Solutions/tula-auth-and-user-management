import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { VirtualAuthenticator } from '@tula/conformance'
import {
  type AccessTokenClaims,
  androidApkKeyHashOrigin,
  DEFAULT_ENVIRONMENT_SETTINGS,
  type EnvironmentSettings,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  type NativeAppPlatform,
  type Passkey,
  type PasskeyCreationOptions,
  type PasskeyList,
  type PasskeyRequestOptions,
  type PasskeySignInStart,
  type HybridSessionTokens as SessionTokens,
  type TotpEnrolment,
} from '@tula/contract'
import { decodeJwt } from 'jose'
import { AuthError } from '~/exceptions'
import { createApp } from '~/index'
import { base32Decode, totp } from '~/lib/totp'
import * as WebAuthn from '~/lib/webauthn'
import * as Audit from '~/modules/audit/service'
import * as Notices from '~/modules/notice/service'
import * as Passkeys from '~/modules/passkey/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'

// Passkeys from a native app (ADR 0027, "Passkeys from a native app"): which origins a
// response may carry is decided from the request's `Origin` header, the client kind it
// declared and the environment's registered apps, and from nothing else.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const SK = 'tula_sk_dev_secret000000000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const RP_ID = 'northline.test'
const WEB_ORIGIN = 'https://app.northline.test'
const OTHER_ALLOWED = 'https://other.example.test'
const IOS_ORIGIN = `https://${RP_ID}`
const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }

// Three signing certificates. The origins beside them were computed with the Python lines of
// Android's documentation, not with the contract's function.
const FP_A =
  '14:B6:C3:A1:E9:D0:7F:52:88:6A:4B:0C:3D:9E:1F:20:A7:B8:C9:D0:E1:F2:A3:B4:C5:D6:E7:F8:09:1A:2B:3C'
const FP_B =
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C'
const FP_UNREGISTERED =
  'FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF:BE:FB:FF'
const ORIGIN_A = 'android:apk-key-hash:FLbDoenQf1KIaksMPZ4fIKe4ydDh8qO0xdbn-AkaKzw'
const ORIGIN_B = 'android:apk-key-hash:-sYXRdwJA3hvue3mKpYrOZ9zSPC7b4mbgzJmdZEDO5w'
const ORIGIN_UNREGISTERED = 'android:apk-key-hash:-_---_---_---_---_---_---_---_---_---_---_8'

let deps: TestDeps
let app: ReturnType<typeof createApp>
let secrets: Map<string, string>
let revision = 0

function configure(overrides: Partial<EnvironmentSettings> = {}) {
  revision += 1
  deps.environmentSettings.seed(tenant.environmentId, {
    revision,
    settings: {
      ...DEFAULT_ENVIRONMENT_SETTINGS,
      signIn: {
        methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, passkey: { enabled: true } },
      },
      urls: { allowedOrigins: [WEB_ORIGIN, OTHER_ALLOWED], allowedRedirectUrls: [] },
      passkeys: { rpId: RP_ID },
      ...overrides,
    },
  })
}

/**
 * What an operator does for an iOS app's passkeys: allow the relying party's own origin, the
 * one Apple's API writes. Without it an iOS app's request is refused (the default here).
 */
function allowRelyingPartyOrigin(overrides: Partial<EnvironmentSettings> = {}) {
  configure({
    ...overrides,
    urls: { allowedOrigins: [WEB_ORIGIN, OTHER_ALLOWED, IOS_ORIGIN], allowedRedirectUrls: [] },
  })
}

beforeEach(async () => {
  secrets = new Map()
  deps = createTestDeps()
  deps.environments.add({
    id: tenant.environmentId,
    projectId: tenant.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  await seedApiKey(deps, SK)
  configure()
  app = createApp(deps)
})

/** Register an app as an operator does: through the admin API. */
async function registerApp(body: Record<string, unknown>): Promise<string> {
  const res = await app.request('/v1/admin/native-apps', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SK}` },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

const iosApp = () =>
  registerApp({ platform: 'ios', teamId: 'A1B2C3D4E5', bundleId: 'test.northline.app' })
const androidApp = (fingerprints: string[], packageName = 'test.northline.app') =>
  registerApp({ platform: 'android', packageName, sha256CertFingerprints: fingerprints })

async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/v1/admin${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SK}` },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

interface CallOptions {
  token?: string
  /** The `Origin` header. A native app sends none, which is the default here. */
  origin?: string
  /** `x-tula-client`. `null` sends no such header. */
  client?: string | null
}

const ATTEMPT_PATH = /^\/(?:sign-ups|sign-ins|password-resets)\/([^/]+)\//

/** A client request. By default an Android app's: no `Origin`, `x-tula-client: android`. */
async function post(path: string, body: unknown = {}, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-publishable-key': PK,
  }
  const client = options.client === undefined ? 'android' : options.client
  if (client !== null) {
    headers['x-tula-client'] = client
  }
  if (options.origin !== undefined) {
    headers.origin = options.origin
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`
  }
  const secret = secrets.get(ATTEMPT_PATH.exec(path)?.[1] ?? '')
  if (secret) {
    headers[FLOW_ATTEMPT_HEADER] = secret
  }
  const res = await app.request(`/v1/client${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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

const json = async <T>(res: Response) => (await res.json()) as T
const codeOf = async (res: Response) => (await json<{ code: string }>(res)).code
const claimsOf = (token: string) => decodeJwt(token) as unknown as AccessTokenClaims
const codeInSubject = () =>
  /^(\d{6}) /.exec(
    [...deps.mailer.outbox].reverse().find((mail) => /^\d{6} /.test(mail.subject))?.subject ?? ''
  )?.[1] ?? ''

async function signUp(options: CallOptions = {}, email = EMAIL): Promise<SessionTokens> {
  const started = await json<FlowAttempt>(
    await post('/sign-ups', { email, password: PASSWORD }, options)
  )
  const done = await json<FlowAttempt>(
    await post(`/sign-ups/${started.id}/verify-email`, { code: codeInSubject() }, options)
  )
  await Notices.settled()
  return done.session as SessionTokens
}

/** Register a passkey: the options, the authenticator's response for `origin`, the finish. */
async function register(
  token: string,
  authenticator: VirtualAuthenticator,
  origin: string,
  options: CallOptions = {}
): Promise<Response> {
  const asked = await post('/me/passkeys/options', {}, { token, ...options })
  expect(asked.status).toBe(200)
  const credential = await authenticator.create(await json<PasskeyCreationOptions>(asked), {
    origin,
  })
  const res = await post('/me/passkeys', { credential }, { token, ...options })
  await Notices.settled()
  return res
}

/** A whole passkey sign-in whose response carries `origin`. */
async function signIn(
  authenticator: VirtualAuthenticator,
  origin: string,
  options: CallOptions = {}
): Promise<Response> {
  const asked = await post('/sign-ins/passkey', {}, options)
  expect(asked.status).toBe(200)
  const started = await json<PasskeySignInStart>(asked)
  const credential = await authenticator.get(started.options, { origin })
  return post(`/sign-ins/${started.attempt.id}/passkey`, { credential }, options)
}

async function codeOfThrown(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    return error instanceof AuthError ? error.code : `threw ${String(error)}`
  }
  return 'resolved'
}

describe('the origins of an environment’s registered apps', () => {
  const ios = { platform: 'ios', sha256CertFingerprints: [] } as const
  const android = (...sha256CertFingerprints: string[]) =>
    ({ platform: 'android', sha256CertFingerprints }) as const

  test('an Android app presents one origin per fingerprint, derived from the stored row', () => {
    expect(Passkeys.nativeOrigins([android(FP_A)], 'android', RP_ID)).toEqual([ORIGIN_A])
    expect(Passkeys.nativeOrigins([android(FP_A, FP_B)], 'android', RP_ID)).toEqual([
      ORIGIN_A,
      ORIGIN_B,
    ])
  })

  test('two apps signed with one certificate present one origin', () => {
    expect(Passkeys.nativeOrigins([android(FP_A), android(FP_A, FP_B)], 'android', RP_ID)).toEqual([
      ORIGIN_A,
      ORIGIN_B,
    ])
  })

  test('an iOS app presents the relying party’s own https origin, whatever the app', () => {
    expect(Passkeys.nativeOrigins([ios], 'ios', RP_ID)).toEqual([IOS_ORIGIN])
    expect(Passkeys.nativeOrigins([ios, ios], 'ios', RP_ID)).toEqual([IOS_ORIGIN])
  })

  test('one platform’s apps give the other nothing', () => {
    expect(Passkeys.nativeOrigins([android(FP_A)], 'ios', RP_ID)).toEqual([])
    expect(Passkeys.nativeOrigins([ios], 'android', RP_ID)).toEqual([])
    expect(Passkeys.nativeOrigins([], 'ios', RP_ID)).toEqual([])
    expect(Passkeys.nativeOrigins([], 'android', RP_ID)).toEqual([])
  })

  test('a stored value that is no fingerprint gives no origin', () => {
    expect(Passkeys.nativeOrigins([android('not a fingerprint', FP_A)], 'android', RP_ID)).toEqual([
      ORIGIN_A,
    ])
  })
})

describe('relyingParty', () => {
  const APPS = {
    none: [],
    'an iOS app': [{ platform: 'ios' as const, fingerprints: [] }],
    'an Android app with one fingerprint': [{ platform: 'android' as const, fingerprints: [FP_A] }],
    'an Android app with two fingerprints': [
      { platform: 'android' as const, fingerprints: [FP_A, FP_B] },
    ],
    'an app of each platform': [
      { platform: 'ios' as const, fingerprints: [] },
      { platform: 'android' as const, fingerprints: [FP_B] },
    ],
  }
  const ORIGINS = {
    'no Origin': null,
    'an undefined Origin': undefined,
    'the allowed Origin': WEB_ORIGIN,
    'a foreign Origin': 'https://evil.test',
    'an allowed Origin outside the relying party': OTHER_ALLOWED,
    'an empty Origin': '',
    'the Origin "null"': 'null',
    'an Android origin as the Origin header': ORIGIN_A,
    'the relying party’s own https origin': IOS_ORIGIN,
  }
  /** Whether `urls.allowedOrigins` lists `https://<rpId>`, beside the two pages it always has. */
  const ALLOWED = {
    'the relying party’s own origin is not allowed': false,
    'the relying party’s own origin is allowed': true,
  }
  const CLIENTS = {
    web: 'web',
    ios: 'ios',
    android: 'android',
    server: 'server',
    'no client kind': null,
    'an undefined client kind': undefined,
    garbage: 'toaster',
    'IOS in upper case': 'IOS',
    'android with a space': 'android ',
    'a property of every object': 'constructor',
    'both kinds at once': 'ios, android',
  }
  const SWITCHES = {
    'passkeys on': {},
    'passkeys off': {
      signIn: {
        methods: { ...DEFAULT_ENVIRONMENT_SETTINGS.signIn.methods, passkey: { enabled: false } },
      },
    },
    'no relying-party id': { passkeys: { rpId: null } },
  }

  /** The rule, stated apart from the code it checks. */
  function expected(
    apps: (typeof APPS)[keyof typeof APPS],
    origin: string | null | undefined,
    client: string | null | undefined,
    available: boolean,
    rpOriginAllowed: boolean
  ): string | string[] {
    if (!available) {
      return 'auth.method_disabled'
    }
    if (origin !== null && origin !== undefined) {
      // A browser's rule, whatever the client kind and whatever is registered.
      if (origin === WEB_ORIGIN || (origin === IOS_ORIGIN && rpOriginAllowed)) {
        return [origin]
      }
      return 'request.origin_not_allowed'
    }
    // An iOS app presents a page's origin, so it is held to the list pages are held to.
    if (client === 'ios' && apps.some((app) => app.platform === 'ios') && rpOriginAllowed) {
      return [IOS_ORIGIN]
    }
    if (client === 'android') {
      const prints = apps.filter((app) => app.platform === 'android').flatMap((a) => a.fingerprints)
      const origins = prints.map((print) => (print === FP_A ? ORIGIN_A : ORIGIN_B))
      if (origins.length > 0) {
        return origins
      }
    }
    return 'request.origin_not_allowed'
  }

  const rows = Object.entries(APPS).flatMap(([appsName, apps]) =>
    Object.entries(SWITCHES).flatMap(([switchName, overrides]) =>
      Object.entries(ALLOWED).flatMap(([allowedName, rpOriginAllowed]) =>
        Object.entries(ORIGINS).flatMap(([originName, origin]) =>
          Object.entries(CLIENTS).map(
            ([clientName, client]) =>
              [
                appsName,
                switchName,
                allowedName,
                originName,
                clientName,
                apps,
                overrides,
                rpOriginAllowed,
                origin,
                client,
              ] as const
          )
        )
      )
    )
  )

  test('the table has every combination', () => {
    expect(rows).toHaveLength(5 * 3 * 2 * 9 * 11)
  })

  test.each(rows)(
    'registered: %s; %s; %s; %s; client: %s',
    async (_apps, switchName, _allowed, _origin, _client, apps, overrides, rpOriginAllowed, origin, client) => {
      if (rpOriginAllowed) {
        allowRelyingPartyOrigin(overrides)
      } else {
        configure(overrides)
      }
      for (const [index, registered] of apps.entries()) {
        await deps.nativeApps.insert(
          {
            id: deps.ids.next(),
            ...tenant,
            platform: registered.platform,
            identifier: `test.northline.app${index}`,
            teamId: registered.platform === 'ios' ? 'A1B2C3D4E5' : null,
            sha256CertFingerprints: [...registered.fingerprints],
            createdAt: deps.clock.now(),
            updatedAt: deps.clock.now(),
          },
          Audit.none('fixture')
        )
      }
      const want = expected(apps, origin, client, switchName === 'passkeys on', rpOriginAllowed)
      const run = Passkeys.relyingParty(deps, tenant, { origin, client })
      if (typeof want === 'string') {
        expect(await codeOfThrown(run)).toBe(want)
      } else {
        expect(await run).toEqual({ rpId: RP_ID, origins: want })
      }
    }
  )

  test('a browser’s request does not read the registered apps at all', async () => {
    await androidApp([FP_A])
    const listed = spyOn(deps.nativeApps, 'list')
    await Passkeys.relyingParty(deps, tenant, { origin: WEB_ORIGIN, client: 'android' })
    expect(
      await codeOfThrown(Passkeys.relyingParty(deps, tenant, { origin: null, client: 'web' }))
    ).toBe('request.origin_not_allowed')
    expect(listed).not.toHaveBeenCalled()
    listed.mockRestore()
  })

  test('another environment’s apps do not count', async () => {
    await deps.nativeApps.insert(
      {
        id: deps.ids.next(),
        projectId: tenant.projectId,
        environmentId: TEST_TENANT.productionEnvironmentId,
        platform: 'android',
        identifier: 'test.northline.app',
        teamId: null,
        sha256CertFingerprints: [FP_A],
        createdAt: deps.clock.now(),
        updatedAt: deps.clock.now(),
      },
      Audit.none('fixture')
    )
    expect(
      await codeOfThrown(Passkeys.relyingParty(deps, tenant, { origin: null, client: 'android' }))
    ).toBe('request.origin_not_allowed')
  })

  test('the Android origins are the contract’s, of the stored fingerprints', async () => {
    await androidApp([FP_B.toLowerCase().replaceAll(':', ''), FP_A])
    const { origins } = await Passkeys.relyingParty(deps, tenant, {
      origin: null,
      client: 'android',
    })
    expect([...origins].sort()).toEqual(
      [FP_A, FP_B].map((print) => String(androidApkKeyHashOrigin(print))).sort()
    )
    expect([...origins].sort()).toEqual([ORIGIN_A, ORIGIN_B].sort())
  })
})

describe('the verifier, over the origin a response carries', () => {
  const creation = (challenge: string) => ({
    rp: { id: RP_ID, name: 'Northline' },
    user: { id: 'dXNlci1oYW5kbGU', name: EMAIL, displayName: 'Maya' },
    challenge,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    excludeCredentials: [],
  })

  const HEX_B = FP_B.replaceAll(':', '')
  const STANDARD_B = Buffer.from(HEX_B, 'hex').toString('base64')

  const ANDROID = [ORIGIN_A, ORIGIN_B]
  const IOS = [IOS_ORIGIN]

  // What a client presented, what the request's relying party accepts, and whether it verifies.
  const cases: [string, string, readonly string[], boolean][] = [
    ['the first registered Android origin', ORIGIN_A, ANDROID, true],
    ['the second registered Android origin', ORIGIN_B, ANDROID, true],
    ['an unregistered certificate’s origin', ORIGIN_UNREGISTERED, ANDROID, false],
    [
      'the hash in standard base64',
      `android:apk-key-hash:${STANDARD_B.replace('=', '')}`,
      ANDROID,
      false,
    ],
    ['the hash in padded standard base64', `android:apk-key-hash:${STANDARD_B}`, ANDROID, false],
    ['the hash in padded base64url', `${ORIGIN_B}=`, ANDROID, false],
    ['the hash as upper-case hex', `android:apk-key-hash:${HEX_B}`, ANDROID, false],
    ['the hash as lower-case hex', `android:apk-key-hash:${HEX_B.toLowerCase()}`, ANDROID, false],
    ['the hash as the stored fingerprint', `android:apk-key-hash:${FP_B}`, ANDROID, false],
    ['the origin with a trailing newline', `${ORIGIN_B}\n`, ANDROID, false],
    ['the origin with a trailing space', `${ORIGIN_B} `, ANDROID, false],
    ['the origin with a leading space', ` ${ORIGIN_B}`, ANDROID, false],
    ['the origin with a trailing slash', `${ORIGIN_B}/`, ANDROID, false],
    ['the prefix in another case', ORIGIN_B.replace('android:', 'Android:'), ANDROID, false],
    ['the hash in another case', ORIGIN_A.toLowerCase(), ANDROID, false],
    ['the prefix alone', 'android:apk-key-hash:', ANDROID, false],
    ['two registered origins joined', `${ORIGIN_A},${ORIGIN_B}`, ANDROID, false],
    ['an empty origin', '', ANDROID, false],
    ['the iOS origin presented by an Android client', IOS_ORIGIN, ANDROID, false],
    ['an allowed web page’s origin presented by an Android client', WEB_ORIGIN, ANDROID, false],
    ['the relying party’s https origin', IOS_ORIGIN, IOS, true],
    ['that origin with a trailing slash', `${IOS_ORIGIN}/`, IOS, false],
    ['a subdomain of the relying party', `https://sub.${RP_ID}`, IOS, false],
    ['an allowed web page’s origin presented by an iOS client', WEB_ORIGIN, IOS, false],
    ['the relying party over http', `http://${RP_ID}`, IOS, false],
    ['the relying party with the default port', `${IOS_ORIGIN}:443`, IOS, false],
    ['the relying party in upper case', `https://${RP_ID.toUpperCase()}`, IOS, false],
    ['the scheme in upper case', `HTTPS://${RP_ID}`, IOS, false],
    ['a look-alike host', `https://${RP_ID}.evil.test`, IOS, false],
    ['an Android origin presented by an iOS client', ORIGIN_A, IOS, false],
    ['a registered Android origin where nothing is accepted', ORIGIN_A, [], false],
  ]

  test.each(cases)('a registration carrying %s', async (_name, origin, origins, verifies) => {
    const challenge = WebAuthn.newChallenge()
    const response = await new VirtualAuthenticator().create(creation(challenge), { origin })
    const credential = await WebAuthn.verifyRegistration(response, {
      challenge,
      origins,
      rpId: RP_ID,
    })
    expect(credential !== null).toBe(verifies)
  })

  test.each(cases)('an assertion carrying %s', async (_name, origin, origins, verifies) => {
    const authenticator = new VirtualAuthenticator()
    const made = WebAuthn.newChallenge()
    const credential = await WebAuthn.verifyRegistration(
      await authenticator.create(creation(made), { origin: WEB_ORIGIN }),
      { challenge: made, origins: [WEB_ORIGIN], rpId: RP_ID }
    )
    if (!credential) {
      throw new Error('registration did not verify')
    }
    const challenge = WebAuthn.newChallenge()
    const assertion = await authenticator.get({ challenge, rpId: RP_ID }, { origin })
    const verified = await WebAuthn.verifyAssertion(
      assertion,
      { challenge, origins, rpId: RP_ID },
      credential
    )
    expect(verified !== null).toBe(verifies)
  })

  test('a registered origin does not excuse another relying party’s hash or a missing user verification', async () => {
    const challenge = WebAuthn.newChallenge()
    const expected = { challenge, origins: ANDROID, rpId: RP_ID }
    for (const input of [{ rpId: 'evil.test' }, { userVerified: false }]) {
      const response = await new VirtualAuthenticator().create(creation(challenge), {
        origin: ORIGIN_A,
        ...input,
      })
      expect(await WebAuthn.verifyRegistration(response, expected)).toBeNull()
    }
  })
})

describe('an Android app', () => {
  test('registers a passkey and signs in with it, with no Origin header', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    const registered = await register(session.accessToken, phone, ORIGIN_A)
    expect(registered.status).toBe(201)
    const passkey = await json<Passkey>(registered)

    const done = await signIn(phone, ORIGIN_A)
    expect(done.status).toBe(200)
    const attempt = await json<FlowAttempt>(done)
    expect(attempt.step.status).toBe('complete')
    const tokens = attempt.session as SessionTokens
    // A native client's tokens are in the body; no cookie is set.
    expect(tokens.refreshToken).toMatch(/^tula_rt_/)
    expect(done.headers.get('set-cookie')).toBeNull()
    const claims = claimsOf(tokens.accessToken)
    expect(claims.sub).toBe(claimsOf(session.accessToken).sub)
    expect([...(claims.amr ?? [])].sort()).toEqual(['hwk', 'mfa', 'user'])

    const stored = await deps.passkeys.listForUser(tenant.environmentId, claims.sub)
    expect(stored.map((row) => row.id)).toEqual([passkey.id])
    expect(stored[0]?.lastUsedAt).not.toBeNull()
  })

  test('each registered fingerprint is accepted, and one that is not is the generic failure', async () => {
    await androidApp([FP_A, FP_B])
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    expect((await register(session.accessToken, phone, ORIGIN_A)).status).toBe(201)
    expect((await signIn(phone, ORIGIN_A)).status).toBe(200)
    // The same passkey from a build signed with the other registered certificate.
    expect((await signIn(phone, ORIGIN_B)).status).toBe(200)

    const refused = await signIn(phone, ORIGIN_UNREGISTERED)
    expect(refused.status).toBe(401)
    expect(await json<unknown>(refused)).toEqual({
      status: 401,
      code: 'auth.invalid_credentials',
      detail: expect.any(String),
    })
  })

  test('an app whose certificate is not registered fails exactly as an unknown credential does', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    expect((await register(session.accessToken, phone, ORIGIN_A)).status).toBe(201)

    const wrongApp = await signIn(phone, ORIGIN_UNREGISTERED)
    // A credential the server has never seen, from the registered app.
    const stranger = new VirtualAuthenticator()
    const challenge = WebAuthn.newChallenge()
    await stranger.create(
      {
        rp: { id: RP_ID, name: 'x' },
        user: { id: 'dXNlci1oYW5kbGU', name: 'x', displayName: 'x' },
        challenge,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
      { origin: ORIGIN_A }
    )
    const unknown = await signIn(stranger, ORIGIN_A)
    expect(wrongApp.status).toBe(unknown.status)
    expect(await json(wrongApp)).toEqual(await json(unknown))
    expect([...wrongApp.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort())
  })

  test('a registration from an unregistered certificate is the failed registration, and stores nothing', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    const refused = await register(
      session.accessToken,
      new VirtualAuthenticator(),
      ORIGIN_UNREGISTERED
    )
    expect(refused.status).toBe(422)
    expect(await codeOf(refused)).toBe('passkey.registration_failed')
    expect(
      await deps.passkeys.listForUser(tenant.environmentId, claimsOf(session.accessToken).sub)
    ).toEqual([])
  })

  test('a failed assertion uses the challenge up: the right response for it is then refused too', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, ORIGIN_A)
    const started = await json<PasskeySignInStart>(await post('/sign-ins/passkey'))
    const wrong = await phone.get(started.options, { origin: ORIGIN_UNREGISTERED })
    const right = await phone.get(started.options, { origin: ORIGIN_A })
    const path = `/sign-ins/${started.attempt.id}/passkey`
    expect(await codeOf(await post(path, { credential: wrong }))).toBe('auth.invalid_credentials')
    expect(await codeOf(await post(path, { credential: right }))).toBe('auth.invalid_credentials')
  })
})

describe('an iOS app', () => {
  test('registers a passkey and signs in with the relying party’s own https origin, where that origin is allowed', async () => {
    allowRelyingPartyOrigin()
    await iosApp()
    const session = await signUp({ client: 'ios' })
    const phone = new VirtualAuthenticator()
    expect((await register(session.accessToken, phone, IOS_ORIGIN, { client: 'ios' })).status).toBe(
      201
    )
    const done = await signIn(phone, IOS_ORIGIN, { client: 'ios' })
    expect(done.status).toBe(200)
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
  })

  test.each([
    ['a subdomain of the relying party', `https://app.${RP_ID}`],
    ['a trailing slash', `${IOS_ORIGIN}/`],
    ['http', `http://${RP_ID}`],
    ['an Android app’s origin', ORIGIN_A],
  ])('a response carrying %s is the generic failure', async (_name, origin) => {
    allowRelyingPartyOrigin()
    await iosApp()
    await androidApp([FP_A])
    const session = await signUp({ client: 'ios' })
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, IOS_ORIGIN, { client: 'ios' })
    const refused = await signIn(phone, origin, { client: 'ios' })
    expect(refused.status).toBe(401)
    expect(await codeOf(refused)).toBe('auth.invalid_credentials')
  })
})

// The relying party's own origin is a page's origin, and Apple's API writes the same string
// for an app. So a response that carries it is accepted only where the environment allows
// that page: otherwise a script on it (`https://<rpId>` left off the list on purpose) could
// run the browser's ceremony and send the result with no `Origin`, as "an iOS app".
describe('the relying party’s own origin, left off the allowed list', () => {
  const ios = { client: 'ios' }

  /** What the page's script holds: a passkey of the account, made on an allowed page. */
  async function arrange() {
    await iosApp()
    await androidApp([FP_A])
    const web = { client: 'web', origin: WEB_ORIGIN }
    const session = await signUp(web)
    const key = new VirtualAuthenticator()
    expect((await register(session.accessToken, key, WEB_ORIGIN, web)).status).toBe(201)
    return { session, key, userId: claimsOf(session.accessToken).sub }
  }

  test('as an iOS app, no ceremony starts: the answer of an environment with no iOS app', async () => {
    const { session } = await arrange()
    const created = spyOn(deps.flowAttempts, 'create')
    const challenged = spyOn(deps.passkeys, 'putChallenge')
    const charged = spyOn(deps.rateLimiter, 'hit')
    const before = charged.mock.calls.length
    const answers: unknown[] = []
    for (const [path, token] of [
      ['/sign-ins/passkey', undefined],
      ['/me/passkeys/options', session.accessToken],
      ['/sessions/step-up/passkey', session.accessToken],
    ] as const) {
      const refused = await post(path, {}, { ...ios, token })
      expect(refused.status).toBe(403)
      answers.push(await json(refused))
    }
    expect(created).not.toHaveBeenCalled()
    expect(challenged).not.toHaveBeenCalled()
    const keys = charged.mock.calls.slice(before).map(([key]) => String(key))
    expect(keys.filter((key) => key.startsWith('environment_'))).toEqual([])
    for (const spy of [created, challenged, charged]) {
      spy.mockRestore()
    }

    // Side by side with an environment that has no iOS app at all: not told apart.
    for (const row of await deps.nativeApps.list(tenant.environmentId)) {
      if (row.platform === 'ios') {
        expect((await admin('DELETE', `/native-apps/${row.id}`)).status).toBe(204)
      }
    }
    const withoutApp: unknown[] = []
    for (const [path, token] of [
      ['/sign-ins/passkey', undefined],
      ['/me/passkeys/options', session.accessToken],
      ['/sessions/step-up/passkey', session.accessToken],
    ] as const) {
      withoutApp.push(await json(await post(path, {}, { ...ios, token })))
    }
    expect(answers).toEqual(withoutApp)
    expect(answers[0]).toMatchObject({ code: 'request.origin_not_allowed' })
  })

  test('a sign-in started another way does not finish with a response made on that page', async () => {
    const { key, userId } = await arrange()
    const sessions = () =>
      deps.sessions.listActiveByUser(tenant.environmentId, userId, deps.clock.now())
    const before = (await sessions()).length

    // Started as the registered Android app (no `Origin` either): the page's response is
    // not one of that app's origins.
    const asAndroid = await json<PasskeySignInStart>(await post('/sign-ins/passkey'))
    const made = await key.get(asAndroid.options, { origin: IOS_ORIGIN })
    for (const client of ['android', 'ios']) {
      const refused = await post(
        `/sign-ins/${asAndroid.attempt.id}/passkey`,
        { credential: made },
        { client }
      )
      expect(refused.status).toBe(401)
      expect(await codeOf(refused)).toBe('auth.invalid_credentials')
      expect(refused.headers.get('set-cookie')).toBeNull()
    }

    // Started as an iOS app while the origin was allowed, finished after it was taken off
    // the list: refused before the challenge is taken, and nothing is counted.
    allowRelyingPartyOrigin()
    const asIos = await json<PasskeySignInStart>(await post('/sign-ins/passkey', {}, ios))
    const response = await key.get(asIos.options, { origin: IOS_ORIGIN })
    configure()
    const path = `/sign-ins/${asIos.attempt.id}/passkey`
    const locked = spyOn(deps.lockout, 'attempt')
    const late = await post(path, { credential: response }, ios)
    expect(late.status).toBe(403)
    expect(await codeOf(late)).toBe('request.origin_not_allowed')
    expect(locked).not.toHaveBeenCalled()
    locked.mockRestore()
    expect(await sessions()).toHaveLength(before)
    // Allowed again, that same response for that same challenge completes: nothing was spent.
    allowRelyingPartyOrigin()
    expect((await post(path, { credential: response }, ios)).status).toBe(200)
  })

  test('a registration with a response made on that page stores nothing', async () => {
    const { session, userId } = await arrange()
    const token = session.accessToken
    // The options asked as the Android app; the response made by the page's script.
    const refused = await register(token, new VirtualAuthenticator(), IOS_ORIGIN)
    expect(refused.status).toBe(422)
    expect(await codeOf(refused)).toBe('passkey.registration_failed')

    // Asked while allowed, finished after: refused before the challenge is taken.
    allowRelyingPartyOrigin()
    const asked = await json<PasskeyCreationOptions>(
      await post('/me/passkeys/options', {}, { ...ios, token })
    )
    const credential = await new VirtualAuthenticator().create(asked, { origin: IOS_ORIGIN })
    configure()
    const late = await post('/me/passkeys', { credential }, { ...ios, token })
    expect(late.status).toBe(403)
    expect(await codeOf(late)).toBe('request.origin_not_allowed')
    expect(await deps.passkeys.listForUser(tenant.environmentId, userId)).toHaveLength(1)
  })

  test('a step-up with a response made on that page steps nothing up', async () => {
    const { session, key } = await arrange()
    const token = session.accessToken
    const authTime = async () =>
      (await deps.sessions.findById(tenant.environmentId, claimsOf(token).sid))?.factorVerifiedAt

    const asAndroid = await json<PasskeyRequestOptions>(
      await post('/sessions/step-up/passkey', {}, { token })
    )
    const made = await key.get(asAndroid, { origin: IOS_ORIGIN })
    const was = await authTime()
    deps.clock.advance('20s')
    for (const client of ['android', 'ios']) {
      const refused = await post(
        '/sessions/step-up',
        { method: 'passkey', credential: made },
        { client, token }
      )
      expect(refused.status).not.toBe(200)
    }
    expect(await authTime()).toEqual(was)

    allowRelyingPartyOrigin()
    const asIos = await json<PasskeyRequestOptions>(
      await post('/sessions/step-up/passkey', {}, { ...ios, token })
    )
    const response = await key.get(asIos, { origin: IOS_ORIGIN })
    configure()
    const locked = spyOn(deps.lockout, 'attempt')
    const late = await post(
      '/sessions/step-up',
      { method: 'passkey', credential: response },
      { ...ios, token }
    )
    expect(late.status).toBe(403)
    expect(await codeOf(late)).toBe('request.origin_not_allowed')
    expect(locked).not.toHaveBeenCalled()
    locked.mockRestore()
    expect(await authTime()).toEqual(was)
  })
})

describe('what a request cannot choose', () => {
  test('a body that names an origin or a relying party changes nothing', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, ORIGIN_A)
    const started = await json<PasskeySignInStart>(await post('/sign-ins/passkey'))
    const credential = await phone.get(started.options, { origin: ORIGIN_UNREGISTERED })
    const res = await post(`/sign-ins/${started.attempt.id}/passkey`, {
      credential,
      origin: ORIGIN_UNREGISTERED,
      origins: [ORIGIN_UNREGISTERED],
      expectedOrigin: ORIGIN_UNREGISTERED,
      rpId: RP_ID,
      client: 'android',
      sha256CertFingerprints: [FP_UNREGISTERED],
    })
    // Refused as a body the route does not take, or as a failed sign-in: never accepted.
    expect([401, 422]).toContain(res.status)
    expect(
      await deps.sessions.listActiveByUser(
        tenant.environmentId,
        claimsOf(session.accessToken).sub,
        deps.clock.now()
      )
    ).toHaveLength(1)
  })

  test('a request with an Origin header is a browser’s, whatever client kind it declares', async () => {
    await androidApp([FP_A])
    await iosApp()
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, ORIGIN_A)

    // From an allowed page: only that page's origin is accepted, never an app's.
    for (const client of ['android', 'ios']) {
      const refused = await signIn(phone, ORIGIN_A, { origin: WEB_ORIGIN, client })
      expect(await codeOf(refused)).toBe('auth.invalid_credentials')
      expect((await signIn(phone, WEB_ORIGIN, { origin: WEB_ORIGIN, client })).status).toBe(200)
    }
    // From anywhere else: refused before an attempt exists.
    for (const origin of ['https://evil.test', OTHER_ALLOWED, IOS_ORIGIN, ORIGIN_A, 'null']) {
      const refused = await post('/sign-ins/passkey', {}, { origin, client: 'android' })
      expect(refused.status).toBe(403)
      expect(await codeOf(refused)).toBe('request.origin_not_allowed')
    }
  })

  test.each<[string, string | null]>([
    ['web', 'web'],
    ['server', 'server'],
    ['no client kind', null],
  ])(
    'with no Origin, %s cannot start a ceremony although apps are registered',
    async (_n, client) => {
      await androidApp([FP_A])
      await iosApp()
      const session = await signUp()
      for (const [path, token] of [
        ['/sign-ins/passkey', undefined],
        ['/me/passkeys/options', session.accessToken],
        ['/sessions/step-up/passkey', session.accessToken],
      ] as const) {
        const refused = await post(path, {}, { client, token })
        expect(refused.status).toBe(403)
        expect(await codeOf(refused)).toBe('request.origin_not_allowed')
      }
    }
  )

  test('a client kind that is not one is not a native app’s on the signed-in routes', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    // (White space around a header's value is not part of it: `android ` arrives as `android`.)
    for (const client of ['toaster', 'ANDROID', 'android-tv', 'ios, android']) {
      const refused = await post('/me/passkeys/options', {}, { client, token: session.accessToken })
      expect(refused.status).toBe(403)
      expect(await codeOf(refused)).toBe('request.origin_not_allowed')
    }
  })

  test('an attempt keeps the client kind it was started with', async () => {
    allowRelyingPartyOrigin()
    await androidApp([FP_A])
    await iosApp()
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, ORIGIN_A)

    // Started by an iOS client: a later call that says `android` is still held to iOS.
    const asIos = await json<PasskeySignInStart>(
      await post('/sign-ins/passkey', {}, { client: 'ios' })
    )
    const androidResponse = await phone.get(asIos.options, { origin: ORIGIN_A })
    expect(
      await codeOf(
        await post(
          `/sign-ins/${asIos.attempt.id}/passkey`,
          { credential: androidResponse },
          { client: 'android' }
        )
      )
    ).toBe('auth.invalid_credentials')

    // Started by a browser: without its Origin a later call cannot become a native app's, and
    // being refused there uses nothing up.
    const asWeb = await json<PasskeySignInStart>(
      await post('/sign-ins/passkey', {}, { client: 'web', origin: WEB_ORIGIN })
    )
    const path = `/sign-ins/${asWeb.attempt.id}/passkey`
    const forApp = await phone.get(asWeb.options, { origin: ORIGIN_A })
    const moved = await post(path, { credential: forApp }, { client: 'android' })
    expect(moved.status).toBe(403)
    expect(await codeOf(moved)).toBe('request.origin_not_allowed')
    const forPage = await phone.get(asWeb.options, { origin: WEB_ORIGIN })
    const done = await post(path, { credential: forPage }, { client: 'web', origin: WEB_ORIGIN })
    expect(done.status).toBe(200)
  })
})

describe('an environment with no registered app of the platform', () => {
  test.each<[string, NativeAppPlatform, () => Promise<unknown>]>([
    ['no app at all', 'android', async () => undefined],
    ['only an iOS app, for an Android client', 'android', iosApp],
    ['only an Android app, for an iOS client', 'ios', () => androidApp([FP_A])],
    ['an iOS app, the relying party’s own origin not allowed', 'ios', iosApp],
  ])(
    '%s: every ceremony is refused before anything is made or counted',
    async (_n, client, arrange) => {
      const session = await signUp({ client })
      await arrange()
      const created = spyOn(deps.flowAttempts, 'create')
      const charged = spyOn(deps.rateLimiter, 'hit')
      const challenged = spyOn(deps.passkeys, 'putChallenge')
      const before = charged.mock.calls.length
      for (const [path, token] of [
        ['/sign-ins/passkey', undefined],
        ['/me/passkeys/options', session.accessToken],
        ['/sessions/step-up/passkey', session.accessToken],
      ] as const) {
        const refused = await post(path, {}, { client, token })
        expect(refused.status).toBe(403)
        expect(await codeOf(refused)).toBe('request.origin_not_allowed')
      }
      expect(created).not.toHaveBeenCalled()
      expect(challenged).not.toHaveBeenCalled()
      // Only the routes' own per-IP limits were counted: never the environment's ceiling.
      const keys = charged.mock.calls.slice(before).map(([key]) => String(key))
      expect(keys.filter((key) => key.startsWith('environment_'))).toEqual([])
      for (const spy of [created, charged, challenged]) {
        spy.mockRestore()
      }
    }
  )
})

describe('an app that is changed or removed', () => {
  test('a fingerprint taken away is refused from then on, and the passkey stays', async () => {
    const appId = await androidApp([FP_A, FP_B])
    const session = await signUp()
    const userId = claimsOf(session.accessToken).sub
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, ORIGIN_A)
    expect((await signIn(phone, ORIGIN_A)).status).toBe(200)

    const changed = await admin('PATCH', `/native-apps/${appId}`, {
      sha256CertFingerprints: [FP_B],
    })
    expect(changed.status).toBe(200)
    expect(await codeOf(await signIn(phone, ORIGIN_A))).toBe('auth.invalid_credentials')
    // The passkey is the account's, not the certificate's: the other build still uses it.
    expect((await signIn(phone, ORIGIN_B)).status).toBe(200)
    expect(await deps.passkeys.listForUser(tenant.environmentId, userId)).toHaveLength(1)
  })

  test('a removed app’s challenge is left unused, and the passkey works again from the web', async () => {
    const appId = await androidApp([FP_A])
    const session = await signUp()
    const userId = claimsOf(session.accessToken).sub
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, ORIGIN_A)

    const started = await json<PasskeySignInStart>(await post('/sign-ins/passkey'))
    const credential = await phone.get(started.options, { origin: ORIGIN_A })
    expect((await admin('DELETE', `/native-apps/${appId}`)).status).toBe(204)
    const path = `/sign-ins/${started.attempt.id}/passkey`
    const refused = await post(path, { credential })
    expect(refused.status).toBe(403)
    expect(await codeOf(refused)).toBe('request.origin_not_allowed')
    expect(await deps.passkeys.listForUser(tenant.environmentId, userId)).toHaveLength(1)

    // Registered again, the same response for the same challenge is accepted: the refusal
    // above took nothing.
    await androidApp([FP_A])
    expect((await post(path, { credential })).status).toBe(200)

    // And a passkey made in the app is one a page of the relying party can use.
    const web = { client: 'web', origin: WEB_ORIGIN }
    expect((await signIn(phone, WEB_ORIGIN, web)).status).toBe(200)
  })
})

describe('a passkey is not tied to where it was registered', () => {
  test('one registered on the web signs in from an app, and nothing of an origin is stored', async () => {
    allowRelyingPartyOrigin()
    await androidApp([FP_A])
    await iosApp()
    const web = { client: 'web', origin: WEB_ORIGIN }
    const session = await signUp({ client: 'ios' })
    const userId = claimsOf(session.accessToken).sub
    const key = new VirtualAuthenticator()
    expect((await register(session.accessToken, key, WEB_ORIGIN, web)).status).toBe(201)
    expect((await signIn(key, ORIGIN_A)).status).toBe(200)
    expect((await signIn(key, IOS_ORIGIN, { client: 'ios' })).status).toBe(200)

    const second = new VirtualAuthenticator()
    expect((await register(session.accessToken, second, ORIGIN_A)).status).toBe(201)
    const rows = await deps.passkeys.listForUser(tenant.environmentId, userId)
    expect(rows).toHaveLength(2)
    const kept = JSON.stringify(rows.map((row) => ({ ...row, publicKey: undefined })))
    for (const origin of [WEB_ORIGIN, ORIGIN_A, 'apk-key-hash', IOS_ORIGIN]) {
      expect(kept).not.toContain(origin)
    }
    // Nor is one in the record of it.
    const audit = await deps.activityLog.listAudit(tenant.environmentId, { page: 1, size: 200 })
    expect(JSON.stringify(audit.entries)).not.toContain('apk-key-hash')
  })
})

describe('the other passkey steps, from an app', () => {
  test('a step-up by passkey', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    const phone = new VirtualAuthenticator()
    await register(session.accessToken, phone, ORIGIN_A)
    const token = session.accessToken

    const first = await json<PasskeyRequestOptions>(
      await post('/sessions/step-up/passkey', {}, { token })
    )
    const wrong = await phone.get(first, { origin: ORIGIN_UNREGISTERED })
    const refused = await post(
      '/sessions/step-up',
      { method: 'passkey', credential: wrong },
      { token }
    )
    expect(refused.status).not.toBe(200)

    const again = await json<PasskeyRequestOptions>(
      await post('/sessions/step-up/passkey', {}, { token })
    )
    const right = await phone.get(again, { origin: ORIGIN_A })
    const stepped = await post(
      '/sessions/step-up',
      { method: 'passkey', credential: right },
      { token }
    )
    expect(stepped.status).toBe(200)
  })

  test('a passkey as the second factor of a password sign-in', async () => {
    await androidApp([FP_A])
    const session = await signUp()
    const token = session.accessToken
    const phone = new VirtualAuthenticator()
    await register(token, phone, ORIGIN_A)
    const enrolment = await json<TotpEnrolment>(await post('/me/factors/totp', {}, { token }))
    const confirmed = await post(
      '/me/factors/totp/confirm',
      { code: await totp(base32Decode(enrolment.secret), deps.clock.now()) },
      { token }
    )
    expect(confirmed.status).toBe(200)
    await Notices.settled()

    const started = await json<FlowAttempt>(await post('/sign-ins', { identifier: EMAIL }))
    const waiting = await json<FlowAttempt>(
      await post(`/sign-ins/${started.id}/password`, { password: PASSWORD })
    )
    expect(waiting.step.status).toBe('needs_second_factor')
    const optionsPath = `/sign-ins/${started.id}/second-factor/passkey/options`
    const factorPath = `/sign-ins/${started.id}/second-factor`

    const first = await json<PasskeyRequestOptions>(await post(optionsPath))
    const wrong = await phone.get(first, { origin: ORIGIN_UNREGISTERED })
    const refused = await post(factorPath, { method: 'passkey', credential: wrong })
    expect(refused.status).not.toBe(200)

    const again = await json<PasskeyRequestOptions>(await post(optionsPath))
    const right = await phone.get(again, { origin: ORIGIN_A })
    const done = await post(factorPath, { method: 'passkey', credential: right })
    expect(done.status).toBe(200)
    expect((await json<FlowAttempt>(done)).step.status).toBe('complete')
  })

  test('the list of passkeys needs no origin and no app', async () => {
    const session = await signUp()
    const res = await app.request('/v1/client/me/passkeys', {
      headers: {
        'x-tula-publishable-key': PK,
        authorization: `Bearer ${session.accessToken}`,
      },
    })
    expect(res.status).toBe(200)
    expect((await json<PasskeyList>(res)).passkeys).toEqual([])
  })
})
