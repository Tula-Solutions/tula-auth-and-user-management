import { describe, expect, test } from 'bun:test'
import { createClient } from './client'
import { isTulaError } from './errors'
import { PASSKEY_AUTOFILL_ROUND_MS } from './flows'
import {
  base64UrlToBytes,
  browserProvider,
  bytesToBase64Url,
  authenticatorOf as ceremoniesOf,
  type PasskeyCreationOptions,
  type PasskeyGlobals,
  type PasskeyProvider,
  type PasskeyRequestOptions,
} from './passkey'
import {
  type FakeApi,
  failure,
  fakeApi,
  fakeEnvironment,
  fakeTimers,
  json,
  manualClock,
  sessionTokens,
  TEST_BASE_URL,
  TEST_KEY,
  TEST_USER,
} from './testing/fakes'

const ATTEMPT = 'attempt_passkey'
const SECRET = 'tula_at_secret'
const EXPIRES = '2026-01-01T00:10:00.000Z'
const CREATION: PasskeyCreationOptions = {
  rp: { id: 'northline.test', name: 'Northline' },
  user: { id: 'dXNlcg', name: 'maya@northline.app', displayName: 'Maya' },
  challenge: 'Y2hhbGxlbmdl',
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 300_000,
  excludeCredentials: [{ type: 'public-key', id: 'b2xk', transports: ['internal'] }],
  authenticatorSelection: {
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required',
  },
  attestation: 'none',
}
const REQUEST: PasskeyRequestOptions = {
  challenge: 'Y2hhbGxlbmdl',
  timeout: 300_000,
  rpId: 'northline.test',
  userVerification: 'required',
}
const REGISTRATION = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'YXR0', transports: ['internal'] },
  clientExtensionResults: {},
}
const ASSERTION = {
  id: 'Y3JlZA',
  rawId: 'Y3JlZA',
  type: 'public-key',
  response: {
    clientDataJSON: 'e30',
    authenticatorData: 'YXV0aA',
    signature: 'c2ln',
    userHandle: 'dXNlcg',
  },
  clientExtensionResults: {},
}
const PASSKEY = {
  id: 'passkey_1',
  name: 'MacBook',
  synced: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
}

const named = (name: string) => Object.assign(new Error('the browser said something'), { name })
const text = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes)

interface Seen {
  create: Record<string, unknown>[]
  get: Record<string, unknown>[]
}

/** A browser's WebAuthn globals: answers with JSON-capable credentials and records the calls. */
function browser(
  overrides: {
    create?: (options: Record<string, unknown>) => Promise<unknown>
    get?: (options: Record<string, unknown>) => Promise<unknown>
    parse?: boolean
    conditional?: boolean | 'throws'
  } = {}
): { globals: PasskeyGlobals; seen: Seen } {
  const seen: Seen = { create: [], get: [] }
  const globals: PasskeyGlobals = {
    navigator: {
      credentials: {
        async create(options) {
          seen.create.push(options as Record<string, unknown>)
          return overrides.create
            ? overrides.create(options as Record<string, unknown>)
            : { toJSON: () => REGISTRATION }
        },
        async get(options) {
          seen.get.push(options as Record<string, unknown>)
          return overrides.get
            ? overrides.get(options as Record<string, unknown>)
            : { toJSON: () => ASSERTION }
        },
      },
    },
    PublicKeyCredential: {
      ...(overrides.parse && {
        parseCreationOptionsFromJSON: (options: unknown) => ({ parsed: 'creation', options }),
        parseRequestOptionsFromJSON: (options: unknown) => ({ parsed: 'request', options }),
      }),
      ...(overrides.conditional !== undefined && {
        isConditionalMediationAvailable: async () => {
          if (overrides.conditional === 'throws') {
            throw new Error('no')
          }
          return overrides.conditional === true
        },
      }),
    },
  }
  return { globals, seen }
}

/** A browser's ceremonies: what the client builds from the page's globals. */
function authenticatorOf(globals: PasskeyGlobals) {
  const provider = browserProvider(globals)
  return provider && ceremoniesOf(provider, () => ({}))
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    if (isTulaError(error)) {
      expect(error.status).toBe(0)
      // The browser's own message, which can quote the page, never travels.
      expect(error.message).not.toContain('the browser said something')
      return error.code
    }
    return `threw ${String(error)}`
  }
  return 'resolved'
}

describe('base64url', () => {
  test('round-trips bytes, without padding, with the URL alphabet, from a buffer or a view', () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2])
    expect(bytesToBase64Url(bytes.buffer)).toBe('-_8AAQI')
    expect(bytesToBase64Url(bytes.subarray(1, 3))).toBe('_wA')
    expect(new Uint8Array(base64UrlToBytes('-_8AAQI'))).toEqual(bytes)
  })
})

describe('a browser’s ceremonies', () => {
  test.each<[string, PasskeyGlobals]>([
    ['no navigator', {}],
    ['no credentials container', { navigator: {}, PublicKeyCredential: {} }],
    [
      'no PublicKeyCredential',
      { navigator: { credentials: browser().globals.navigator?.credentials } },
    ],
    [
      'a container without create',
      { navigator: { credentials: { get: async () => null } }, PublicKeyCredential: {} },
    ],
    [
      'globals that throw when read (a sandboxed frame)',
      Object.defineProperty({}, 'navigator', {
        get() {
          throw new Error('denied')
        },
      }),
    ],
  ])('there is no authenticator with %s', (_, globals) => {
    expect(authenticatorOf(globals)).toBeUndefined()
  })

  test('without the browser’s own JSON helpers, options are decoded and the response encoded here', async () => {
    const raw = {
      id: 'Y3JlZA',
      rawId: new Uint8Array([99, 114, 101, 100]).buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: new TextEncoder().encode('{}').buffer,
        attestationObject: new Uint8Array([97, 116, 116]),
        getTransports: () => ['internal', 'hybrid'],
      },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    }
    const { globals, seen } = browser({ create: async () => raw })
    const made = await authenticatorOf(globals)?.create(CREATION)
    expect(made).toEqual({
      id: 'Y3JlZA',
      rawId: 'Y3JlZA',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: 'e30',
        attestationObject: 'YXR0',
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: { credProps: { rk: true } },
    } as never)
    const publicKey = seen.create[0]?.publicKey as Record<string, unknown>
    expect(text(publicKey.challenge as ArrayBuffer)).toBe('challenge')
    expect(text((publicKey.user as { id: ArrayBuffer }).id)).toBe('user')
    expect(
      text((publicKey.excludeCredentials as { id: ArrayBuffer }[])[0]?.id as ArrayBuffer)
    ).toBe('old')
    expect(publicKey).toMatchObject({ rp: CREATION.rp, attestation: 'none' })
    expect(seen.create[0]).not.toHaveProperty('signal')
  })

  test('an assertion is encoded the same way, with its user handle, and allowCredentials decoded', async () => {
    const raw = {
      id: 'Y3JlZA',
      type: 'public-key',
      response: {
        clientDataJSON: new TextEncoder().encode('{}').buffer,
        authenticatorData: new TextEncoder().encode('auth').buffer,
        signature: new TextEncoder().encode('sig').buffer,
        userHandle: new TextEncoder().encode('user').buffer,
      },
    }
    const { globals, seen } = browser({ get: async () => raw })
    const controller = new AbortController()
    const assertion = await authenticatorOf(globals)?.get(
      { ...REQUEST, allowCredentials: [{ type: 'public-key', id: 'b2xk' }] },
      { signal: controller.signal }
    )
    expect(assertion).toEqual({ ...ASSERTION, clientExtensionResults: {} } as never)
    const publicKey = seen.get[0]?.publicKey as Record<string, unknown>
    expect(text(publicKey.challenge as ArrayBuffer)).toBe('challenge')
    expect(text((publicKey.allowCredentials as { id: ArrayBuffer }[])[0]?.id as ArrayBuffer)).toBe(
      'old'
    )
    expect(seen.get[0]?.signal).toBe(controller.signal)
    expect(seen.get[0]).not.toHaveProperty('mediation')
    // No allowCredentials in: none out.
    await authenticatorOf(globals)?.get(REQUEST)
    expect(seen.get[1]?.publicKey).not.toHaveProperty('allowCredentials')
  })

  test('the browser’s own parse helpers and toJSON are used where they exist', async () => {
    const { globals, seen } = browser({ parse: true })
    const authenticator = authenticatorOf(globals)
    expect(await authenticator?.create(CREATION)).toEqual(REGISTRATION as never)
    expect(await authenticator?.get(REQUEST, { autofill: true })).toEqual(ASSERTION as never)
    expect(seen.create[0]?.publicKey).toEqual({ parsed: 'creation', options: CREATION })
    expect(seen.get[0]).toMatchObject({
      publicKey: { parsed: 'request', options: REQUEST },
      mediation: 'conditional',
    })
  })

  test('a credential whose toJSON throws is encoded by hand instead', async () => {
    const { globals } = browser({
      get: async () => ({
        id: 'Y3JlZA',
        rawId: new TextEncoder().encode('cred').buffer,
        type: 'public-key',
        toJSON() {
          throw new Error('extension bug')
        },
        response: {
          clientDataJSON: new TextEncoder().encode('{}').buffer,
          authenticatorData: new TextEncoder().encode('auth').buffer,
          signature: new TextEncoder().encode('sig').buffer,
        },
      }),
    })
    expect((await authenticatorOf(globals)?.get(REQUEST))?.response.signature).toBe('c2ln')
  })

  test.each<[string, string]>([
    ['NotAllowedError', 'passkey.cancelled'],
    ['AbortError', 'passkey.cancelled'],
    ['InvalidStateError', 'passkey.already_on_device'],
    ['NotSupportedError', 'passkey.unsupported'],
    ['SecurityError', 'passkey.failed'],
    ['UnknownError', 'passkey.failed'],
  ])('a ceremony that throws %s is %s', async (name, code) => {
    const fail = async () => {
      throw named(name)
    }
    const { globals } = browser({ create: fail, get: fail })
    expect(await codeOf(authenticatorOf(globals)?.create(CREATION) as Promise<unknown>)).toBe(code)
    expect(await codeOf(authenticatorOf(globals)?.get(REQUEST) as Promise<unknown>)).toBe(code)
  })

  test.each<[string, unknown]>([
    ['nothing (the browser resolved null)', null],
    ['a string thrown instead of an error', 'never mind'],
    ['a credential of another type', { toJSON: () => ({ ...ASSERTION, type: 'password' }) }],
    ['a response with a field missing', { toJSON: () => ({ ...ASSERTION, response: {} }) }],
    ['a value that is not base64url', { toJSON: () => ({ ...ASSERTION, id: 'a+b=' }) }],
  ])('%s is passkey.failed, never passed on', async (_, answer) => {
    const { globals } = browser({
      create: async () => answer,
      get: async () => {
        if (typeof answer === 'string') {
          throw answer
        }
        return answer
      },
    })
    expect(await codeOf(authenticatorOf(globals)?.get(REQUEST) as Promise<unknown>)).toBe(
      'passkey.failed'
    )
    if (typeof answer !== 'string') {
      expect(await codeOf(authenticatorOf(globals)?.create(CREATION) as Promise<unknown>)).toBe(
        'passkey.failed'
      )
    }
  })

  test('autofill is available only where the browser says so', async () => {
    const asked = (globals: PasskeyGlobals) => world(globals).tula.signIn.canAutofillPasskey()
    expect(await asked(browser().globals)).toBe(false)
    expect(await asked(browser({ conditional: false }).globals)).toBe(false)
    expect(await asked(browser({ conditional: 'throws' }).globals)).toBe(false)
    expect(await asked(browser({ conditional: true }).globals)).toBe(true)
  })
})

function world(
  passkeys: PasskeyGlobals | null = browser().globals,
  passkeyProvider?: PasskeyProvider
) {
  const api = fakeApi()
  const clock = manualClock()
  const timers = fakeTimers()
  api.on('GET /v1/client/me', () => json(200, TEST_USER))
  api.on('POST /v1/client/sessions/refresh', () => json(200, sessionTokens('refreshed')))
  const tula = createClient(
    { publishableKey: TEST_KEY, baseUrl: TEST_BASE_URL, client: 'web', fetch: api.fetch },
    fakeEnvironment(clock, { passkeys: passkeys ?? undefined, timers, passkeyProvider })
  )
  return { api, tula, timers }
}

const attempt = (step: object, extra: object = {}) => ({
  id: ATTEMPT,
  kind: 'sign_in',
  expiresAt: EXPIRES,
  step,
  ...extra,
})
const START = 'POST /v1/client/sign-ins/passkey'
const SUBMIT = `POST /v1/client/sign-ins/${ATTEMPT}/passkey`

function signInRoutes(api: FakeApi) {
  api.on(START, () =>
    json(200, {
      attempt: attempt(
        { status: 'needs_first_factor', strategies: ['passkey'] },
        { attemptSecret: SECRET }
      ),
      options: REQUEST,
    })
  )
  api.on(SUBMIT, () =>
    json(
      200,
      attempt(
        { status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' },
        { session: sessionTokens('passkey') }
      )
    )
  )
}

describe('signIn.withPasskey', () => {
  test('starts an attempt, asks the authenticator and submits the assertion with the attempt’s secret', async () => {
    const globals = browser()
    const { api, tula } = world(globals.globals)
    signInRoutes(api)
    expect(tula.signIn.canUsePasskey()).toBe(true)
    const flow = await tula.signIn.withPasskey()
    expect(flow.step).toEqual({ status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' })
    expect(tula.state.status).toBe('signed-in')
    const [submitted] = api.calls(SUBMIT)
    expect(submitted?.body).toEqual({ credential: ASSERTION })
    expect(submitted?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(api.calls(START)[0]?.body).toBeUndefined()
    expect(globals.seen.get[0]).not.toHaveProperty('mediation')
    // Nothing of the ceremony is kept on the flow.
    expect(JSON.stringify(flow)).not.toContain(SECRET)
    expect(JSON.stringify(flow)).not.toContain(ASSERTION.response.signature)
  })

  test('a runtime without WebAuthn says so before any request', async () => {
    const { api, tula } = world(null)
    expect(tula.signIn.canUsePasskey()).toBe(false)
    expect(await tula.signIn.canAutofillPasskey()).toBe(false)
    expect(await codeOf(tula.signIn.withPasskey())).toBe('passkey.unsupported')
    expect(await codeOf(tula.user.passkeys.add())).toBe('passkey.unsupported')
    expect(await codeOf(tula.session.stepUpWithPasskey())).toBe('passkey.unsupported')
    expect(api.requests).toEqual([])
  })

  test('a dismissed dialog submits nothing and signs nobody in', async () => {
    const { api, tula } = world(
      browser({
        get: async () => {
          throw named('NotAllowedError')
        },
      }).globals
    )
    signInRoutes(api)
    expect(await codeOf(tula.signIn.withPasskey())).toBe('passkey.cancelled')
    expect(api.calls(SUBMIT)).toEqual([])
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('a refused assertion is the API’s generic failure', async () => {
    const { api, tula } = world()
    signInRoutes(api)
    api.on(SUBMIT, () => failure(401, 'auth.invalid_credentials'))
    await expect(tula.signIn.withPasskey()).rejects.toMatchObject({
      code: 'auth.invalid_credentials',
      status: 401,
    })
    expect(tula.state.status).not.toBe('signed-in')
  })

  test.each<[string, unknown]>([
    [
      'no options',
      {
        attempt: attempt(
          { status: 'needs_first_factor', strategies: ['passkey'] },
          { attemptSecret: SECRET }
        ),
      },
    ],
    ['options without a challenge', { attempt: {}, options: { rpId: 'northline.test' } }],
    ['no attempt', { options: REQUEST }],
    [
      'an attempt without its secret',
      {
        attempt: attempt({ status: 'needs_first_factor', strategies: ['passkey'] }),
        options: REQUEST,
      },
    ],
    ['a page instead of JSON', '<html>'],
  ])('a start that answers %s is not this API', async (_, body) => {
    const globals = browser()
    const { api, tula } = world(globals.globals)
    api.on(START, () => json(200, body))
    expect(await codeOf(tula.signIn.withPasskey())).toBe('response.invalid')
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('an unverified address stops at needs_email_verification, with a flow to continue on', async () => {
    const { api, tula } = world()
    signInRoutes(api)
    api.on(SUBMIT, () =>
      json(
        200,
        attempt({
          status: 'needs_email_verification',
          destination: 'm***@northline.app',
          strategies: ['email_code'],
        })
      )
    )
    const flow = await tula.signIn.withPasskey()
    expect(flow.step.status).toBe('needs_email_verification')
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('autofill asks with conditional mediation and a signal of its own, and leaves no timer behind', async () => {
    const globals = browser({ conditional: true })
    const { api, tula, timers } = world(globals.globals)
    signInRoutes(api)
    expect(await tula.signIn.canAutofillPasskey()).toBe(true)
    const flow = await tula.signIn.withPasskey({ autofill: true })
    expect(flow.step.status).toBe('complete')
    expect(globals.seen.get[0]).toMatchObject({ mediation: 'conditional' })
    expect(globals.seen.get[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(timers.pending()).toEqual([])
  })

  test('an autofill round that outlives its challenge is started again with a fresh attempt', async () => {
    let round = 0
    const globals = browser({
      get: (options) =>
        new Promise((resolve, reject) => {
          round += 1
          if (round === 2) {
            resolve({ toJSON: () => ASSERTION })
            return
          }
          const signal = options.signal as AbortSignal
          signal.addEventListener('abort', () => reject(named('AbortError')))
        }),
    })
    const { api, tula, timers } = world(globals.globals)
    signInRoutes(api)
    const pending = tula.signIn.withPasskey({ autofill: true })
    while (timers.pending().length === 0) {
      await Promise.resolve()
    }
    expect(timers.pending()).toEqual([PASSKEY_AUTOFILL_ROUND_MS])
    timers.fire()
    const flow = await pending
    expect(flow.step.status).toBe('complete')
    expect(api.calls(START)).toHaveLength(2)
    expect(api.calls(SUBMIT)).toHaveLength(1)
    expect(timers.pending()).toEqual([])
  })

  test('aborting an autofill request ends it: cancelled, no retry, no timer', async () => {
    const globals = browser({
      get: (options) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal as AbortSignal
          if (signal.aborted) {
            reject(named('AbortError'))
          }
          signal.addEventListener('abort', () => reject(named('AbortError')))
        }),
    })
    const { api, tula, timers } = world(globals.globals)
    signInRoutes(api)
    const controller = new AbortController()
    const pending = tula.signIn.withPasskey({ autofill: true, signal: controller.signal })
    while (timers.pending().length === 0) {
      await Promise.resolve()
    }
    controller.abort()
    expect(await codeOf(pending)).toBe('passkey.cancelled')
    expect(api.calls(START)).toHaveLength(1)
    expect(timers.pending()).toEqual([])
    // A signal that is already aborted ends the round at once too.
    expect(
      await codeOf(tula.signIn.withPasskey({ autofill: true, signal: controller.signal }))
    ).toBe('passkey.cancelled')
    expect(timers.pending()).toEqual([])
  })
})

describe('a passkey as the second factor', () => {
  const OPTIONS = `POST /v1/client/sign-ins/${ATTEMPT}/second-factor/passkey/options`
  const SECOND = `POST /v1/client/sign-ins/${ATTEMPT}/second-factor`

  async function waiting(passkeys?: PasskeyGlobals) {
    const made = world(passkeys ?? browser().globals)
    made.api.on('POST /v1/client/sign-ins', () =>
      json(
        200,
        attempt(
          { status: 'needs_second_factor', options: ['totp', 'passkey'] },
          { attemptSecret: SECRET }
        )
      )
    )
    made.api.on(OPTIONS, () => json(200, { ...REQUEST, allowCredentials: [] }))
    made.api.on(SECOND, () =>
      json(
        200,
        attempt(
          { status: 'complete', userId: TEST_USER.id, sessionId: 'session_1' },
          { session: sessionTokens('second') }
        )
      )
    )
    const flow = await made.tula.signIn.start({ identifier: 'maya@northline.app' })
    return { ...made, flow }
  }

  test('asks for the options, runs the ceremony and submits the assertion', async () => {
    const { api, flow, tula } = await waiting()
    const { step } = await flow.submitSecondFactorWithPasskey()
    expect(step.status).toBe('complete')
    expect(tula.state.status).toBe('signed-in')
    expect(api.calls(OPTIONS)[0]?.headers.get('x-tula-attempt')).toBe(SECRET)
    expect(api.calls(SECOND)[0]?.body).toEqual({ method: 'passkey', credential: ASSERTION })
  })

  test('a proof is sent with what its method takes and nothing else', async () => {
    const { api, flow } = await waiting()
    await flow.submitSecondFactor({
      method: 'totp',
      code: '123456',
      credential: ASSERTION,
    } as never)
    expect(api.calls(SECOND)[0]?.body).toEqual({ method: 'totp', code: '123456' })
  })

  test('a cancelled dialog or unusable options leave the flow on its step', async () => {
    const cancelled = await waiting(
      browser({
        get: async () => {
          throw named('NotAllowedError')
        },
      }).globals
    )
    expect(await codeOf(cancelled.flow.submitSecondFactorWithPasskey())).toBe('passkey.cancelled')
    expect(cancelled.api.calls(SECOND)).toEqual([])
    expect(cancelled.flow.step.status).toBe('needs_second_factor')
    const odd = await waiting()
    odd.api.on(OPTIONS, () => json(200, { rpId: 'northline.test' }))
    expect(await codeOf(odd.flow.submitSecondFactorWithPasskey())).toBe('response.invalid')
    const none = await waiting({})
    expect(await codeOf(none.flow.submitSecondFactorWithPasskey())).toBe('passkey.unsupported')
    expect(none.api.calls(OPTIONS)).toEqual([])
  })
})

describe('user.passkeys and step-up', () => {
  async function signedIn(passkeys?: PasskeyGlobals) {
    const made = world(passkeys ?? browser().globals)
    await made.tula.load()
    expect(made.tula.state.status).toBe('signed-in')
    return made
  }

  test('list hands on the known fields of each passkey and nothing else', async () => {
    const { api, tula } = await signedIn()
    api.on('GET /v1/client/me/passkeys', () =>
      json(200, { passkeys: [{ ...PASSKEY, publicKey: 'leak', credentialId: 'leak' }] })
    )
    expect(await tula.user.passkeys.list()).toEqual([PASSKEY])
    api.on('GET /v1/client/me/passkeys', () => json(200, { passkeys: [{ id: 'x' }] }))
    expect(await codeOf(tula.user.passkeys.list())).toBe('response.invalid')
  })

  test('add asks for options, creates the credential and saves it with the name', async () => {
    const globals = browser()
    const { api, tula } = await signedIn(globals.globals)
    api.on('POST /v1/client/me/passkeys/options', () => json(200, CREATION))
    api.on('POST /v1/client/me/passkeys', () => json(201, PASSKEY))
    const controller = new AbortController()
    expect(await tula.user.passkeys.add({ name: 'MacBook', signal: controller.signal })).toEqual(
      PASSKEY
    )
    expect(api.calls('POST /v1/client/me/passkeys')[0]?.body).toEqual({
      credential: REGISTRATION,
      name: 'MacBook',
    })
    expect(globals.seen.create[0]?.signal).toBe(controller.signal)
    await tula.user.passkeys.add()
    expect(api.calls('POST /v1/client/me/passkeys')[1]?.body).toEqual({ credential: REGISTRATION })
  })

  test('add stops before the dialog on unusable options, and before the save on a cancelled dialog', async () => {
    const globals = browser({
      create: async () => {
        throw named('InvalidStateError')
      },
    })
    const { api, tula } = await signedIn(globals.globals)
    api.on('POST /v1/client/me/passkeys/options', () => json(200, { challenge: 'x' }))
    expect(await codeOf(tula.user.passkeys.add())).toBe('response.invalid')
    expect(globals.seen.create).toEqual([])
    api.on('POST /v1/client/me/passkeys/options', () => json(200, CREATION))
    expect(await codeOf(tula.user.passkeys.add())).toBe('passkey.already_on_device')
    expect(api.calls('POST /v1/client/me/passkeys')).toEqual([])
    api.on('POST /v1/client/me/passkeys/options', () =>
      failure(403, 'auth.step_up_required', { params: { methods: 'passkey,password' } })
    )
    await expect(tula.user.passkeys.add()).rejects.toMatchObject({ code: 'auth.step_up_required' })
  })

  test('rename and remove name the passkey in the path', async () => {
    const { api, tula } = await signedIn()
    api.on('PATCH /v1/client/me/passkeys/passkey_1', () => json(200, { ...PASSKEY, name: 'Work' }))
    api.on('DELETE /v1/client/me/passkeys/passkey_1', () => new Response(null, { status: 204 }))
    expect(await tula.user.passkeys.rename({ passkeyId: 'passkey_1', name: 'Work' })).toEqual({
      ...PASSKEY,
      name: 'Work',
    })
    expect(api.calls('PATCH /v1/client/me/passkeys/passkey_1')[0]?.body).toEqual({ name: 'Work' })
    await tula.user.passkeys.remove({ passkeyId: 'passkey_1' })
    expect(api.calls('DELETE /v1/client/me/passkeys/passkey_1')).toHaveLength(1)
    api.on('DELETE /v1/client/me/passkeys/passkey_1', () =>
      failure(409, 'passkey.last_sign_in_method')
    )
    await expect(tula.user.passkeys.remove({ passkeyId: 'passkey_1' })).rejects.toMatchObject({
      code: 'passkey.last_sign_in_method',
    })
  })

  test('stepUpWithPasskey proves the assertion and installs the fresh access token', async () => {
    const { api, tula } = await signedIn()
    api.on('POST /v1/client/sessions/step-up/passkey', () =>
      json(200, { ...REQUEST, allowCredentials: [{ type: 'public-key', id: 'Y3JlZA' }] })
    )
    const fresh = sessionTokens('stepped')
    api.on('POST /v1/client/sessions/step-up', () =>
      json(200, {
        sessionId: fresh.sessionId,
        accessToken: fresh.accessToken,
        accessTokenExpiresAt: fresh.accessTokenExpiresAt,
      })
    )
    await tula.session.stepUpWithPasskey()
    expect(api.calls('POST /v1/client/sessions/step-up')[0]?.body).toEqual({
      method: 'passkey',
      credential: ASSERTION,
    })
    expect(await tula.session.getToken()).toBe(fresh.accessToken)
  })

  test('a step-up whose options are refused or unusable, or whose dialog is dismissed, proves nothing', async () => {
    const globals = browser({
      get: async () => {
        throw named('NotAllowedError')
      },
    })
    const { api, tula } = await signedIn(globals.globals)
    api.on('POST /v1/client/sessions/step-up/passkey', () =>
      failure(403, 'auth.step_up_required', { params: { methods: 'password' } })
    )
    await expect(tula.session.stepUpWithPasskey()).rejects.toMatchObject({
      code: 'auth.step_up_required',
    })
    api.on('POST /v1/client/sessions/step-up/passkey', () => json(200, {}))
    expect(await codeOf(tula.session.stepUpWithPasskey())).toBe('response.invalid')
    api.on('POST /v1/client/sessions/step-up/passkey', () => json(200, REQUEST))
    expect(await codeOf(tula.session.stepUpWithPasskey())).toBe('passkey.cancelled')
    expect(api.calls('POST /v1/client/sessions/step-up')).toEqual([])
  })
})

describe('a passkey provider: a runtime with no navigator.credentials', () => {
  /** A native passkey sheet, as far as the client sees one. */
  function sheet(overrides: Partial<PasskeyProvider> = {}) {
    const seen: { call: string; options: unknown; request: unknown }[] = []
    const provider: PasskeyProvider = {
      async create(options, request) {
        seen.push({ call: 'create', options, request })
        return REGISTRATION
      },
      async get(options, request) {
        seen.push({ call: 'get', options, request })
        return ASSERTION
      },
      ...overrides,
    }
    return { provider, seen }
  }

  test('signs in without a browser: the options go in as the API sent them and the answer goes back as it came', async () => {
    const { provider, seen } = sheet()
    const { api, tula } = world(null, provider)
    signInRoutes(api)
    expect(tula.signIn.canUsePasskey()).toBe(true)
    const signal = new AbortController().signal
    const flow = await tula.signIn.withPasskey({ signal })
    expect(flow.step.status).toBe('complete')
    expect(seen).toEqual([{ call: 'get', options: REQUEST, request: { signal } }])
    expect(api.calls(SUBMIT)[0]?.body).toEqual({ credential: ASSERTION })
  })

  test('it is asked instead of the page’s globals, never beside them', async () => {
    const globals = browser()
    const { provider, seen } = sheet()
    const { api, tula } = world(globals.globals, provider)
    signInRoutes(api)
    await tula.signIn.withPasskey()
    expect(seen).toHaveLength(1)
    expect(globals.seen.get).toEqual([])
  })

  test('a registration goes through it, with the caller’s signal', async () => {
    const { provider, seen } = sheet()
    const { api, tula } = world(null, provider)
    api.on('POST /v1/client/me/passkeys/options', () => json(200, CREATION))
    api.on('POST /v1/client/me/passkeys', () => json(201, PASSKEY))
    await tula.session.refresh()
    const signal = new AbortController().signal
    expect(await tula.user.passkeys.add({ name: 'Phone', signal })).toEqual(PASSKEY)
    expect(seen).toEqual([{ call: 'create', options: CREATION, request: { signal } }])
    expect(api.calls('POST /v1/client/me/passkeys')[0]?.body).toEqual({
      credential: REGISTRATION,
      name: 'Phone',
    })
  })

  test.each<[string, string]>([
    ['NotAllowedError', 'passkey.cancelled'],
    ['AbortError', 'passkey.cancelled'],
    ['InvalidStateError', 'passkey.already_on_device'],
    ['NotSupportedError', 'passkey.unsupported'],
    ['UserCancelled', 'passkey.failed'],
    ['', 'passkey.failed'],
  ])('a rejection named %s is %s, and nothing else of it is read', async (name, code) => {
    const fail = async () => {
      throw named(name)
    }
    const { api, tula } = world(null, sheet({ create: fail, get: fail }).provider)
    signInRoutes(api)
    const error = await tula.signIn.withPasskey().catch((caught: unknown) => caught)
    expect(isTulaError(error) && error.code).toBe(code)
    // The module's own words, which can name an account or a domain, never travel.
    expect(JSON.stringify(error)).not.toContain('the browser said something')
    expect(isTulaError(error) && error.cause).toBeFalsy()
    expect(api.calls(SUBMIT)).toEqual([])
    expect(tula.state.status).not.toBe('signed-in')
  })

  test('a provider that throws before it returns a promise is a failed ceremony, not a crash', async () => {
    const { api, tula } = world(
      null,
      sheet({
        get() {
          throw named('NotAllowedError')
        },
      }).provider
    )
    signInRoutes(api)
    expect(await codeOf(tula.signIn.withPasskey())).toBe('passkey.cancelled')
  })

  test.each<[string, unknown]>([
    ['nothing', null],
    ['a credential of another type', { ...ASSERTION, type: 'password' }],
    ['a response with a field missing', { ...ASSERTION, response: {} }],
    [
      'binary values instead of base64url',
      { ...ASSERTION, response: { clientDataJSON: new Uint8Array(2) } },
    ],
    ['a string', JSON.stringify(ASSERTION)],
  ])('an answer that is %s is passkey.failed and is never sent', async (_, answer) => {
    const { api, tula } = world(null, sheet({ get: async () => answer }).provider)
    signInRoutes(api)
    expect(await codeOf(tula.signIn.withPasskey())).toBe('passkey.failed')
    expect(api.calls(SUBMIT)).toEqual([])
  })

  test('it has no autofill unless it says so, and one that throws has none', async () => {
    expect(await world(null, sheet().provider).tula.signIn.canAutofillPasskey()).toBe(false)
    expect(
      await world(
        null,
        sheet({ autofillAvailable: () => true }).provider
      ).tula.signIn.canAutofillPasskey()
    ).toBe(true)
    expect(
      await world(
        null,
        sheet({
          autofillAvailable() {
            throw new Error('no')
          },
        }).provider
      ).tula.signIn.canAutofillPasskey()
    ).toBe(false)
  })
})
