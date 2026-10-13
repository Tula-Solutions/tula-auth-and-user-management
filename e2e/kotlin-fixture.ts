import {
  issueMockIdToken,
  type MockIdTokenClaims,
  mockOAuthProviders,
} from '../apps/api/src/adapters/oauth/mock'
import { createApp } from '../apps/api/src/index'
import * as Sms from '../apps/api/src/modules/sms/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_CONFIG,
  TEST_TENANT,
  type TestDeps,
} from '../apps/api/src/testing'
import { testRouteRefusal } from './guard'

// The server the Kotlin SDK's journeys run against (ADR 0054): the REAL API (`createApp`,
// every route and middleware) on memory adapters, over HTTP on a loopback port, because a
// JVM cannot be handed the app in process as the TypeScript suites are.
//
//   KOTLIN_FIXTURE=1 bun run e2e/kotlin-fixture.ts      (or: bun run native:kotlin:test)
//
// It serves any number of "worlds". A world is what one journey of `@tula/core`'s suite gets
// from `server()`: fresh memory stores, a clock only the test moves, one environment and a
// publishable and a secret key of its own. A world's API is under `/w/<id>`, so a journey's
// rate limits, lockouts and users are never another journey's.
//
// A world's secret key never leaves this process, as the Swift fixture's does not
// (`native/swift/fixture/server.ts`): the answer that makes a world holds its id and its
// publishable key, and a journey's admin call is relayed (`POST /__test/worlds/<id>/admin`,
// behind the guard, for a path under `/v1/admin/` and nothing else).
//
// THIS IS A TEST FIXTURE AND MUST NEVER SERVE REAL USERS. It publishes every email and text
// message (codes included) on unauthenticated routes and uses a master key that is in the
// repository. What keeps it out of production is what keeps `e2e/server.ts` out:
//   1. it refuses to start unless KOTLIN_FIXTURE=1 is set;
//   2. it lives outside `apps/api`, and `.dockerignore` excludes `e2e/`;
//   3. nothing imports it;
// and it listens on 127.0.0.1 only, with its test routes behind `e2e/guard.ts`.

if (process.env.KOTLIN_FIXTURE !== '1') {
  process.stderr.write(
    'e2e/kotlin-fixture.ts is a test fixture: it serves an API with in-memory data and exposes\n' +
      'every email and text message it "sends". Start it only for the Kotlin SDK\'s tests, with\n' +
      'KOTLIN_FIXTURE=1.\n'
  )
  process.exit(1)
}

/** One journey's server: its stores, its app and its keys. */
interface World {
  deps: TestDeps
  app: ReturnType<typeof createApp>
  /** Opens the world's admin API. Used by the relay, returned by nothing. */
  secretKey: string
}

const worlds = new Map<string, World>()

/** The most worlds kept: a run of the suite makes a few dozen, and a leak should be loud. */
const MAX_WORLDS = 2000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex')
}

/** Make a world; its keys are random and open nothing outside this process. */
/**
 * Make a world.
 *
 * Its `PUBLIC_URL` is the address the client reaches it at: a device-binding proof names the
 * request's address (`htu`), which the API compares with its own, and the mock provider's
 * pages are addresses under it.
 *
 * @param origin - The fixture's own origin.
 * @param options - `oauth`: every provider is the API's own mock (the consent page and the
 *   ID tokens a journey mints at `idtoken`).
 * @returns The world's id and publishable key, never its secret key.
 */
async function createWorld(origin: string, options: { oauth?: boolean }): Promise<Response> {
  if (worlds.size >= MAX_WORLDS) {
    return json({ error: 'too many worlds' }, 429)
  }
  const id = randomHex(8)
  const deps = createTestDeps({ config: { ...TEST_CONFIG, publicUrl: `${origin}/w/${id}` } })
  if (options.oauth === true) {
    deps.config = { ...deps.config, oauthMock: true }
    Object.assign(deps, {
      oauth: mockOAuthProviders({
        secretBox: deps.secretBox,
        clock: deps.clock,
        publicUrl: deps.config.publicUrl,
      }),
    })
  }
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  const publishableKey = `tula_pk_dev_${randomHex(16)}`
  const secretKey = `tula_sk_dev_${randomHex(16)}`
  await seedApiKey(deps, publishableKey)
  await seedApiKey(deps, secretKey)
  worlds.set(id, { deps, app: createApp(deps), secretKey })
  return json({ id, publishableKey }, 201)
}

/** The methods an admin call is made with. */
const ADMIN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Whether a path is one the relay passes on: under `/v1/admin/`, as written. A dot segment or
 * a backslash is refused instead of resolved, so what is asked for is what is called.
 */
function isAdminPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/v1/admin/') &&
    !path.includes('\\') &&
    !path.split(/[/?#]/).some((part) => part === '.' || part === '..')
  )
}

/**
 * Make an admin call as an operator's backend does, with the world's secret key, which stays
 * here. The journey says the method, the path, a body and headers of its own (an `If-Match`);
 * the credential is never the caller's.
 */
async function relayAdmin(world: World, body: Record<string, unknown>): Promise<Response> {
  const method = String(body.method ?? '')
  const headers = (body.headers ?? {}) as Record<string, unknown>
  const names = Object.keys(headers).map((name) => name.toLowerCase())
  if (!ADMIN_METHODS.has(method) || !isAdminPath(body.path) || names.includes('authorization')) {
    return json({ error: 'not an admin call the relay makes' }, 422)
  }
  if (Object.values(headers).some((value) => typeof value !== 'string')) {
    return json({ error: 'a header is a string' }, 422)
  }
  const sent = typeof body.body === 'string' ? body.body : undefined
  const answer = await world.app.request(`http://localhost:3003${body.path}`, {
    method,
    headers: {
      ...(headers as Record<string, string>),
      ...(sent === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${world.secretKey}`,
    },
    body: sent,
  })
  const etag = answer.headers.get('etag')
  return json({
    status: answer.status,
    headers: etag === null ? {} : { etag },
    body: await answer.text(),
  })
}

/** A world's test routes: what a journey reads or moves that no client or admin call can. */
async function worldRoute(world: World, route: string, request: Request): Promise<Response> {
  const { deps } = world
  const url = new URL(request.url)
  if (request.method === 'GET' && route === 'outbox') {
    // Every email "sent" to an address (all of them without `to`), oldest first.
    const to = url.searchParams.get('to')
    return json(
      deps.mailer.outbox
        .filter((message) => to === null || message.to === to)
        .map((message) => ({ to: message.to, subject: message.subject, text: message.text }))
    )
  }
  if (request.method === 'GET' && route === 'sms') {
    // A sign-in's message is sent after its request was answered: wait for it.
    await Sms.settled()
    const to = url.searchParams.get('to')
    return json(
      deps.sms.messages(to ?? undefined).map((message) => ({ to: message.to, text: message.text }))
    )
  }
  if (request.method === 'GET' && route === 'users') {
    const email = (url.searchParams.get('email') ?? '').toLowerCase()
    const user = await deps.users.findByEmail(TEST_TENANT.environmentId, email)
    return json({ exists: user !== null })
  }
  if (request.method === 'GET' && route === 'now') {
    // The world's clock is fixed: a journey that computes an authenticator's code, or signs
    // a proof with a time in it, has to know what time the server thinks it is.
    return json({ now: deps.clock.now().getTime() })
  }
  if (request.method !== 'POST') {
    return json({ error: 'no such test route' }, 404)
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (route === 'idtoken') {
    // What Google's sheet would hand an app: a token of the mock provider's, which only a
    // world made with `oauth` accepts.
    if (body.provider !== 'google' && body.provider !== 'apple') {
      return json({ error: 'no such ID-token provider' }, 422)
    }
    // The claims are sealed into the token as they are: anything but an object written out
    // by the journey is a mistake in the journey, said here and not by the mock.
    const claims = body.claims
    if (typeof claims !== 'object' || claims === null || Array.isArray(claims)) {
      return json({ error: 'claims must be an object' }, 422)
    }
    const token = await issueMockIdToken(
      deps.secretBox,
      deps.clock,
      body.provider,
      claims as MockIdTokenClaims,
      { expired: body.expired === true }
    )
    return json({ token })
  }
  if (route === 'tier') {
    if (body.tier !== 'local' && body.tier !== 'dev') {
      return json({ error: 'no such tier' }, 422)
    }
    deps.config = { ...deps.config, tier: body.tier }
    return json({ ok: true })
  }
  if (route === 'admin') {
    return relayAdmin(world, body)
  }
  if (route === 'advance') {
    const ms = Number(body.ms)
    if (!Number.isInteger(ms) || ms < 0) {
      return json({ error: 'ms must be a whole number of milliseconds' }, 422)
    }
    deps.clock.advance(ms)
    return json({ ok: true })
  }
  return json({ error: 'no such test route' }, 404)
}

const WORLD_API = /^\/w\/([0-9a-f]{16})(\/.*)$/
const WORLD_TEST = /^\/__test\/worlds\/([0-9a-f]{16})(?:\/([a-z]+))?$/

const server = Bun.serve({
  port: Number(process.env.KOTLIN_FIXTURE_PORT ?? 0),
  hostname: '127.0.0.1',
  async fetch(request): Promise<Response> {
    const url = new URL(request.url)
    const api = WORLD_API.exec(url.pathname)
    if (api) {
      const world = worlds.get(api[1] ?? '')
      if (!world) {
        return json({ error: 'no such world' }, 404)
      }
      // The world's own API, as a client and an admin call it: nothing is added or removed.
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      return world.app.request(
        new Request(`http://localhost:3003${api[2] ?? '/'}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: hasBody ? await request.arrayBuffer() : undefined,
        })
      )
    }
    if (!url.pathname.startsWith('/__test/')) {
      return json({ error: 'not found' }, 404)
    }
    const refusal = testRouteRefusal(request, `127.0.0.1:${server.port}`)
    if (refusal) {
      return json({ error: refusal }, 403)
    }
    if (url.pathname === '/__test/worlds' && request.method === 'POST') {
      const options = (await request.json().catch(() => ({}))) as { oauth?: boolean }
      return createWorld(`http://127.0.0.1:${server.port}`, options)
    }
    const test = WORLD_TEST.exec(url.pathname)
    const world = test ? worlds.get(test[1] ?? '') : undefined
    if (!test || !world) {
      return json({ error: 'no such world' }, 404)
    }
    if (test[2] === undefined) {
      if (request.method !== 'DELETE') {
        return json({ error: 'no such test route' }, 404)
      }
      worlds.delete(test[1] ?? '')
      return json({ ok: true })
    }
    return worldRoute(world, test[2], request)
  },
})

// The one line the runner reads (`scripts/kotlin-test.ts`): where the fixture listens.
process.stdout.write(`TULA_FIXTURE_URL=http://127.0.0.1:${server.port}\n`)
