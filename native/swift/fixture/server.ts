import {
  issueMockIdToken,
  type MockIdTokenClaims,
  mockOAuthProviders,
} from '../../../apps/api/src/adapters/oauth/mock'
import { createApp, MAX_BODY_BYTES } from '../../../apps/api/src/index'
import * as Hooks from '../../../apps/api/src/modules/hook/service'
import * as Sms from '../../../apps/api/src/modules/sms/service'
import {
  createTestDeps,
  seedApiKey,
  TEST_ACTOR,
  TEST_CONFIG,
  TEST_TENANT,
  type TestDeps,
} from '../../../apps/api/src/testing'
import { testRouteRefusal } from '../../../e2e/guard'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsSchema,
} from '../../../packages/contract/src/index'

// The server the Swift client's journey tests run against (native/swift/Tests/
// TulaAuthJourneyTests): the REAL API (`createApp`, every route and middleware) on memory
// adapters, one fresh instance per test, each under its own path of one loopback port.
// Nothing of the API is mocked. It is what `server()` is in
// apps/api/src/testing/sdk-journeys.ts, reached over HTTP because a Swift process cannot
// call the API in process.
//
//   TULA_NATIVE_FIXTURE=1 bun run native/swift/fixture/server.ts
//
// The Swift tests start it themselves, with `LOG_LEVEL=silent` (as the API is under
// `bun test`), and it ends when they do (its standard input closes).
//
// THIS IS A TEST FIXTURE AND MUST NEVER SERVE REAL USERS. It publishes every email and every
// text message (codes included), moves its clock on request and relays requests under a secret key. What keeps it
// out of production:
//   1. it refuses to start unless TULA_NATIVE_FIXTURE=1 is set;
//   2. it listens on 127.0.0.1 only, on a port the system picks;
//   3. its test routes go through `e2e/guard.ts` (no `Origin`, the exact `Host`, no
//      cross-site `Sec-Fetch-Site`);
//   4. it lives outside `apps/api`, so the API image never contains it, and `.dockerignore`
//      excludes `native/` from the build context as well;
//   5. nothing imports it.

if (process.env.TULA_NATIVE_FIXTURE !== '1') {
  process.stderr.write(
    'native/swift/fixture/server.ts is a test fixture: it serves an API with in-memory data\n' +
      'and exposes every email it "sends". Start it only for the Swift journey tests, with\n' +
      'TULA_NATIVE_FIXTURE=1.\n'
  )
  process.exit(1)
}

/** A fixed, fake key for the memory environments. It opens nothing outside this process. */
const PUBLISHABLE_KEY = 'tula_pk_dev_swiftjourneys0000000000000000000'
/** The secret key of this run. It never leaves this process: admin requests are relayed. */
const SECRET_KEY = `tula_sk_dev_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')}`

/** One exchange a client made with one of the servers. */
interface Recorded {
  method: string
  path: string
  status: number
  headers: Record<string, string>
  requestBody: string
  responseBody: string
}

/** How a hook's receiver answers; `null` never answers. */
type HookAnswer = { status?: number; body: unknown } | null

interface Receiver {
  asked: number
  answer: HookAnswer
  stop: () => Promise<void>
}

/** One API in memory: what one journey runs against. */
interface World {
  deps: TestDeps
  app: ReturnType<typeof createApp>
  exchanges: Recorded[]
  receivers: Receiver[]
  revision: number
}

const worlds = new Map<string, World>()
let created = 0

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

/**
 * Make one API in memory.
 *
 * @param origin - This fixture's own origin.
 * @param options - `oauth`: every provider is the API's own mock provider (the consent page
 *   and the ID-token mint under `/v1/dev/oauth`), as `oauthServer()` of the JS journeys. The
 *   mock's own gates stay as they are: the `local` tier, a loopback `Host`.
 * @returns The world's id, its address and the time its clock shows, in milliseconds.
 */
async function createWorld(
  origin: string,
  options: { oauth?: boolean }
): Promise<{ id: string; baseUrl: string; now: number }> {
  created += 1
  const id = `w${created}`
  const baseUrl = `${origin}/s/${id}`
  const deps = createTestDeps({ config: { ...TEST_CONFIG, publicUrl: baseUrl } })
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
  await seedApiKey(deps, PUBLISHABLE_KEY)
  await seedApiKey(deps, SECRET_KEY)
  worlds.set(id, { deps, app: createApp(deps), exchanges: [], receivers: [], revision: 0 })
  return { id, baseUrl, now: deps.clock.now().getTime() }
}

async function removeWorld(id: string): Promise<void> {
  const world = worlds.get(id)
  worlds.delete(id)
  await Promise.all((world?.receivers ?? []).map((receiver) => receiver.stop()))
}

/** The operator's endpoint of a hook: a listener in this process, on the loopback address. */
async function addHook(
  world: World,
  input: { point: 'before_sign_up' | 'before_session' | 'before_token'; deadlineMs: number },
  answer: HookAnswer
): Promise<number> {
  const receiver: Receiver = { asked: 0, answer, stop: async () => undefined }
  const endpoint = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      receiver.asked += 1
      const { answer: now } = receiver
      return now === null
        ? new Promise<Response>(() => undefined)
        : new Response(JSON.stringify(now.body), {
            status: now.status ?? 200,
            headers: { 'content-type': 'application/json' },
          })
    },
  })
  receiver.stop = () => endpoint.stop(true)
  world.receivers.push(receiver)
  await Hooks.create(
    world.deps,
    { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId },
    {
      point: input.point,
      url: `http://127.0.0.1:${endpoint.port}/${input.point}`,
      enabled: true,
      deadlineMs: input.deadlineMs,
      failureMode: 'deny',
    },
    TEST_ACTOR
  )
  return world.receivers.length - 1
}

/** A request of the test process about one world: what `Server` offers a JS journey. */
async function control(request: Request, world: World, action: string): Promise<Response> {
  const url = new URL(request.url)
  const body = request.method === 'GET' ? {} : ((await request.json()) as Record<string, unknown>)
  switch (`${request.method} ${action}`) {
    case 'GET emails': {
      const to = url.searchParams.get('to')
      return json(
        world.deps.mailer.outbox
          .filter((sent) => to === null || sent.to === to)
          .map((sent) => ({ to: sent.to, subject: sent.subject, text: sent.text }))
      )
    }
    case 'GET sms': {
      // The text messages the API "sent" (the memory sender's outbox), as the emails above.
      // A sign-in's message is handed to the sender after its request was answered, and its
      // code's token is stored after that: the answer waits for that work, so that a code it
      // shows is one that can be used, and a count it shows is whole (what `Sms.settled()`
      // is to a JS journey, and what `/__test/sms` of e2e/server.ts does).
      await Sms.settled()
      const to = url.searchParams.get('to')
      return json(
        world.deps.sms.messages(to ?? undefined).map((sent) => ({ to: sent.to, text: sent.text }))
      )
    }
    case 'GET exchanges':
      return json(world.exchanges)
    case 'GET hooks':
      return json(world.receivers.map((receiver) => receiver.asked))
    case 'GET users': {
      const user = await world.deps.users.findByEmail(
        TEST_TENANT.environmentId,
        url.searchParams.get('email') ?? ''
      )
      return json({ exists: user !== null })
    }
    case 'GET now':
      return json({ now: world.deps.clock.now().getTime() })
    case 'POST tier':
      // The deployment tier, for a journey of what holds outside `local` (a loopback page
      // must then be listed like any other redirect URL). Read on every request.
      if (body.tier !== 'local' && body.tier !== 'dev') {
        return json({ error: 'no such tier' }, 400)
      }
      world.deps.config = { ...world.deps.config, tier: body.tier }
      return json({})
    case 'POST id-token': {
      // An ID token of the mock provider, as Google's SDK or Apple's sheet would hand an
      // app one: what `issueMockIdToken` is to a JS journey. Sealed by this world's own
      // secret box, so it is a token of this world's mock provider and of nothing else.
      if (body.provider !== 'google' && body.provider !== 'apple') {
        return json({ error: 'no such ID-token provider' }, 400)
      }
      const token = await issueMockIdToken(
        world.deps.secretBox,
        world.deps.clock,
        body.provider,
        body.claims as MockIdTokenClaims,
        { expired: body.expired === true }
      )
      return json({ token })
    }
    case 'POST advance':
      world.deps.clock.advance(Number(body.ms))
      return json({})
    case 'POST settings': {
      // What `configure` does in the JS journeys: the settings as an operator saved them,
      // without the admin API's own rules for a change standing between a test and its setup.
      world.revision += 1
      world.deps.environmentSettings.seed(TEST_TENANT.environmentId, {
        revision: world.revision,
        settings: EnvironmentSettingsSchema.parse({
          ...DEFAULT_ENVIRONMENT_SETTINGS,
          ...(body.settings as Record<string, unknown>),
        }),
      })
      return json({})
    }
    case 'POST hooks':
      return json({
        index: await addHook(
          world,
          body as { point: 'before_sign_up'; deadlineMs: number },
          (body.answer ?? null) as HookAnswer
        ),
      })
    case 'PUT hooks': {
      const receiver = world.receivers[Number(body.index)]
      if (!receiver) {
        return json({ error: 'no such hook' }, 404)
      }
      receiver.answer = (body.answer ?? null) as HookAnswer
      return json({})
    }
    case 'POST admin': {
      // As an operator's backend does, with the run's secret key, which stays here.
      const sent = body.body === undefined ? undefined : JSON.stringify(body.body)
      const answer = await world.app.request(String(body.path), {
        method: String(body.method),
        headers: {
          authorization: `Bearer ${SECRET_KEY}`,
          ...(sent === undefined ? {} : { 'content-type': 'application/json' }),
          ...((body.headers ?? {}) as Record<string, string>),
        },
        body: sent,
      })
      return json({
        status: answer.status,
        etag: answer.headers.get('etag'),
        body: await answer.text(),
      })
    }
    default:
      return json({ error: 'no such test route' }, 404)
  }
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  maxRequestBodySize: MAX_BODY_BYTES,
  async fetch(request, bun) {
    const url = new URL(request.url)
    const origin = `http://127.0.0.1:${bun.port}`
    if (url.pathname.startsWith('/__test/')) {
      const refusal = testRouteRefusal(request, `127.0.0.1:${bun.port}`)
      if (refusal !== null) {
        return json({ error: refusal }, 403)
      }
      const [, , resource, id, action] = url.pathname.split('/')
      if (resource !== 'servers') {
        return json({ error: 'no such test route' }, 404)
      }
      if (id === undefined && request.method === 'POST') {
        const options = (await request.json().catch(() => ({}))) as { oauth?: boolean }
        return json({ ...(await createWorld(origin, options)), publishableKey: PUBLISHABLE_KEY })
      }
      const world = worlds.get(id ?? '')
      if (!world) {
        return json({ error: 'no such server' }, 404)
      }
      if (action === undefined && request.method === 'DELETE') {
        await removeWorld(id as string)
        return json({})
      }
      return control(request, world, action ?? '')
    }

    // Everything else is the API of one world, under its own path.
    const match = /^\/s\/(w[0-9]+)(\/.*)$/.exec(url.pathname)
    const world = worlds.get(match?.[1] ?? '')
    if (!match || !world) {
      return json({ error: 'no such server' }, 404)
    }
    const requestBody = await request.text()
    const response = await world.app.fetch(
      new Request(`${origin}${match[2]}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: requestBody === '' ? undefined : requestBody,
      }),
      bun
    )
    world.exchanges.push({
      method: request.method,
      path: match[2] as string,
      status: response.status,
      headers: Object.fromEntries(request.headers),
      requestBody,
      responseBody: await response.clone().text(),
    })
    return response
  },
})

// The one line the test process waits for.
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`)

// The test process holds this end open for as long as it lives, however it ends.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.resume()
