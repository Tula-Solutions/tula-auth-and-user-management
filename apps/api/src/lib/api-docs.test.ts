import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from '~/env'
import { createApp, OPENAPI_PATH } from '~/index'
import { API_DOCS_CSP } from '~/lib/api-docs'
import { createTestDeps, TEST_CONFIG } from '~/testing'

// The API reference is HTML on the origin the dashboard's cookie lives on (ADR 0032): it
// loads no script from anywhere else, runs none inline, and can be switched off.

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

function app(config: Partial<typeof TEST_CONFIG> = {}) {
  return createApp(createTestDeps({ config: { ...TEST_CONFIG, ...config } }))
}

/** The `src` of every script of a page; throws for an inline one. */
function scriptSources(html: string): string[] {
  return [...html.matchAll(SCRIPT_TAG)].map((match) => {
    expect((match[2] ?? '').trim(), 'inline script').toBe('')
    const src = /\bsrc="([^"]*)"/.exec(match[1] ?? '')?.[1]
    if (src === undefined) {
      throw new Error('a script without a src')
    }
    return src
  })
}

/** The sources a policy lets script come from. */
function scriptSourcesAllowed(csp: string): string[] {
  const directives = new Map(
    csp.split(';').map((entry) => {
      const [name = '', ...values] = entry.trim().split(/\s+/)
      return [name, values] as const
    })
  )
  return directives.get('script-src') ?? directives.get('default-src') ?? ['*']
}

function expectNoRemoteScript(csp: string | null, where: string) {
  expect(csp, `${where}: Content-Security-Policy`).not.toBeNull()
  for (const source of scriptSourcesAllowed(csp ?? '')) {
    expect(["'self'", "'none'"], `${where}: script source ${source}`).toContain(source)
  }
}

describe('the API reference page', () => {
  test('has a policy that allows script from this origin only, and loads nothing remote', async () => {
    const res = await app().request('/v1/docs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('content-security-policy')).toBe(API_DOCS_CSP)
    expect(API_DOCS_CSP).toContain("default-src 'none'")
    expect(API_DOCS_CSP).toContain("script-src 'self'")
    expect(API_DOCS_CSP).not.toContain("'unsafe-eval'")
    expect(scriptSourcesAllowed(API_DOCS_CSP)).toEqual(["'self'"])
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).not.toContain('https://')
    expect(html).not.toContain('http://')
    const sources = scriptSources(html)
    expect(sources.length).toBeGreaterThan(0)
    for (const src of sources) {
      expect(src.startsWith('/v1/docs/assets/')).toBe(true)
    }
  })

  test('its scripts are served by the API, from the installed package, cacheable and typed', async () => {
    const api = app()
    const html = await (await api.request('/v1/docs')).text()
    const [prepare, bundle, init] = scriptSources(html)
    const served = await api.request(bundle ?? '')
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const installed = Bun.file(
      join(import.meta.dir, '../../node_modules/@scalar/api-reference/dist/browser/standalone.js')
    )
    expect((await served.arrayBuffer()).byteLength).toBe(installed.size)

    // Before the bundle: its copy of Zod must not try `new Function` (a CSP violation).
    const before = await api.request(prepare ?? '')
    expect(before.status).toBe(200)
    expect(before.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await before.text()).toContain('jitless: true')

    const start = await api.request(init ?? '')
    expect(start.status).toBe(200)
    expect(start.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const source = await start.text()
    expect(source).toContain(OPENAPI_PATH)
    expect(source).not.toContain('https://')
  })

  test('the bundle’s path names the installed version: another version is another path', async () => {
    const api = app()
    const [, bundle = ''] = scriptSources(await (await api.request('/v1/docs')).text())
    const { version } = (await Bun.file(
      join(import.meta.dir, '../../node_modules/@scalar/api-reference/package.json')
    ).json()) as { version: string }
    expect(bundle).toContain(version)
    expect((await api.request(bundle.replace(version, '0.0.0'))).status).toBe(404)
  })

  test('switched off: the page and its scripts are unknown paths, the contract stays', async () => {
    const on = app()
    const sources = scriptSources(await (await on.request('/v1/docs')).text())
    const off = app({ apiDocs: false })
    for (const path of ['/v1/docs', '/v1/docs/', ...sources]) {
      const res = await off.request(path)
      expect(res.status, path).toBe(404)
      expect(((await res.json()) as { code: string }).code).toBe('resource.not_found')
    }
    expect((await off.request(OPENAPI_PATH)).status).toBe(200)
  })

  test('is not in the OpenAPI document', async () => {
    const doc = (await (await app().request(OPENAPI_PATH)).json()) as { paths: object }
    expect(Object.keys(doc.paths).filter((path) => path.startsWith('/v1/docs'))).toEqual([])
  })
})

describe('API_DOCS', () => {
  const base = {
    DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:5432/tula',
    TULA_MASTER_KEY: 'a'.repeat(64),
  }
  const live = {
    ...base,
    SMTP_URL: 'smtps://relay.example.com:465',
    MAIL_FROM: 'Example <no-reply@example.com>',
    BREACH_CHECK: 'hibp',
    PUBLIC_URL: 'https://auth.example.com',
    REDIS_URL: 'rediss://cache.example.com:6380',
  }

  test.each([
    ['local', base, true],
    ['dev', live, true],
    ['staging', live, false],
    ['prod', live, false],
  ] as const)('defaults in the %s tier', (tier, source, expected) => {
    expect(parseEnv({ ...source, ENVIRONMENT: tier }).API_DOCS).toBe(expected)
    expect(parseEnv({ ...source, ENVIRONMENT: tier, API_DOCS: '' }).API_DOCS).toBe(expected)
  })

  test('an explicit value wins in every tier', () => {
    expect(parseEnv({ ...live, ENVIRONMENT: 'prod', API_DOCS: 'on' }).API_DOCS).toBe(true)
    expect(parseEnv({ ...base, ENVIRONMENT: 'local', API_DOCS: 'off' }).API_DOCS).toBe(false)
  })

  test('anything but on or off fails the boot', () => {
    expect(() => parseEnv({ ...base, ENVIRONMENT: 'local', API_DOCS: 'true' })).toThrow()
  })
})

describe('every HTML response of the API', () => {
  const dashboardDir = realpathSync(mkdtempSync(join(tmpdir(), 'tula-html-walk-')))
  writeFileSync(join(dashboardDir, 'index.html'), '<!doctype html><title>Dashboard</title>')
  afterAll(() => rmSync(dashboardDir, { recursive: true, force: true }))

  test('carries a Content-Security-Policy that allows no remote script, and nosniff', async () => {
    // Everything that can be mounted is: the dashboard, the mock provider's pages, the docs.
    const api = app({ dashboardDir, oauthMock: true, tier: 'local', apiDocs: true })
    const html: string[] = []
    const seen = new Set<string>()
    for (const route of api.routes) {
      // Pages are answers to a navigation or a form post (Apple's callback, the mock's form).
      if (route.method !== 'GET' && route.method !== 'POST') {
        continue
      }
      // A parameter gets a value that is nobody's id; a wildcard, a path of the app.
      const path = route.path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, 'x').replace(/\*/g, 'page')
      const key = `${route.method} ${path}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      const res = await api.request(path, { method: route.method })
      if (!(res.headers.get('content-type') ?? '').includes('text/html')) {
        continue
      }
      html.push(key)
      expectNoRemoteScript(res.headers.get('content-security-policy'), path)
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff')
      const body = await res.text()
      for (const match of body.matchAll(SCRIPT_TAG)) {
        expect(/\bsrc="https?:/.test(match[1] ?? ''), `${path}: remote script tag`).toBe(false)
      }
    }
    // The walk found the pages it exists for; one that stops being reached is a gap here.
    expect(html).toContain('GET /v1/docs')
    expect(html).toContain('GET /dashboard/page')
    expect(html).toContain('GET /v1/dev/oauth/authorize')
    expect(html).toContain('GET /v1/oauth/callback/x')
    expect(html).toContain('POST /v1/oauth/callback/x')
  })
})
