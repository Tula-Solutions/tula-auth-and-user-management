import { expect, test } from 'bun:test'
import { createApp } from '~/index'
import { createInstanceTestDeps } from '~/testing'

// The control plane's tables have no tenant columns and no row-level security (H-245): who may
// read or write them is decided only by `instanceAdmin()` on the router. This walks the app's
// own route table, so a new `/v1/instance/*` route that forgets the guard fails here.

/** Routes that are not behind `instanceAdmin()` on purpose, with the reason. */
const UNGUARDED = new Set([
  // The sign-in itself: it takes the admin token in the body and is guarded by its own
  // origin check and rate limit.
  'POST /v1/instance/session',
])

test('every /v1/instance route refuses a request with no credential', async () => {
  const app = createApp(createInstanceTestDeps())
  const checked = new Set<string>()
  for (const route of app.routes) {
    const key = `${route.method} ${route.path}`
    if (!route.path.startsWith('/v1/instance') || route.path.includes('*') || checked.has(key)) {
      continue
    }
    checked.add(key)
    if (UNGUARDED.has(key)) {
      continue
    }
    const res = await app.request(route.path.replace(/:[A-Za-z]+/g, 'x'), {
      method: route.method,
    })
    expect({ key, status: res.status }).toEqual({ key, status: 401 })
  }
  expect(checked.size).toBeGreaterThan(8)
})
