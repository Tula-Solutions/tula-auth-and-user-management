# @tula/mcp

Tula Auth's [Model Context Protocol](https://modelcontextprotocol.io) server: what
`tula mcp` serves. Tools that read an environment's users, sessions, audit entries,
settings, OAuth providers and deployment checks, a tool that drafts a settings change as an
edit to `tula.config.ts` for a person to apply, and scaffold tools that return the files for
adding Tula to a Next.js or React app. One tool changes live data, for the time a run
takes (under a minute) and only where the environment allows it: `test_signin` has the server sign a
throwaway user up and in and delete it. **No other tool changes live data, and no tool
returns a secret.**

> **Alpha.** Released under the `alpha` dist-tag: the tools and what they return may change
> from one alpha to the next. Everything else is in the
> [repository](https://github.com/Tula-Solutions/tula-auth-and-user-management#readme).

Most people start it through the CLI (`@tula/cli`, which runs on Bun):

```sh
bun add -d @tula/cli@alpha
TULA_API_URL=https://auth.example.com TULA_SECRET_KEY=… bunx tula mcp
```

To embed it (`bun add @tula/mcp@alpha @tula/admin@alpha`):

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
