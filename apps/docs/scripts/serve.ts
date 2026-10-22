import { resolveBase, resolveOutDir } from '../src/lib/paths'
import { serveStatic } from '../src/lib/static-server'

// Serves apps/docs/dist as static files: what the browser tests and `bun run dev` use. Not a
// production server: GitHub Pages serves the published site (.github/workflows/docs-pages.yml).
// A site built with DOCS_BASE is served under that base, as Pages serves it.
//
//   DOCS_PORT=4321 bun run serve

const port = Number(process.env.DOCS_PORT ?? 4321)
const base = resolveBase()
const server = serveStatic(resolveOutDir(), port, base)
console.log(`docs site: http://${server.hostname}:${server.port}${base}`)
