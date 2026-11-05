import { describe, expect, spyOn, test } from 'bun:test'
import { createApp } from '~/index'
import * as Audit from '~/modules/audit/service'
import * as Sessions from '~/modules/session/service'
import { createTestDeps, seedApiKey, TEST_TENANT } from '~/testing'

// Two rules every client route must keep, checked against the app's own route table rather
// than a list someone has to remember to extend:
//
// (a) a `/v1/client/*` route that changes state is behind `publishableKey()`: the custom
//     header is what a cross-site form cannot send (`.claude/rules/sessions.md`, stateful sessions);
// (b) a route that accepts a credential, or does costly work for whoever asks, has a rate
//     limit of its own on top of the group's shared per-IP ceiling.
//
// Both are observed from outside: a request without a key, and the buckets a request counts in.

const PK = 'tula_pk_dev_routeguards00000000000000000000'
const SOME_ID = '00000000-0000-7000-8000-00000000cafe'
/** The shared per-IP ceiling of the whole group (`clientRateLimit`): not a route's own limit. */
const GROUP_BUCKET = 'client'

async function setup() {
  const deps = createTestDeps()
  deps.environments.add({
    id: TEST_TENANT.environmentId,
    projectId: TEST_TENANT.projectId,
    kind: 'development',
    createdAt: deps.clock.now(),
  })
  await seedApiKey(deps, PK)
  const userId = deps.ids.next()
  await deps.users.create(
    {
      id: userId,
      projectId: TEST_TENANT.projectId,
      environmentId: TEST_TENANT.environmentId,
      email: 'maya@northline.app',
      emailNormalized: 'maya@northline.app',
      emailVerifiedAt: deps.clock.now(),
      firstName: null,
      lastName: null,
      createdAt: deps.clock.now(),
      identityId: deps.ids.next(),
      credentialId: deps.ids.next(),
      passwordHash: null,
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
  return {
    deps,
    app: createApp(deps),
    accessToken: session.accessToken as string,
    refreshToken: session.refreshToken as string,
  }
}

/** Every `/v1/client/*` route that is not a read, from the app itself. */
function writes(app: ReturnType<typeof createApp>): Array<{ method: string; path: string }> {
  const seen = new Map<string, { method: string; path: string }>()
  for (const route of app.routes) {
    if (
      route.path.startsWith('/v1/client/') &&
      !route.path.includes('*') &&
      !['ALL', 'GET', 'HEAD', 'OPTIONS'].includes(route.method)
    ) {
      seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path })
    }
  }
  return [...seen.values()]
}

const concrete = (path: string) =>
  path.replace(/:provider\b/, 'google').replace(/:[A-Za-z]+/g, SOME_ID)
const named = ({ method, path }: { method: string; path: string }) => `${method} ${path}`

/**
 * Writes that have no rate limit of their own, each with the reason that is acceptable. A new
 * route does not belong here because it is inconvenient to limit: it belongs here only when
 * nothing guessable, costly or countable sits behind it.
 */
const NO_OWN_LIMIT: Record<string, string> = {
  'POST /v1/client/sessions/sign-out':
    'ends the session a refresh token or session cookie names: 256 random bits, so nothing can ' +
    'be guessed, and the only effect is the caller’s own sign-out. It must also keep working ' +
    'when a limiter is saturated: a user who cannot sign out stays signed in.',
  'POST /v1/client/sessions/revoke-others':
    'authenticated by the caller’s access token and takes no credential or body; it ends ' +
    'sessions of the caller alone and is idempotent, so repeating it gains nothing.',
  'DELETE /v1/client/sessions/:sessionId':
    'authenticated by the caller’s access token and takes no credential; the id is a UUID of ' +
    'the caller’s own sessions (another user’s is the same 404), so nothing is guessable.',
}

/**
 * Routes whose limiter is chosen from the validated body, so an empty body never reaches it:
 * every listed body must count in a bucket of the route's own.
 */
const BODIES: Record<string, unknown[]> = {
  'POST /v1/client/sign-ins/:attemptId/first-factor/attempt': [
    { strategy: 'email_code', code: '123456' },
    { strategy: 'email_link' },
  ],
}

/** A bucket of a per-IP `rateLimit()` middleware other than the group's: `<name>:ip:<bucket>`. */
const OWN_BUCKET = /^(?!client:)[a-z0-9_]+:ip:/

describe('the client routes that change state', async () => {
  const { app } = await setup()
  const routes = writes(app)

  test('the walk finds them, in every family', () => {
    expect(routes.length).toBeGreaterThanOrEqual(40)
    const families = new Set(routes.map(({ path }) => path.split('/')[3]))
    for (const family of ['sign-ups', 'sign-ins', 'password-resets', 'sessions', 'me']) {
      expect(families.has(family), family).toBe(true)
    }
  })

  test('each is behind publishableKey(): without the key it answers auth.invalid_key and nothing else runs', async () => {
    const { app: fresh, accessToken } = await setup()
    const open: string[] = []
    for (const route of routes) {
      const res = await fresh.request(concrete(route.path), {
        method: route.method,
        // Everything else a real request has, so that only the key is missing.
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          'x-tula-client': 'ios',
        },
        body: '{}',
      })
      const body = (await res.json().catch(() => null)) as { code?: string } | null
      if (res.status !== 401 || body?.code !== 'auth.invalid_key') {
        open.push(`${named(route)} → ${res.status} ${body?.code}`)
      }
    }
    expect(open).toEqual([])
  })

  test('each has a rate limit of its own, beyond the group’s shared ceiling', async () => {
    const { deps, app: fresh, accessToken } = await setup()
    const unlimited: string[] = []
    for (const route of routes) {
      for (const body of BODIES[named(route)] ?? [{}]) {
        const hit = spyOn(deps.rateLimiter, 'hit')
        await fresh.request(concrete(route.path), {
          method: route.method,
          headers: {
            'content-type': 'application/json',
            'x-tula-publishable-key': PK,
            authorization: `Bearer ${accessToken}`,
            'x-tula-client': 'ios',
            'x-tula-attempt': 'tula_at_none',
          },
          body: JSON.stringify(body),
        })
        const keys = hit.mock.calls.map(([key]) => key)
        hit.mockRestore()
        // The group's ceiling is in front of every one of them.
        expect(
          keys.some((key) => key.startsWith(`${GROUP_BUCKET}:ip:`)),
          named(route)
        ).toBe(true)
        if (!keys.some((key) => OWN_BUCKET.test(key))) {
          unlimited.push(named(route))
        }
      }
    }
    expect([...new Set(unlimited)].sort()).toEqual(Object.keys(NO_OWN_LIMIT).sort())
    // An entry of either table that names no route is a table gone stale.
    const names = new Set(routes.map(named))
    for (const name of [...Object.keys(NO_OWN_LIMIT), ...Object.keys(BODIES)]) {
      expect(names.has(name), name).toBe(true)
    }
    for (const reason of Object.values(NO_OWN_LIMIT)) {
      expect(reason.length).toBeGreaterThan(40)
    }
  })
})

describe('an SSO connection’s callback', () => {
  test('is limited per IP and per connection, before anything is looked up', async () => {
    const { deps, app } = await setup()
    const hit = spyOn(deps.rateLimiter, 'hit')
    const found = spyOn(deps.flowAttempts, 'findById')
    const response = await app.request(`/v1/sso/callback/${SOME_ID}?state=x&code=y`)
    const keys = hit.mock.calls.map(([key]) => key)
    hit.mockRestore()
    expect(response.status).toBe(400)
    expect(keys.some((key) => key.startsWith('sso_callback:ip:'))).toBe(true)
    expect(keys).toContain(`sso_callback_connection:${SOME_ID}`)
    // A state of the wrong shape is refused before any attempt is read.
    expect(found).not.toHaveBeenCalled()
    found.mockRestore()
  })
})

/**
 * The end-user routes that change who can sign in as the user, or hand someone a way in. Each
 * is behind `requireRecentAuth()` (`.claude/rules/mfa.md`); a route that drops it must fail here.
 */
const STEP_UP_ROUTES: Array<[method: string, path: string]> = [
  ['POST', '/v1/client/me/email'],
  ['POST', '/v1/client/me/email/verify'],
  ['POST', '/v1/client/me/factors/totp'],
  ['POST', '/v1/client/me/factors/totp/confirm'],
  ['DELETE', '/v1/client/me/factors/totp'],
  ['POST', '/v1/client/me/factors/sms'],
  ['POST', '/v1/client/me/factors/sms/confirm'],
  ['DELETE', '/v1/client/me/factors/sms'],
  ['POST', '/v1/client/me/factors/backup-codes'],
  ['POST', '/v1/client/me/identities/oauth'],
  ['DELETE', `/v1/client/me/identities/${SOME_ID}`],
  ['POST', '/v1/client/me/passkeys/options'],
  ['POST', '/v1/client/me/passkeys'],
  ['PATCH', `/v1/client/me/passkeys/${SOME_ID}`],
  ['DELETE', `/v1/client/me/passkeys/${SOME_ID}`],
  ['POST', '/v1/client/me/phone'],
  ['POST', '/v1/client/me/phone/verify'],
  ['DELETE', '/v1/client/me/phone'],
  ['DELETE', `/v1/client/me/organizations/${SOME_ID}`],
  ['POST', `/v1/client/me/organizations/${SOME_ID}/setup-links`],
  ['DELETE', `/v1/client/me/organizations/${SOME_ID}/setup-links/${SOME_ID}`],
]

describe('the end-user routes that need a recent authentication (H-138)', () => {
  test('a session whose sign-in is older than the window is asked to step up on each', async () => {
    const { deps, app, refreshToken } = await setup()
    deps.clock.advance('11m')
    // A refresh does not renew `auth_time`, so this token is valid and stale.
    const stale = (await Sessions.refresh(deps, TEST_TENANT, refreshToken)).accessToken as string
    const unguarded: string[] = []
    for (const [method, path] of STEP_UP_ROUTES) {
      const res = await app.request(path, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${stale}`,
          'x-tula-publishable-key': PK,
          'x-tula-client': 'ios',
        },
        body: '{}',
      })
      const body = (await res.json().catch(() => null)) as { code?: string } | null
      if (res.status !== 403 || body?.code !== 'auth.step_up_required') {
        unguarded.push(`${method} ${path} → ${res.status} ${body?.code}`)
      }
    }
    expect(unguarded).toEqual([])
  })
})
