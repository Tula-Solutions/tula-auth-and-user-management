import { createApp } from '../apps/api/src/index'
import * as Audit from '../apps/api/src/modules/audit/service'
import * as Sms from '../apps/api/src/modules/sms/service'
import { createTestDeps, seedApiKey, TEST_TENANT, type TestDeps } from '../apps/api/src/testing'
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
async function createWorld(): Promise<Response> {
  if (worlds.size >= MAX_WORLDS) {
    return json({ error: 'too many worlds' }, 429)
  }
  const deps = createTestDeps()
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
  const id = randomHex(8)
  worlds.set(id, { deps, app: createApp(deps) })
  return json({ id, publishableKey, secretKey }, 201)
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
  if (request.method !== 'POST') {
    return json({ error: 'no such test route' }, 404)
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  if (route === 'advance') {
    const ms = Number(body.ms)
    if (!Number.isInteger(ms) || ms < 0) {
      return json({ error: 'ms must be a whole number of milliseconds' }, 422)
    }
    deps.clock.advance(ms)
    return json({ ok: true })
  }
  if (route === 'phone') {
    // Give an account a proven phone number, as confirming a texted code does. The Kotlin
    // client has no call for that yet, and a sign-in with a texted code needs such an account.
    const email = String(body.email ?? '').toLowerCase()
    const user = await deps.users.findByEmail(TEST_TENANT.environmentId, email)
    if (!user) {
      return json({ error: 'no such user' }, 404)
    }
    const updated = await deps.users.setPhoneNumber(
      TEST_TENANT.environmentId,
      user.id,
      String(body.phoneNumber ?? ''),
      deps.clock.now(),
      Audit.none('fixture'),
      Audit.none('fixture')
    )
    return json({ ok: updated !== null }, updated ? 200 : 404)
  }
  return json({ error: 'no such test route' }, 404)
}

const WORLD_API = /^\/w\/([0-9a-f]{16})(\/.*)$/
const WORLD_TEST = /^\/__test\/worlds\/([0-9a-f]{16})(?:\/([a-z]+))?$/

const server = Bun.serve({
  port: Number(process.env.KOTLIN_FIXTURE_PORT ?? 0),
  hostname: '127.0.0.1',
  async fetch(request) {
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
      return createWorld()
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
