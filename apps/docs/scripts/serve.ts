import { resolveOutDir } from '../src/lib/paths'
import { serveStatic } from '../src/lib/static-server'

// Serves apps/docs/dist as static files: what the browser tests and `bun run dev` use. Not a
// production server; nothing deploys the site.
//
//   DOCS_PORT=4321 bun run serve

const port = Number(process.env.DOCS_PORT ?? 4321)
const server = serveStatic(resolveOutDir(), port)
console.log(`docs site: http://${server.hostname}:${server.port}/`)
