# @tula/mcp

Tula Auth's [Model Context Protocol](https://modelcontextprotocol.io) server: what
`tula mcp` serves. Read-only tools over an environment's users, sessions, audit entries,
settings, OAuth providers and deployment checks, and scaffold tools that return the files for
adding Tula to a Next.js or React app. **No tool changes live data, and no tool returns a
secret.**

Most people start it through the CLI:

```sh
TULA_API_URL=https://auth.example.com TULA_SECRET_KEY=… npx tula mcp
```

To embed it:

```ts
import { createAdminClient } from '@tula/admin'
import { createTulaMcpServer, serveOverStdio } from '@tula/mcp'

const secretKey = process.env.TULA_SECRET_KEY ?? ''
const server = createTulaMcpServer({
  admin: createAdminClient({ baseUrl: process.env.TULA_API_URL ?? '', secretKey }),
  cwd: process.cwd(),
  secrets: [secretKey],
  log: (line) => process.stderr.write(`${line}\n`),
})
await serveOverStdio(server, { input: process.stdin, output: process.stdout })
```

The tools, client configuration and exactly what is returned: `docs/mcp.md` in the
repository. The design: ADR 0033.
