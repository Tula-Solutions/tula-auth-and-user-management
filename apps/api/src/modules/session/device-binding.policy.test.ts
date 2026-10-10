import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  type DeviceKey,
  EnvironmentSettingsSchema,
  FLOW_ATTEMPT_HEADER,
  type FlowAttempt,
  jwkThumbprint,
  SESSION_PROFILE_HEADER,
} from '@tula/contract'
import { createApp } from '~/index'
import * as Hooks from '~/modules/hook/service'
import * as Notices from '~/modules/notice/service'
import * as DeviceBinding from '~/modules/session/device-binding'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '~/testing'
import { DPOP_HEADER, generateSoftwareDeviceKey, proofFor } from '~/testing/proofs'

// The device-binding option of a session profile (ADR 0043, "The policy of a profile"):
// what a sign-in is held to when it starts, when it completes and when its session is made.
// What a proof is, and what a bound session's refresh needs, is `device-binding.test.ts` and
// `device-binding.router.test.ts`: every test there runs under the defaults, unchanged.

const PK = 'tula_pk_dev_publishable0000000000000000000'
const EMAIL = 'maya@northline.app'
const PASSWORD = 'correct horse battery staple'
const ORIGIN = 'http://localhost:5173'
const USER = '00000000-0000-7000-8000-0000000000a1'
let deps: TestDeps
let app: ReturnType<typeof createApp>
let secrets: Map<string, string>
let key: DeviceKey
let jkt: string
let revision = 0

beforeAll(async () => {
  key = await generateSoftwareDeviceKey()
  jkt = await jwkThumbprint(key.publicJwk)
})

beforeEach(async () => {
  secrets = new Map()
  revision = 0
  deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  app = createApp(deps)
})

// Spies on stores and on module functions: none may outlive its test.
afterEach(() => {
  mock.restore()
})

type Binding = 'none' | 'optional' | 'required'
type Client = 'web' | 'ios' | 'android' | 'server'

/** Save session profiles for the test environment, validated like a real document. */
function configure(profiles: Record<string, unknown>): void {
  const settings = EnvironmentSettingsSchema.parse({
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    sessions: { profiles },
  })
  revision += 1
  deps.environmentSettings.seed(TEST_TENANT.environmentId, { revision, settings })
}

interface Options {
  /** `null` sends no `x-tula-client` header at all. */
  client?: Client | null
  proof?: string
  profile?: string
}

const ATTEMPT_PATH = /^\/(?:sign-ups|sign-ins|password-resets)\/([^/]+)\//

async function post(path: string, body: unknown = {}, options: Options = {}) {
  const client = options.client === undefined ? 'ios' : options.client
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-tula-publishable-key': PK,
  }
  if (client !== null) {
    headers['x-tula-client'] = client
  }
  if (client === null || client === 'web') {
    headers.origin = ORIGIN
  }
  if (options.proof !== undefined) {
    headers[DPOP_HEADER] = options.proof
  }
  if (options.profile !== undefined) {
    headers[SESSION_PROFILE_HEADER] = options.profile
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
  const started = (await res
    .clone()
    .json()
    .catch(() => null)) as Partial<FlowAttempt> | null
  if (started?.id && started.attemptSecret) {
    secrets.set(started.id, started.attemptSecret)
  }
  return res
}

const json = async <T>(res: Response) => (await res.json()) as T
const outcome = async (res: Response) =>
  res.status === 200 ? 'started' : (await json<{ code: string }>(res)).code
const sentCode = () => /\b(\d{6})\b/.exec(deps.mailer.last().text)?.[1] ?? ''
const validProof = async (path: string) =>
  proofFor(key, {
    now: deps.clock.now(),
    path: `/v1/client${path}`,
    nonce: await DeviceBinding.nonce(deps, TEST_TENANT),
  })

/** An account with a password, made under the defaults by a client that brought no proof. */
async function account(): Promise<void> {
  const attempt = await json<FlowAttempt>(
    await post('/sign-ups', { email: EMAIL, password: PASSWORD })
  )
  expect((await post(`/sign-ups/${attempt.id}/verify-email`, { code: sentCode() })).status).toBe(
    200
  )
  deps.mailer.outbox.length = 0
}

const sessionsOf = () =>
  deps.sessions.listActiveByUser(TEST_TENANT.environmentId, userId(), deps.clock.now())
let knownUser = ''
const userId = () => knownUser

describe('the option of a profile at the start of a sign-in', () => {
  // Every row of: option × client kind × proof. The profile is the client kind's built-in
  // (`web`, or `mobile` for every other kind); `absent` saves nothing for the option.
  const OPTIONS: (Binding | 'absent')[] = ['absent', 'none', 'optional', 'required']
  const CLIENTS: (Client | null)[] = ['web', null, 'ios', 'android', 'server']
  const PROOFS = ['no proof', 'a valid proof', 'an invalid proof'] as const

  function expected(
    option: Binding | 'absent',
    client: Client | null,
    proof: (typeof PROOFS)[number]
  ): string {
    if (client === 'web' || client === null) {
      // A browser, and a request that names no client kind (which is a browser's): not
      // affected by any value. A proof is refused as it always was, valid or not.
      return proof === 'no proof' ? 'started' : 'device.binding_not_supported'
    }
    const policy = option === 'absent' ? 'optional' : option
    if (proof === 'no proof') {
      return policy === 'required' ? 'device.binding_required' : 'started'
    }
    if (policy === 'none') {
      // Refused before the proof is looked at: valid or not, the answer is the same.
      return 'device.binding_not_supported'
    }
    return proof === 'a valid proof' ? 'started' : 'device.proof_invalid'
  }

  const rows = OPTIONS.flatMap((option) =>
    CLIENTS.flatMap((client) => PROOFS.map((proof) => [option, client, proof] as const))
  )

  test.each(rows)('%s, client %p, %s', async (option, client, proof) => {
    if (option !== 'absent') {
      // The same value on both built-ins: the web rows show that it changes nothing there.
      configure({ web: { deviceBinding: option }, mobile: { deviceBinding: option } })
    }
    const created = spyOn(deps.flowAttempts, 'create')
    const sent =
      proof === 'no proof'
        ? undefined
        : proof === 'a valid proof'
          ? await validProof('/sign-ins')
          : 'not.a.proof'
    const res = await post('/sign-ins', { identifier: EMAIL }, { client, proof: sent })
    const want = expected(option, client, proof)
    expect(await outcome(res)).toBe(want)
    if (want === 'started') {
      expect(created).toHaveBeenCalledTimes(1)
      const [record] = created.mock.calls[0] as [{ state: { deviceThumbprint?: string } }]
      expect(record.state.deviceThumbprint).toBe(proof === 'a valid proof' ? jkt : undefined)
    } else {
      // Nothing created, nothing sent.
      expect(created).not.toHaveBeenCalled()
      expect(deps.mailer.outbox).toEqual([])
      expect(res.status).toBe(want === 'device.proof_invalid' ? 401 : 400)
    }
  })
})

describe('required refuses a start without a proof, on every route that starts an attempt', () => {
  const STARTS: [string, unknown][] = [
    ['/sign-ups', { email: EMAIL, password: PASSWORD }],
    ['/sign-ins', { identifier: EMAIL }],
    ['/password-resets', { email: EMAIL }],
    ['/sign-ins/passkey', {}],
    ['/sign-ins/oauth', { provider: 'google', redirectUrl: 'https://app.northline.test/cb' }],
    ['/sign-ins/id-token', { provider: 'google' }],
  ]

  describe.each(STARTS)('%s', (path, body) => {
    test('required, no proof: 400 device.binding_required and nothing started', async () => {
      configure({ mobile: { deviceBinding: 'required' } })
      const created = spyOn(deps.flowAttempts, 'create')
      for (const client of ['ios', 'android', 'server'] as const) {
        const res = await post(path, body, { client })
        expect(res.status).toBe(400)
        expect(await outcome(res)).toBe('device.binding_required')
      }
      expect(created).not.toHaveBeenCalled()
      expect(deps.mailer.outbox).toEqual([])
    })

    test('none, a proof: 400 device.binding_not_supported, valid or not, and nothing started', async () => {
      configure({ mobile: { deviceBinding: 'none' } })
      const created = spyOn(deps.flowAttempts, 'create')
      const remembered = spyOn(deps.proofReplay, 'remember')
      for (const sent of [await validProof(path), 'not.a.proof', '']) {
        const res = await post(path, body, { proof: sent })
        expect(res.status).toBe(400)
        expect(await outcome(res)).toBe('device.binding_not_supported')
      }
      expect(created).not.toHaveBeenCalled()
      // The proof was never judged: its id is not remembered.
      expect(remembered).not.toHaveBeenCalled()
    })
  })
})

describe('the refusal says nothing about who is signing in', () => {
  test('an address with an account and one without get the same answer, and nothing is looked up', async () => {
    await account()
    configure({ mobile: { deviceBinding: 'required' } })
    const lookedUp = spyOn(deps.users, 'findByEmail')
    const created = spyOn(deps.flowAttempts, 'create')
    const limited = spyOn(deps.lockout, 'attempt')
    const answers: unknown[] = []
    for (const identifier of [EMAIL, 'nobody@elsewhere.example']) {
      const res = await post('/sign-ins', { identifier })
      answers.push([res.status, await res.json()])
    }
    expect(answers[0]).toEqual(answers[1])
    expect(answers[0]).toEqual([400, expect.objectContaining({ code: 'device.binding_required' })])
    expect(lookedUp).not.toHaveBeenCalled()
    expect(created).not.toHaveBeenCalled()
    expect(limited).not.toHaveBeenCalled()
    expect(deps.mailer.outbox).toEqual([])
  })
})

describe('the profile is the one the session would get', () => {
  test('a selectable profile’s own option applies to a client that names it', async () => {
    configure({
      mobile: { deviceBinding: 'required' },
      kiosk: { clientSelectable: true, deviceBinding: 'none' },
      vault: { clientSelectable: true, deviceBinding: 'required' },
    })
    // mobile: required.
    expect(await outcome(await post('/sign-ins', { identifier: EMAIL }))).toBe(
      'device.binding_required'
    )
    // kiosk: none. No proof starts; a proof is refused.
    expect(
      await outcome(await post('/sign-ins', { identifier: EMAIL }, { profile: 'kiosk' }))
    ).toBe('started')
    expect(
      await outcome(
        await post(
          '/sign-ins',
          { identifier: EMAIL },
          { profile: 'kiosk', proof: await validProof('/sign-ins') }
        )
      )
    ).toBe('device.binding_not_supported')
    // vault: required.
    expect(
      await outcome(await post('/sign-ins', { identifier: EMAIL }, { profile: 'vault' }))
    ).toBe('device.binding_required')
  })

  test.each(['hidden', 'nope', 'web', 'constructor'])(
    'a profile the client may not have (%s) is the client kind’s built-in, and so is its option',
    async (profile) => {
      configure({
        web: { deviceBinding: 'none' },
        mobile: { deviceBinding: 'required' },
        // Not selectable: naming it changes nothing, and its `none` is never applied.
        hidden: { deviceBinding: 'none' },
      })
      expect(await outcome(await post('/sign-ins', { identifier: EMAIL }, { profile }))).toBe(
        'device.binding_required'
      )
      expect(
        await outcome(
          await post(
            '/sign-ins',
            { identifier: EMAIL },
            { profile, proof: await validProof('/sign-ins') }
          )
        )
      ).toBe('started')
    }
  )

  test('a stateful profile is a browser’s: a native client that names it is held to mobile', async () => {
    configure({
      mobile: { deviceBinding: 'required' },
      desk: { type: 'stateful', clientSelectable: true, deviceBinding: 'none' },
    })
    expect(await outcome(await post('/sign-ins', { identifier: EMAIL }, { profile: 'desk' }))).toBe(
      'device.binding_required'
    )
  })

  test('a browser on a profile that says required is not affected: it signs in, unbound', async () => {
    configure({
      web: { deviceBinding: 'required' },
      mobile: { deviceBinding: 'required' },
      desk: { type: 'stateful', clientSelectable: true, deviceBinding: 'required' },
      shared: { clientSelectable: true, deviceBinding: 'required' },
    })
    await accountAs('web')
    for (const profile of [undefined, 'desk', 'shared']) {
      const attempt = await json<FlowAttempt>(
        await post('/sign-ins', { identifier: EMAIL }, { client: 'web', profile })
      )
      const res = await post(
        `/sign-ins/${attempt.id}/password`,
        { password: PASSWORD },
        { client: 'web' }
      )
      expect(res.status).toBe(200)
      const done = await json<FlowAttempt>(res)
      expect(done.step.status).toBe('complete')
      const session = await deps.sessions.findById(
        TEST_TENANT.environmentId,
        (done.step as { sessionId: string }).sessionId
      )
      expect(session?.deviceThumbprint).toBeNull()
      expect(session?.profile).toBe(profile ?? 'web')
      // And a browser's proof stays refused, as before the option existed.
      expect(
        await outcome(
          await post(
            '/sign-ins',
            { identifier: EMAIL },
            { client: 'web', profile, proof: await validProof('/sign-ins') }
          )
        )
      ).toBe('device.binding_not_supported')
    }
  })
})

/** An account made by a client of the given kind, under whatever is configured. */
async function accountAs(client: Client): Promise<void> {
  const attempt = await json<FlowAttempt>(
    await post('/sign-ups', { email: EMAIL, password: PASSWORD }, { client })
  )
  const res = await post(`/sign-ups/${attempt.id}/verify-email`, { code: sentCode() }, { client })
  expect(res.status).toBe(200)
  deps.mailer.outbox.length = 0
}

describe('under required, a sign-in with a key goes through and is bound', () => {
  test('sign-up, then sign-in, each with a proof at its start', async () => {
    configure({ mobile: { deviceBinding: 'required' } })
    const started = await post(
      '/sign-ups',
      { email: EMAIL, password: PASSWORD },
      { proof: await validProof('/sign-ups') }
    )
    expect(started.status).toBe(200)
    const attempt = await json<FlowAttempt>(started)
    const done = await json<FlowAttempt>(
      await post(`/sign-ups/${attempt.id}/verify-email`, { code: sentCode() })
    )
    expect(done.step.status).toBe('complete')
    const sessionId = (done.step as { sessionId: string }).sessionId
    expect(
      (await deps.sessions.findById(TEST_TENANT.environmentId, sessionId))?.deviceThumbprint
    ).toBe(jkt)
  })

  // The sixth start (ADR 0045). The provider is the fake adapter, which accepts any token:
  // what is asked here is the key's way from the start's proof to the session, not the token.
  test('a native ID-token sign-in with a proof at its start', async () => {
    const SK = 'tula_sk_dev_secret000000000000000000000000'
    await seedApiKey(deps, SK)
    const saved = await app.request('/v1/admin/oauth-providers/google', {
      method: 'PUT',
      headers: { authorization: `Bearer ${SK}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: '1234567890-webclient0000000000000000000000.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-test-client-secret-value',
        additionalClientIds: [
          '1234567890-androidclient00000000000000000.apps.googleusercontent.com',
        ],
      }),
    })
    expect(saved.status).toBe(200)
    configure({ mobile: { deviceBinding: 'required' } })

    const unbound = await post('/sign-ins/id-token', { provider: 'google' }, { client: 'android' })
    expect(await outcome(unbound)).toBe('device.binding_required')

    const started = await post(
      '/sign-ins/id-token',
      { provider: 'google' },
      { client: 'android', proof: await validProof('/sign-ins/id-token') }
    )
    expect(started.status).toBe(200)
    expect(started.headers.get('dpop-nonce')).toEqual(expect.any(String))
    const { attempt } = await json<{ attempt: FlowAttempt }>(started)
    secrets.set(attempt.id, attempt.attemptSecret as string)
    // The exchange brings no proof: the key was fixed when the attempt started.
    const res = await post(`/sign-ins/${attempt.id}/id-token`, { idToken: 'a-token' })
    expect(res.status).toBe(200)
    const done = await json<FlowAttempt>(res)
    expect(done.step.status).toBe('complete')
    const sessionId = (done.step as { sessionId: string }).sessionId
    expect(
      (await deps.sessions.findById(TEST_TENANT.environmentId, sessionId))?.deviceThumbprint
    ).toBe(jkt)
  })
})

describe('the option is the one in force when the attempt completes', () => {
  async function parked(proof?: string): Promise<FlowAttempt> {
    const res = await post('/sign-ins', { identifier: EMAIL }, { proof })
    expect(res.status).toBe(200)
    return json<FlowAttempt>(res)
  }

  async function user(): Promise<string> {
    const found = await deps.users.findByEmail(TEST_TENANT.environmentId, EMAIL)
    knownUser = found?.id ?? ''
    return knownUser
  }

  test.each([
    [
      'started unbound, the profile became required',
      undefined,
      'required',
      'device.binding_required',
    ],
    ['started bound, the profile became none', 'proof', 'none', 'device.binding_not_supported'],
  ] as const)(
    '%s: refused before the attempt is spent, a hook asked or a session made',
    async (_name, proof, becomes, code) => {
      await account()
      await user()
      const before = (await sessionsOf()).length
      const attempt = await parked(proof ? await validProof('/sign-ins') : undefined)
      configure({ mobile: { deviceBinding: becomes } })
      const moved = spyOn(deps.flowAttempts, 'transition')
      const asked = spyOn(Hooks, 'beforeSession')
      const made = spyOn(deps.sessions, 'create')
      const noticed = spyOn(Notices, 'newSignIn')
      const res = await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
      expect(res.status).toBe(400)
      expect(await outcome(res)).toBe(code)
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(moved).not.toHaveBeenCalled()
      expect(asked).not.toHaveBeenCalled()
      expect(made).not.toHaveBeenCalled()
      expect(noticed).not.toHaveBeenCalled()
      expect((await sessionsOf()).length).toBe(before)
      // A wrong password on the same attempt is still the generic refusal: the option is asked
      // only once every factor is proven, so it tells nobody whether a password was right
      // before it was.
      const wrong = await post(`/sign-ins/${attempt.id}/password`, { password: 'not the password' })
      expect(await outcome(wrong)).toBe('auth.invalid_credentials')
    }
  )

  test.each([
    ['started unbound under required, the profile became optional', 'optional'],
    ['started unbound under required, the profile became none', 'none'],
  ] as const)('%s: nothing to finish, because nothing was started', async (_name, becomes) => {
    await account()
    configure({ mobile: { deviceBinding: 'required' } })
    expect(await outcome(await post('/sign-ins', { identifier: EMAIL }))).toBe(
      'device.binding_required'
    )
    configure({ mobile: { deviceBinding: becomes } })
    expect(await outcome(await post('/sign-ins', { identifier: EMAIL }))).toBe('started')
  })
})

describe('Sessions.create holds the rule whatever a caller passes', () => {
  const tenant = { ...TEST_TENANT, apiKeyId: 'key_1' }
  const THUMBPRINT = 'N'.repeat(43)

  async function code(promise: Promise<unknown>): Promise<string> {
    try {
      await promise
      return 'created'
    } catch (error) {
      return (error as { code?: string }).code ?? String(error)
    }
  }

  // option × client × key × session type. A `stateful` profile is reached only by a browser
  // that names it; a native client that names it gets `mobile`.
  const rows: [Binding, Client, boolean, 'hybrid' | 'stateful', string][] = []
  for (const option of ['none', 'optional', 'required'] as const) {
    for (const client of ['web', 'ios', 'android', 'server'] as const) {
      for (const bound of [false, true]) {
        for (const type of ['hybrid', 'stateful'] as const) {
          const browser = client === 'web'
          let want = 'created'
          if (browser) {
            want = bound ? 'device.binding_not_supported' : 'created'
          } else if (bound && option === 'none') {
            want = 'device.binding_not_supported'
          } else if (!bound && option === 'required') {
            want = 'device.binding_required'
          }
          rows.push([option, client, bound, type, want])
        }
      }
    }
  }

  test.each(rows)(
    '%s, %s, key %p, a %s profile asked for: %s',
    async (option, client, bound, type, want) => {
      configure({
        web: { deviceBinding: option },
        mobile: { deviceBinding: option },
        asked: { type, clientSelectable: true, deviceBinding: option },
      })
      const stored = spyOn(deps.sessions, 'create')
      const hook = spyOn(Hooks, 'beforeToken')
      const result = await code(
        Sessions.create(deps, tenant, {
          userId: USER,
          client,
          profile: 'asked',
          deviceThumbprint: bound ? THUMBPRINT : null,
        })
      )
      expect(result).toBe(want)
      if (want === 'created') {
        expect(stored).toHaveBeenCalledTimes(1)
        const session = stored.mock.calls[0]?.[0]
        expect(session?.deviceThumbprint).toBe(bound ? THUMBPRINT : null)
        // A native client never gets the stateful profile it named.
        expect(session?.type).toBe(client === 'web' ? type : 'hybrid')
      } else {
        // Before the claims hook is asked and before anything is stored.
        expect(stored).not.toHaveBeenCalled()
        expect(hook).not.toHaveBeenCalled()
      }
    }
  )
})

describe('a setting changes new sign-ins, never what a session is', () => {
  const tenant = { ...TEST_TENANT, apiKeyId: 'key_1' }

  async function signedIn(proof: boolean) {
    const path = '/sign-ups'
    const started = await post(
      path,
      { email: EMAIL, password: PASSWORD },
      { proof: proof ? await validProof(path) : undefined }
    )
    const attempt = await json<FlowAttempt>(started)
    const done = await json<FlowAttempt & { session: { sessionId: string; refreshToken: string } }>(
      await post(`/sign-ups/${attempt.id}/verify-email`, { code: sentCode() })
    )
    return done.session
  }

  const refresh = (refreshToken: string, proof?: string) =>
    post('/sessions/refresh', { refreshToken }, { proof })

  test('a session bound before its profile became none still needs its proof at every refresh', async () => {
    const session = await signedIn(true)
    configure({ mobile: { deviceBinding: 'none' } })
    const refused = await refresh(session.refreshToken)
    expect(refused.status).toBe(401)
    expect(await outcome(refused)).toBe('device.proof_invalid')
    const stored = await deps.sessions.findById(TEST_TENANT.environmentId, session.sessionId)
    expect(stored?.deviceThumbprint).toBe(jkt)
    expect(stored?.revokedAt).toBeNull()
    // The same token, with a proof of the session's key: accepted, under `none`.
    const proven = await refresh(session.refreshToken, await validProof('/sessions/refresh'))
    expect(proven.status).toBe(200)
  })

  test('a session that is not bound lives on, and refreshes, after its profile became required', async () => {
    const session = await signedIn(false)
    configure({ mobile: { deviceBinding: 'required' } })
    const first = await refresh(session.refreshToken)
    expect(first.status).toBe(200)
    const next = await json<{ refreshToken: string }>(first)
    deps.clock.advance('2m')
    expect((await refresh(next.refreshToken)).status).toBe(200)
    const stored = await deps.sessions.findById(TEST_TENANT.environmentId, session.sessionId)
    expect(stored?.revokedAt).toBeNull()
    expect(stored?.deviceThumbprint).toBeNull()
    // It is listed as what it is.
    const [listed] = await Sessions.list(deps, tenant, {
      userId: stored?.userId ?? '',
      currentSessionId: session.sessionId,
    })
    expect(listed?.deviceBound).toBe(false)
    // And a new sign-in of the same client is held to the option.
    expect(await outcome(await post('/sign-ins', { identifier: EMAIL }))).toBe(
      'device.binding_required'
    )
  })
})

describe('ending sessions needs neither a recent authentication nor a proof', () => {
  // ADR 0043, "Signing out one's other sessions": ending a session only ever reduces access,
  // and a user who suspects a device must be able to act with what they have. Pinned, not an
  // oversight: gating either route is a decision.
  async function signedIn(proof: boolean) {
    const started = await post(
      '/sign-ins',
      { identifier: EMAIL },
      { proof: proof ? await validProof('/sign-ins') : undefined }
    )
    const attempt = await json<FlowAttempt>(started)
    const done = await json<FlowAttempt & { session: { sessionId: string; refreshToken: string } }>(
      await post(`/sign-ins/${attempt.id}/password`, { password: PASSWORD })
    )
    return done.session
  }

  async function call(method: string, path: string, accessToken: string) {
    return app.request(`/v1/client${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-tula-publishable-key': PK,
        authorization: `Bearer ${accessToken}`,
      },
      ...(method === 'POST' && { body: '{}' }),
    })
  }

  test.each([
    ['a bound session', true],
    ['a session that is not bound', false],
  ])(
    '%s signs out the others an hour after it signed in, with no DPoP header',
    async (_name, bound) => {
      await account()
      const [mine, other, third] = [
        await signedIn(bound),
        await signedIn(true),
        await signedIn(false),
      ]
      // Long past every step-up window; the session is kept alive by its refreshes.
      deps.clock.advance('1h')
      const refreshed = await post(
        '/sessions/refresh',
        { refreshToken: mine.refreshToken },
        { proof: bound ? await validProof('/sessions/refresh') : undefined }
      )
      expect(refreshed.status).toBe(200)
      const { accessToken } = await json<{ accessToken: string }>(refreshed)
      // The token is not a recent authentication: a route that needs one says so.
      const sensitive = await call('POST', '/me/factors/totp', accessToken)
      expect(sensitive.status).toBe(403)
      expect(await outcome(sensitive)).toBe('auth.step_up_required')
      // One other session, by id.
      const one = await call('DELETE', `/sessions/${third.sessionId}`, accessToken)
      expect(one.status).toBe(204)
      // And every other one: the second sign-in and the session the sign-up ended in.
      const others = await call('POST', '/sessions/revoke-others', accessToken)
      expect(others.status).toBe(200)
      expect(await others.json()).toEqual({ revoked: 2 })
      const find = (id: string) => deps.sessions.findById(TEST_TENANT.environmentId, id)
      expect((await find(other.sessionId))?.revokedAt).not.toBeNull()
      expect((await find(third.sessionId))?.revokedAt).not.toBeNull()
      expect((await find(mine.sessionId))?.revokedAt).toBeNull()
    }
  )
})
