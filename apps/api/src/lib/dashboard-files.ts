import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '~/dependencies'
import { NotFoundError } from '~/exceptions'

/** Where the API serves the dashboard's build output. */
export const DASHBOARD_PATH = '/dashboard'

/**
 * Where the dashboard's build output is looked for when `DASHBOARD_DIR` is not set:
 * `apps/dashboard/dist`, next to this package, in a checkout and in the image alike.
 */
export const DEFAULT_DASHBOARD_DIR = resolve(import.meta.dir, '../../../dashboard/dist')

/**
 * The Content-Security-Policy of every dashboard response (ADR 0032).
 *
 * Everything comes from this origin: no inline script or style, no `eval`, no plugin, and the
 * page talks only to the API that served it (`connect-src 'self'`), so an injected script
 * could not send what it reads anywhere else. It cannot be framed (`frame-ancestors 'none'`:
 * clickjacking), cannot have its relative URLs rebased (`base-uri 'none'`), and its forms post
 * to this origin only. `data:` images are allowed for inlined icons and the QR-less UI's
 * small assets; nothing else is.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

/** Vite's hashed output: the name changes with the content, so it can be cached for good. */
const IMMUTABLE_PREFIX = 'assets/'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

/**
 * Find the dashboard's build directory at boot.
 *
 * @param configured - `DASHBOARD_DIR`, if set; otherwise {@link DEFAULT_DASHBOARD_DIR}.
 * @returns The directory's real path when it holds an `index.html`, else `null`: the API then
 *   serves no dashboard and `/dashboard` is an unknown path.
 */
export function findDashboardDir(configured: string | undefined): string | null {
  try {
    const root = realpathSync(resolve(configured ?? DEFAULT_DASHBOARD_DIR))
    if (!statSync(root).isDirectory() || !statSync(join(root, 'index.html')).isFile()) {
      return null
    }
    return root
  } catch {
    return null
  }
}

function isInside(root: string, path: string): boolean {
  return path.startsWith(root + sep)
}

/**
 * Decide which file answers a request path, without ever leaving the build directory.
 *
 * - A path with a NUL, a backslash, or a segment that starts with a dot (`..`, `.env`) is
 *   refused outright.
 * - The path is resolved against the root and must stay under it; then its **real** path
 *   (links followed) must stay under it too, so a link inside the directory cannot lead out.
 * - An existing regular file is served. A path whose last segment has an extension and is not
 *   a file is refused (a missing asset must not answer HTML). Anything else is a route of the
 *   single-page app and gets `index.html`.
 *
 * @param root - The build directory's real path ({@link findDashboardDir}).
 * @param requestPath - The decoded path below `/dashboard/`, e.g. `assets/index-1a2b.js`.
 * @returns The file to send and whether it is the app's fallback, or `null` to answer 404.
 */
export async function resolveDashboardFile(
  root: string,
  requestPath: string
): Promise<{ path: string; fallback: boolean } | null> {
  if (requestPath.includes('\0') || requestPath.includes('\\')) {
    return null
  }
  const segments = requestPath.split('/').filter((segment) => segment !== '')
  if (requestPath.startsWith('/') || segments.some((segment) => segment.startsWith('.'))) {
    return null
  }
  const index = { path: join(root, 'index.html'), fallback: true }
  if (segments.length === 0) {
    return index
  }
  const candidate = resolve(root, segments.join(sep))
  if (!isInside(root, candidate)) {
    return null
  }
  let real: string | null = null
  try {
    real = await realpath(candidate)
  } catch {
    // Does not exist: decided below.
  }
  if (real !== null) {
    if (!isInside(root, real)) {
      return null
    }
    if ((await stat(real)).isFile()) {
      return real === index.path ? index : { path: real, fallback: false }
    }
  }
  return extname(segments[segments.length - 1] ?? '') === '' ? index : null
}

/**
 * Set the dashboard's security headers on every response under `/dashboard`, errors included.
 *
 * Mounted before the app's general `secureHeaders()`, so it runs after it on the way out and
 * its stricter values are the ones sent.
 *
 * @returns The middleware.
 */
export function dashboardSecurityHeaders() {
  return createMiddleware<AppEnv>(async (c, next) => {
    await next()
    c.res.headers.set('Content-Security-Policy', DASHBOARD_CSP)
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    c.res.headers.set('Referrer-Policy', 'no-referrer')
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    c.res.headers.set('X-Frame-Options', 'DENY')
  })
}

/**
 * The routes that serve the dashboard's build output as static files (ADR 0032).
 *
 * `GET` and `HEAD` only. `index.html` is never cached (`no-store`: a new build must be picked
 * up at once, and it is what decides which hashed files load); files under `assets/` are
 * immutable; anything else is revalidated. A type the table does not know is sent as
 * `application/octet-stream`, never guessed.
 *
 * @param root - The build directory's real path ({@link findDashboardDir}).
 * @returns The router, to mount at the app's root.
 */
export function dashboardRouter(root: string): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get(DASHBOARD_PATH, (c) => c.redirect(`${DASHBOARD_PATH}/`, 308))

  router.get(`${DASHBOARD_PATH}/*`, async (c) => {
    // The raw path: decoded here, once, so nothing downstream sees an encoded separator.
    const raw = new URL(c.req.url).pathname.slice(DASHBOARD_PATH.length + 1)
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      throw new NotFoundError()
    }
    const file = await resolveDashboardFile(root, decoded)
    if (!file) {
      throw new NotFoundError()
    }
    const relative = file.path
      .slice(root.length + 1)
      .split(sep)
      .join('/')
    c.header(
      'Content-Type',
      CONTENT_TYPES[extname(file.path).toLowerCase()] ?? 'application/octet-stream'
    )
    c.header(
      'Cache-Control',
      file.fallback
        ? 'no-store'
        : relative.startsWith(IMMUTABLE_PREFIX)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
    )
    return c.body(await Bun.file(file.path).arrayBuffer())
  })

  return router
}
