import { join } from 'node:path'

// Serves the playground on a fixed port. The page is static; `main.ts` is bundled for the
// browser on each request, so editing it (or the SDK) only needs a reload.
//
//   bun run playground        → http://localhost:5173
//
// The port is fixed because the API decides by origin which pages may use its cookies: in the
// `local` tier every loopback origin is allowed, elsewhere this origin has to be listed in the
// environment's `urls.allowedOrigins`.
const PORT = 5173
const dir = import.meta.dir

const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
}

async function bundle(): Promise<Response> {
  const built = await Bun.build({
    entrypoints: [join(dir, 'main.ts')],
    target: 'browser',
    format: 'esm',
    sourcemap: 'inline',
  })
  const [output] = built.outputs
  if (!built.success || !output) {
    const reasons = built.logs.map((entry) => entry.message).join('\n')
    return new Response(
      `throw new Error(${JSON.stringify(`playground build failed:\n${reasons}`)})`,
      {
        headers: { 'content-type': 'text/javascript' },
      }
    )
  }
  return new Response(output, { headers: { 'content-type': 'text/javascript' } })
}

const server = Bun.serve({
  port: PORT,
  hostname: 'localhost',
  async fetch(request) {
    const { pathname } = new URL(request.url)
    const headers = {
      'cache-control': 'no-store',
      // No inline scripts and nothing loaded from elsewhere; the page may call any API.
      'content-security-policy':
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src *; base-uri 'none'; form-action 'self'",
    }
    if (pathname === '/main.js') {
      const response = await bundle()
      for (const [name, value] of Object.entries(headers)) {
        response.headers.set(name, value)
      }
      return response
    }
    const file = STATIC[pathname]
    return file
      ? new Response(Bun.file(join(dir, file)), { headers })
      : new Response('Not found', { status: 404, headers })
  },
})

process.stdout.write(`@tula/core playground on http://localhost:${server.port}\n`)
