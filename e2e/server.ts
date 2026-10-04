import { join, normalize } from 'node:path'
import { FixedClock } from '../apps/api/src/adapters/memory/clock'
import { MemoryRateLimiter } from '../apps/api/src/adapters/memory/rate-limiter'
import { mockOAuthProviders } from '../apps/api/src/adapters/oauth/mock'
import { createApp, MAX_BODY_BYTES } from '../apps/api/src/index'
import * as Jwks from '../apps/api/src/modules/jwks/service'
import * as OAuth from '../apps/api/src/modules/oauth/service'
import type { RateLimiter } from '../apps/api/src/ports/rate-limiter'
import { createTestDeps, seedApiKey, TEST_CONFIG, TEST_TENANT } from '../apps/api/src/testing'
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  EnvironmentSettingsSchema,
} from '../packages/contract/src/index'
import { testRouteRefusal } from './guard'

// The server the browser tests run against: the REAL API (`createApp`, every route and
// middleware) on memory adapters, plus the built example app, on two local ports. Nothing is
// mocked; the only differences from production are where data lives (memory) and where email
// goes (an outbox the tests read).
//
//   E2E=1 bun run e2e/server.ts
//
// THIS IS A TEST FIXTURE AND MUST NEVER SERVE REAL USERS. It publishes every email (codes
// included) on an unauthenticated endpoint and uses a master key that is in the repository.
// Three things keep it out of production:
//   1. it refuses to start unless E2E=1 is set;
//   2. it lives outside `apps/api`, so the API image (which copies `apps/api` and the packages
//      it imports, see apps/api/Dockerfile) never contains it, and `.dockerignore` excludes
//      `e2e/` from the build context as well;
//   3. nothing imports it: `apps/api/src/server.ts` builds its app from `createContainer(env)`
//      and has no code path to memory adapters or to these routes.

if (process.env.E2E !== '1') {
  process.stderr.write(
    'e2e/server.ts is a test fixture: it serves an API with in-memory data and exposes every\n' +
      'email it "sends". Start it only for browser tests, with E2E=1.\n'
  )
  process.exit(1)
}

/** Fixed ports: the API's allowed origins and the app's API URL are decided by them. */
export const API_PORT = 4318
export const APP_PORT = 4317
/** A fixed, fake key for the memory environment. It opens nothing outside this process. */
export const PUBLISHABLE_KEY = 'tula_pk_dev_e2e000000000000000000000000000000'

/**
 * The wall clock: browsers keep real time, so tokens and cookies must expire by it. A test can
 * move it forward (`/__test/advance-clock`) to make a sign-in old enough to need a step-up
 * without waiting ten minutes; it never moves back.
 */
class WallClock extends FixedClock {
  #aheadMs = 0
  override now(): Date {
    return new Date(Date.now() + this.#aheadMs)
  }
  forward(ms: number): void {
    this.#aheadMs += Math.max(0, ms)
  }
}

/** A rate limiter the tests can empty between scenarios (they all come from one address). */
class ResettableRateLimiter implements RateLimiter {
  #current: MemoryRateLimiter
  constructor(private readonly clock: FixedClock) {
    this.#current = new MemoryRateLimiter(clock)
  }
  hit(key: string, limit: number, windowMs: number) {
    return this.#current.hit(key, limit, windowMs)
  }
  reset(): void {
    this.#current = new MemoryRateLimiter(this.clock)
  }
}

const clock = new WallClock()
const rateLimiter = new ResettableRateLimiter(clock)
const deps = createTestDeps({
  clock,
  rateLimiter: rateLimiter as unknown as MemoryRateLimiter,
  // OAuth runs against the API's own mock provider (ADR 0026), as a local deployment with
  // `OAUTH_MOCK_PROVIDER=true` does: the real callback, ticket and exchange, and a consent page
  // the tests fill in.
  config: { ...TEST_CONFIG, publicUrl: `http://localhost:${API_PORT}`, oauthMock: true },
})
Object.assign(deps, {
  oauth: mockOAuthProviders({
    secretBox: deps.secretBox,
    clock,
    publicUrl: `http://localhost:${API_PORT}`,
  }),
})
deps.environments.add({
  id: TEST_TENANT.environmentId,
  projectId: TEST_TENANT.projectId,
  kind: 'development',
  createdAt: clock.now(),
})
await seedApiKey(deps, PUBLISHABLE_KEY)
await Jwks.ensureAllEnvironments(deps)
const app = createApp(deps)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/** Every settings change the tests make gets the next revision, as a real replace would. */
let settingsRevision = 0

/**
 * Replace the environment's settings with the defaults plus what a test asks for (which
 * sign-in methods are on, whether a sign-up needs a password). `{}` puts the defaults back.
 * The document is validated exactly as `PUT /v1/admin/settings` validates one.
 */
async function replaceSettings(request: Request): Promise<Response> {
  const parsed = EnvironmentSettingsSchema.safeParse({
    ...DEFAULT_ENVIRONMENT_SETTINGS,
    ...((await request.json()) as object),
  })
  if (!parsed.success) {
    return json({ error: 'not a settings document' }, 422)
  }
  settingsRevision += 1
  deps.environmentSettings.seed(TEST_TENANT.environmentId, {
    revision: settingsRevision,
    settings: parsed.data,
  })
  return json({ ok: true })
}

/** Test-only routes, next to the API's own. Reached by the test runner, never by the page. */
/**
 * Create an account whose address was never verified, as an administrator can
 * (`POST /v1/admin/users`): what an OAuth sign-in must never be linked into.
 */
async function createUnverifiedUser(body: unknown): Promise<Response> {
  const email = String((body as { email?: unknown }).email ?? '')
  const now = clock.now()
  const created = await deps.users.create({
    id: deps.ids.next(),
    projectId: TEST_TENANT.projectId,
    environmentId: TEST_TENANT.environmentId,
    email,
    emailNormalized: email.toLowerCase(),
    emailVerifiedAt: null,
    firstName: null,
    lastName: null,
    createdAt: now,
    identityId: deps.ids.next(),
    credentialId: deps.ids.next(),
    passwordHash: null,
  })
  return json({ ok: created }, created ? 200 : 409)
}

/**
 * A P-256 private key in PKCS#8 PEM, as Apple's `.p8` file holds one: what configuring Sign in
 * with Apple asks for. Made when the fixture starts and kept in memory only; no key is ever
 * committed, and this one signs nothing a real provider would accept.
 */
async function throwawayAppleKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const lines = der.toString('base64').match(/.{1,64}/g) ?? []
  return ['-----BEGIN PRIVATE KEY-----', ...lines, '-----END PRIVATE KEY-----', ''].join('\n')
}
const APPLE_KEY = await throwawayAppleKey()

/** Enable exactly the named OAuth providers for the environment (none by default). */
async function enableProviders(body: unknown): Promise<Response> {
  const wanted = (body as { providers?: unknown }).providers
  if (!Array.isArray(wanted)) {
    return json({ error: 'providers must be a list' }, 422)
  }
  const tenant = { projectId: TEST_TENANT.projectId, environmentId: TEST_TENANT.environmentId }
  const actor = { type: 'system', id: null, ipAddress: null, userAgent: null } as const
  for (const provider of ['google', 'github', 'apple'] as const) {
    if (wanted.includes(provider)) {
      await OAuth.update(
        deps,
        tenant,
        provider,
        provider === 'apple'
          ? {
              clientId: 'e2e.apple.services-id',
              teamId: 'E2ETEAM000',
              keyId: 'E2EKEY0000',
              privateKey: APPLE_KEY,
              enabled: true,
            }
          : { clientId: `e2e-${provider}`, clientSecret: 'e2e-client-secret', enabled: true },
        actor
      )
    } else if (await deps.oauthProviders.find(tenant.environmentId, provider)) {
      await deps.oauthProviders.delete(tenant.environmentId, provider)
    }
  }
  return json({ ok: true })
}

function testRoute(request: Request): Response | Promise<Response> | null {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/__test/')) {
    return null
  }
  // Only the test process asks: never a page, not even one rebound onto this port.
  const refusal = testRouteRefusal(request, `localhost:${API_PORT}`)
  if (refusal !== null) {
    return json({ error: refusal }, 403)
  }
  if (request.method === 'GET' && url.pathname === '/__test/outbox') {
    const to = url.searchParams.get('to')
    const messages = deps.mailer.outbox
      .filter((message) => to === null || message.to === to)
      .map(({ to: recipient, subject, text }) => ({ to: recipient, subject, text }))
    return json({ data: messages })
  }
  if (request.method === 'POST' && url.pathname === '/__test/reset-limits') {
    rateLimiter.reset()
    return json({ ok: true })
  }
  if (request.method === 'POST' && url.pathname === '/__test/settings') {
    return replaceSettings(request)
  }
  if (request.method === 'POST' && url.pathname === '/__test/unverified-user') {
    return request.json().then(createUnverifiedUser)
  }
  if (request.method === 'POST' && url.pathname === '/__test/oauth') {
    return request.json().then(enableProviders)
  }
  if (request.method === 'GET' && url.pathname === '/__test/now') {
    // What the API takes the time to be: an authenticator code is computed from it.
    return json({ now: clock.now().getTime() })
  }
  if (request.method === 'POST' && url.pathname === '/__test/advance-clock') {
    return request.json().then((body) => {
      const ms = Number((body as { ms?: unknown }).ms)
      if (!Number.isFinite(ms) || ms < 0 || ms > 86_400_000) {
        return json({ error: 'ms must be between 0 and one day' }, 422)
      }
      clock.forward(ms)
      return json({ now: clock.now().getTime() })
    })
  }
  return json({ error: 'unknown test route' }, 404)
}

const api = Bun.serve({
  port: API_PORT,
  hostname: 'localhost',
  maxRequestBodySize: MAX_BODY_BYTES,
  fetch: (request, server) => testRoute(request) ?? app.fetch(request, server),
})

const dist = join(import.meta.dir, '..', 'examples', 'react-vite', 'dist')

const web = Bun.serve({
  port: APP_PORT,
  hostname: 'localhost',
  async fetch(request) {
    const { pathname } = new URL(request.url)
    const path = normalize(join(dist, pathname))
    // A single-page app: a file when the path names one inside dist, the page otherwise.
    const file = path.startsWith(dist) && pathname !== '/' ? Bun.file(path) : null
    const found = file && (await file.exists()) ? file : Bun.file(join(dist, 'index.html'))
    if (!(await found.exists())) {
      return new Response(
        'Build the example first: bun run --filter @tula/example-react-vite build',
        {
          status: 500,
        }
      )
    }
    return new Response(found, { headers: { 'cache-control': 'no-store' } })
  },
})

process.stdout.write(
  `e2e: API on ${api.url.origin} (memory adapters), example app on ${web.url.origin}\n`
)
