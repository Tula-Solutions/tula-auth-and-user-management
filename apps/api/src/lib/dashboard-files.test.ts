import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '~/index'
import { DASHBOARD_CSP, findDashboardDir, resolveDashboardFile } from '~/lib/dashboard-files'
import { createTestDeps, TEST_CONFIG } from '~/testing'

const INDEX = '<!doctype html><title>Tula</title><div id="root"></div>'
const SECRET = 'TOP-SECRET-OUTSIDE-THE-ROOT'

let base: string
let root: string
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'tula-dashboard-')))
  root = join(base, 'dist')
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, '.well-known'), { recursive: true })
  await writeFile(join(root, 'index.html'), INDEX)
  await writeFile(join(root, 'assets', 'index-D4f8a1c2.js'), 'console.log(1)')
  await writeFile(join(root, 'assets', 'index-9b7e.css'), 'body{}')
  await writeFile(join(root, 'assets', 'font-a1b2.woff2'), 'woff')
  await writeFile(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(root, 'robots.txt'), 'User-agent: *')
  await writeFile(join(root, 'data.unknownext'), 'x')
  await writeFile(join(root, '.env'), SECRET)
  await writeFile(join(root, '.well-known', 'thing'), SECRET)
  // Outside the root: what a traversal would be after.
  await writeFile(join(base, 'secret.txt'), SECRET)
  await mkdir(join(base, 'dist-private'))
  await writeFile(join(base, 'dist-private', 'secret.txt'), SECRET)
  // Links that leave the root.
  await symlink(join(base, 'secret.txt'), join(root, 'assets', 'linked.txt'))
  await symlink(base, join(root, 'up'))
  app = createApp(createTestDeps({ config: { ...TEST_CONFIG, dashboardDir: root } }))
})

afterAll(() => rm(base, { recursive: true, force: true }))

describe('GET /dashboard', () => {
  test('without a build directory there is no dashboard: the API’s own 404', async () => {
    const bare = createApp(createTestDeps())
    const unknown = await bare.request('/nothing-here')
    for (const path of [
      '/dashboard',
      '/dashboard/',
      '/dashboard/users',
      '/dashboard/assets/a.js',
    ]) {
      const res = await bare.request(path)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual(await unknown.clone().json())
    }
  })

  test('/dashboard redirects to /dashboard/, which is the app', async () => {
    const bare = await app.request('/dashboard')
    expect(bare.status).toBe(308)
    expect(bare.headers.get('location')).toBe('/dashboard/')
    const res = await app.request('/dashboard/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  test.each([
    '/dashboard/users',
    '/dashboard/users/00000000-0000-7000-8000-000000000001/sessions',
    '/dashboard/settings/',
    '/dashboard/index.html',
    '/dashboard/users?tab=sessions',
  ])('%s is the app (SPA fallback), never cached', async (path) => {
    const res = await app.request(path)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test.each([
    ['/dashboard/assets/index-D4f8a1c2.js', 'text/javascript; charset=utf-8', 'console.log(1)'],
    ['/dashboard/assets/index-9b7e.css', 'text/css; charset=utf-8', 'body{}'],
    ['/dashboard/assets/font-a1b2.woff2', 'font/woff2', 'woff'],
  ])('%s is served as %s and cached for good', async (path, type, body) => {
    const res = await app.request(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(type)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await res.text()).toBe(body)
  })

  test('a file outside assets/ is revalidated; an unknown type is a download, never sniffed', async () => {
    const icon = await app.request('/dashboard/favicon.svg')
    expect(icon.headers.get('content-type')).toBe('image/svg+xml')
    expect(icon.headers.get('cache-control')).toBe('no-cache')
    expect((await app.request('/dashboard/robots.txt')).headers.get('content-type')).toBe(
      'text/plain; charset=utf-8'
    )
    const unknown = await app.request('/dashboard/data.unknownext')
    expect(unknown.headers.get('content-type')).toBe('application/octet-stream')
    expect(unknown.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('a missing file with an extension is a 404, not the app', async () => {
    for (const path of [
      '/dashboard/assets/missing-123.js',
      '/dashboard/logo.png',
      '/dashboard/a.map',
    ]) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('<!doctype')
    }
  })

  test('every response carries the security headers, the 404s too', async () => {
    for (const path of [
      '/dashboard/',
      '/dashboard/users',
      '/dashboard/assets/index-D4f8a1c2.js',
      '/dashboard/assets/missing.js',
    ]) {
      const res = await app.request(path)
      expect(res.headers.get('content-security-policy')).toBe(DASHBOARD_CSP)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
  })

  test('the policy allows this origin only: no inline script, no framing, no foreign connection', () => {
    const directives = Object.fromEntries(
      DASHBOARD_CSP.split('; ').map((directive) => {
        const [name = '', ...values] = directive.split(' ')
        return [name, values.join(' ')]
      })
    )
    expect(directives).toMatchObject({
      'default-src': "'self'",
      'script-src': "'self'",
      'connect-src': "'self'",
      'frame-ancestors': "'none'",
      'base-uri': "'none'",
      'form-action': "'self'",
      'object-src': "'none'",
    })
    expect(DASHBOARD_CSP).not.toContain('unsafe-inline')
    expect(DASHBOARD_CSP).not.toContain('unsafe-eval')
    expect(DASHBOARD_CSP).not.toContain('*')
    expect(DASHBOARD_CSP).not.toContain('http')
  })

  test('HEAD answers the headers without a body; other methods are not routed', async () => {
    const head = await app.request('/dashboard/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await app.request('/dashboard/', { method })).status).toBe(404)
    }
  })

  test('the session cookie is never sent here: its paths are the API’s', async () => {
    // Asserted where the cookie is set (session.test.ts); here, that the app's own path is
    // not under either of them.
    for (const path of ['/v1/instance', '/v1/admin']) {
      expect('/dashboard/'.startsWith(path)).toBe(false)
    }
  })
})

describe('a path never leaves the build directory', () => {
  test.each([
    '/dashboard/..%2fsecret.txt',
    '/dashboard/%2e%2e%2fsecret.txt',
    '/dashboard/..%2F..%2F..%2Fetc%2Fpasswd',
    '/dashboard/assets/..%2f..%2fsecret.txt',
    '/dashboard/..%5csecret.txt',
    '/dashboard/%2e%2e%5csecret.txt',
    '/dashboard/..%2fdist-private%2fsecret.txt',
    '/dashboard//etc/passwd',
    '/dashboard/%2fetc%2fpasswd',
    '/dashboard/secret.txt%00.js',
    '/dashboard/%00',
    '/dashboard/assets/linked.txt',
    '/dashboard/up/secret.txt',
    '/dashboard/.env',
    '/dashboard/.well-known/thing',
    '/dashboard/%ff%fe',
    '/dashboard/%',
    '/dashboard/../secret.txt',
    '/dashboard/assets/../../secret.txt',
    '/dashboard/..\\secret.txt',
    '/dashboard/%252e%252e%252fsecret.txt',
  ])('%s', async (path) => {
    const res = await app.request(path)
    const body = await res.text()
    expect(body).not.toContain(SECRET)
    expect(body).not.toContain('root:')
    // Either refused, or (for a path the URL parser folded back inside, or one that is just
    // an odd route name) the app itself. Never another file.
    expect([404, 200]).toContain(res.status)
    if (res.status === 200) {
      expect(body).toBe(INDEX)
    }
  })

  test.each([
    '../secret.txt',
    'assets/../../secret.txt',
    '..',
    '../dist-private/secret.txt',
    '/etc/passwd',
    `${'../'.repeat(12)}etc/passwd`,
    'assets/linked.txt',
    'up/secret.txt',
    'up',
    'secret.txt\0.js',
    '..\\secret.txt',
    '.env',
    '.well-known/thing',
    'assets/.hidden',
  ])('resolveDashboardFile refuses %j', async (path) => {
    expect(await resolveDashboardFile(root, path)).toBeNull()
  })

  test('resolveDashboardFile answers files inside the root and the fallback', async () => {
    expect(await resolveDashboardFile(root, 'assets/index-9b7e.css')).toEqual({
      path: join(root, 'assets', 'index-9b7e.css'),
      fallback: false,
    })
    expect(await resolveDashboardFile(root, '')).toEqual({
      path: join(root, 'index.html'),
      fallback: true,
    })
    expect(await resolveDashboardFile(root, 'users/abc')).toEqual({
      path: join(root, 'index.html'),
      fallback: true,
    })
    // A directory is not a file.
    expect(await resolveDashboardFile(root, 'assets')).toEqual({
      path: join(root, 'index.html'),
      fallback: true,
    })
    expect(await resolveDashboardFile(root, 'assets/missing.js')).toBeNull()
  })
})

describe('findDashboardDir', () => {
  test('answers the real path of a directory that holds an index.html, else null', async () => {
    expect(findDashboardDir(root)).toBe(root)
    // Through a link: the real directory is what paths are checked against.
    await symlink(root, join(base, 'linked-dist'))
    expect(findDashboardDir(join(base, 'linked-dist'))).toBe(root)
    expect(findDashboardDir(join(base, 'dist-private'))).toBeNull()
    expect(findDashboardDir(join(base, 'nowhere'))).toBeNull()
    expect(findDashboardDir(join(root, 'index.html'))).toBeNull()
  })

  test('with nothing configured it looks in the conventional place and finds no app in a checkout without one', () => {
    const found = findDashboardDir(undefined)
    expect(found === null || found.endsWith(join('apps', 'dashboard', 'dist'))).toBe(true)
  })
})
