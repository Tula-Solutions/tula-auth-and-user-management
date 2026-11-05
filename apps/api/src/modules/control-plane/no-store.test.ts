import { describe, expect, test } from 'bun:test'
import { createApp } from '~/index'
import { createInstanceTestDeps, dashboardHeaders, dashboardSignIn } from '~/testing'

describe('the control plane lists (H-193)', () => {
  test.each(['/workspaces', '/projects', '/environments'])(
    'GET %s is never stored by a cache',
    async (path) => {
      const app = createApp(createInstanceTestDeps())
      const cookie = await dashboardSignIn(app)
      const res = await app.request(`/v1/instance${path}`, { headers: dashboardHeaders(cookie) })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  )
})
