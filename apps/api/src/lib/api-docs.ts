import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import type { AppEnv } from '~/dependencies'
import { NotFoundError } from '~/exceptions'

/** Where the API reference page is served. */
export const API_DOCS_PATH = '/v1/docs'

/**
 * The Content-Security-Policy of the API reference page (ADR 0032).
 *
 * The page is HTML on the origin the dashboard's session cookie belongs to, so a script that
 * ran in it could call `/v1/admin/*` as the signed-in operator. Script therefore comes from
 * this origin only: no other host, nothing inline, no `eval`. Requests go to this origin only
 * (the reference's "try it" client reaches this API and nothing else). Inline *style* is
 * allowed because the reference's bundle injects its stylesheet at run time; style cannot
 * call the API.
 */
export const API_DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** The npm package the reference's bundle is read from. */
const PACKAGE = '@scalar/api-reference'
/** The single-file browser build inside it: no follow-up chunk requests. */
const BUNDLE_FILE = join('dist', 'browser', 'standalone.js')

/** The installed reference bundle: where it is and which version. */
export interface ApiDocsBundle {
  /** Absolute path of the bundle file. */
  file: string
  /** The package's version, which is part of the path the bundle is served at. */
  version: string
}

/**
 * Find the API reference's browser bundle in the installed, lockfile-pinned npm package.
 *
 * The page never loads it from a CDN: what runs on this origin is the file the lockfile
 * names, served by the API itself.
 *
 * @param from - The directory resolution starts from.
 * @returns The bundle, or `null` when the package or the file is not installed.
 */
export function findApiDocsBundle(from: string = import.meta.dir): ApiDocsBundle | null {
  let entry: string
  try {
    entry = Bun.resolveSync(PACKAGE, from)
  } catch {
    return null
  }
  // The package's `exports` name neither its manifest nor the bundle, so walk up from its
  // entry point to the directory whose manifest carries its name.
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) {
      continue
    }
    const { name, version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: string
      version?: string
    }
    if (name !== PACKAGE) {
      continue
    }
    const file = join(dir, BUNDLE_FILE)
    return typeof version === 'string' && /^[0-9A-Za-z.+-]+$/.test(version) && existsSync(file)
      ? { file, version }
      : null
  }
  return null
}

const SCRIPT_HEADERS = {
  'Content-Type': 'text/javascript; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
} as const

/**
 * The start script, as its own file: the policy allows no inline script.
 *
 * Everything that would make the page contact another host is switched off: the hosted
 * fonts, the request proxy, telemetry and the hosted assistant.
 */
function startScript(openApiPath: string): string {
  const configuration = {
    url: openApiPath,
    withDefaultFonts: false,
    telemetry: false,
    proxyUrl: '',
    hideClientButton: true,
    showDeveloperTools: 'never',
    agent: { disabled: true },
    mcp: { disabled: true },
    _integration: 'hono',
  }
  return `Scalar.createApiReference('#app', ${JSON.stringify(configuration)})\n`
}

/**
 * Runs before the bundle. The bundle carries its own copy of Zod, which finds out whether it
 * may compile parsers with `new Function` by trying; under this policy the attempt is refused
 * and reported as a violation. Zod reads its settings from `globalThis.__zod_globalConfig`,
 * so `jitless` is set there first and the attempt is never made.
 */
const PREPARE_SCRIPT =
  'globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true })\n'

function page(title: string, scripts: readonly string[]): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${title}</title></head><body><div id="app"></div>` +
    scripts.map((src) => `<script src="${src}"></script>`).join('') +
    '</body></html>'
  )
}

/**
 * The routes of the API reference: the page, the reference's bundle and the two small
 * scripts around it (the policy allows no inline script, so each is a file).
 *
 * The page carries {@link API_DOCS_CSP} and is never cached. The bundle is served from the
 * installed npm package at a path that names its version, so it can be cached for good: a
 * new version is a new path. Mounted only where `API_DOCS` is on.
 *
 * @param options - `openApiPath`: the OpenAPI document the page reads; `bundle`: the
 *   installed bundle ({@link findApiDocsBundle}).
 * @returns The router, to mount at the app's root.
 */
export function apiDocsRouter(options: {
  openApiPath: string
  bundle: ApiDocsBundle
}): Hono<AppEnv> {
  const router = new Hono<AppEnv>()
  const bundlePath = `${API_DOCS_PATH}/assets/api-reference-${options.bundle.version}.js`
  const preparePath = `${API_DOCS_PATH}/assets/prepare.js`
  const startPath = `${API_DOCS_PATH}/assets/start.js`
  // In this order: the settings the bundle reads, the bundle, then the call that starts it.
  const html = page('Tula API', [preparePath, bundlePath, startPath])
  const start = startScript(options.openApiPath)

  router.get(API_DOCS_PATH, (c) => {
    c.header('Content-Security-Policy', API_DOCS_CSP)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'no-store')
    return c.html(html)
  })

  router.get(bundlePath, async () => {
    const file = Bun.file(options.bundle.file)
    if (!(await file.exists())) {
      throw new NotFoundError()
    }
    return new Response(file, {
      headers: { ...SCRIPT_HEADERS, 'Cache-Control': 'public, max-age=31536000, immutable' },
    })
  })

  router.get(preparePath, () => {
    return new Response(PREPARE_SCRIPT, {
      headers: { ...SCRIPT_HEADERS, 'Cache-Control': 'no-cache' },
    })
  })

  router.get(startPath, () => {
    return new Response(start, { headers: { ...SCRIPT_HEADERS, 'Cache-Control': 'no-cache' } })
  })

  return router
}
