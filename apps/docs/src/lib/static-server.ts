import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

/**
 * Where a request is answered from, in a static output directory.
 *
 * A path ending in `/` is that directory's `index.html`; a path with no extension that names a
 * directory is redirected to the same path with a slash, as a static host does. A path that
 * climbs out of the directory, or a malformed one, is nothing: the caller answers 404.
 *
 * @param directory - The output directory.
 * @param pathname - The URL's path, as sent.
 * @returns A file to send, a redirect target, or `null` for nothing.
 */
export function locate(
  directory: string,
  pathname: string
): { file: string } | { redirect: string } | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) {
    return null
  }
  const wanted = normalize(join(directory, decoded))
  if (wanted !== directory && !wanted.startsWith(directory + sep)) {
    return null
  }
  if (existsSync(wanted) && statSync(wanted).isDirectory()) {
    if (!pathname.endsWith('/')) {
      return { redirect: `${pathname}/` }
    }
    const index = join(wanted, 'index.html')
    return existsSync(index) ? { file: index } : null
  }
  return existsSync(wanted) ? { file: wanted } : null
}

/**
 * Where a request is answered from when the site is served under a base path, as GitHub Pages
 * serves it under the repository's name: the base is taken off before {@link locate}, a
 * redirect gets it back, the base without its last slash is sent to the base, and a path
 * outside it is nothing.
 *
 * @param directory - The output directory.
 * @param pathname - The URL's path, as sent.
 * @param base - The path the site is served under, `/` or `/a/b/`.
 * @returns What {@link locate} returns, for the path under the base.
 */
export function locateUnder(
  directory: string,
  pathname: string,
  base: string
): { file: string } | { redirect: string } | null {
  if (base !== '/' && pathname === base.slice(0, -1)) {
    return { redirect: base }
  }
  if (!pathname.startsWith(base)) {
    return null
  }
  const found = locate(directory, `/${pathname.slice(base.length)}`)
  if (found !== null && 'redirect' in found) {
    return { redirect: `${base}${found.redirect.slice(1)}` }
  }
  return found
}

/**
 * Serve a built site over HTTP, for the browser tests and for looking at it by hand.
 *
 * @param directory - The output directory.
 * @param port - The port to listen on.
 * @param base - The path the site is served under (`/` by default): the one it was built for.
 * @returns The running server.
 */
export function serveStatic(
  directory: string,
  port: number,
  base = '/'
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch(request) {
      const found = locateUnder(directory, new URL(request.url).pathname, base)
      if (found === null) {
        const missing = join(directory, '404.html')
        return existsSync(missing)
          ? new Response(Bun.file(missing), {
              status: 404,
              headers: { 'content-type': 'text/html' },
            })
          : new Response('Not found', { status: 404 })
      }
      if ('redirect' in found) {
        return Response.redirect(new URL(found.redirect, request.url), 301)
      }
      return new Response(Bun.file(found.file))
    },
  })
}
