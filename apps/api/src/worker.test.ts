import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The worker's entrypoint, started as the image starts it (`bun run src/worker.ts`), with a
// database address nothing listens on: no Docker, and what it does when its one dependency is
// away is part of what is shown. Each spawn has its own limit: a child that never exits must
// fail one test, not hang the run.

const cwd = join(import.meta.dir, '..')
const SPAWN_TIMEOUT_MS = 30_000

/** A port nothing is listening on now. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  if (port === undefined) {
    throw new Error('no port')
  }
  return port
}

function environment(overrides: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NODE_ENV: 'production',
    ENVIRONMENT: 'dev',
    // Nothing listens here.
    DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:1/tula',
    TULA_MASTER_KEY: 'ab'.repeat(32),
    LOG_LEVEL: 'info',
    ...overrides,
  }
}

const transpiler = new Bun.Transpiler({ loader: 'ts' })

/**
 * Every module a file loads at run time, by any form: `import … from`, a bare `import '…'`,
 * `export … from`, `require('…')` and `import('…')`. Read with Bun's own parser, not a pattern
 * over the text: a comment is not an import, and an import of types only loads nothing.
 *
 * @throws when the file has an `import(` or a `require(` whose argument is anything but one
 *   string written out (`import(name)`, `import('./' + name)`, `import(a ? './x' : './y')`),
 *   or runs code built from text (`new Function(`, a bare `eval(`): the walk cannot follow
 *   either, and saying nothing would be a pass.
 */
function loaded(source: string, file: string): string[] {
  // The parser's own output: no comment, no type. The rules below read text, so they err
  // towards refusing: a string that merely contains `import(x)` fails the walk too, and the
  // answer to that is to reword the string, never to loosen the rule.
  const code = transpiler.transformSync(source)
  // One whole string (or a template with nothing substituted), then the end of the argument:
  // `)` or the `,` before an options object. Anything else after the `(` is computed.
  const LITERAL = /^\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)\s*[,)]/
  const paths = transpiler.scanImports(source).map((entry) => entry.path)
  const computed: string[] = []
  for (const call of code.matchAll(/(?<![.\w$])(?:import|require)\(/g)) {
    const from = call.index + call[0].length
    const literal = LITERAL.exec(code.slice(from))?.[1]
    // The parser folds what it can before it prints: `require('./t' + 'arget')` comes out as
    // one string and `import(c ? './a' : './b')` as two imports, and it reports neither as an
    // import of the source. So a string here counts only if the scan of the source, as
    // written, names the same module; otherwise the name was put together, by whoever.
    if (literal === undefined || !paths.includes(literal.slice(1, -1))) {
      computed.push(`${call[0]}${code.slice(from, from + 40).split('\n')[0]}`)
    }
  }
  // Said first: a file that does this usually trips the rule above as well, by the text it runs.
  // Not a method of that name (`redis.eval(script)` runs Lua on a Redis server, not code here).
  const fromText = code.match(/\bnew\s+Function\s*\(|(?<![.\w$])eval\s*\(/g)
  if (fromText) {
    throw new Error(
      `${file} runs code built from text (${fromText.join(', ')}): the walk cannot see what that loads`
    )
  }
  if (computed.length > 0) {
    throw new Error(
      `${file} loads a module by a computed name (${computed.join(', ')}): the walk cannot see what that reaches`
    )
  }
  return paths
}

/**
 * Every module a file reaches through `~/` and relative specifiers, itself included, as
 * paths from `root`.
 */
async function reached(entry: string, root: string = import.meta.dir): Promise<Set<string>> {
  const seen = new Set<string>()
  const queue = [join(root, entry)]
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue
    }
    seen.add(file)
    for (const specifier of loaded(await Bun.file(file).text(), file.slice(root.length + 1))) {
      if (!/^(~\/|\.{1,2}\/)/.test(specifier)) {
        continue
      }
      const base = specifier.startsWith('~/')
        ? join(root, specifier.slice(2))
        : join(dirname(file), specifier)
      for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
        if (/\.ts$/.test(candidate) && (await Bun.file(candidate).exists())) {
          queue.push(candidate)
          break
        }
      }
    }
  }
  return new Set([...seen].map((file) => file.slice(root.length + 1)))
}

// The walk is only worth what it sees. Each way of loading a module, in a graph of its own.
describe('the import walk', () => {
  async function graph(entry: string): Promise<Set<string>> {
    const root = mkdtempSync(join(tmpdir(), 'tula-walk-'))
    mkdirSync(join(root, 'lib'))
    const files: Record<string, string> = {
      'entry.ts': entry,
      'target.ts': "import { deeper } from './lib/deeper'\nexport const target = deeper\n",
      'lib/deeper.ts': 'export const deeper = 1\n',
      'lib/index.ts': 'export const folder = 1\n',
      'types.ts': 'export interface Shape {\n  a: number\n}\n',
    }
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(root, name), text)
    }
    try {
      return await reached('entry.ts', root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  const WHOLE = ['entry.ts', 'lib/deeper.ts', 'target.ts']

  test.each([
    ['a named import', "import { target } from './target'\nexport const a = target\n"],
    ['an import for its side effects only', "import './target'\n"],
    ['a binding that is never used', "import unused from './target'\n"],
    ['a re-export of everything', "export * from './target'\n"],
    ['a re-export by name', "export { target } from './target'\n"],
    ['a require', "export const a = require('./target')\n"],
    ['a dynamic import', "export const a = await import('./target')\n"],
    ['a dynamic import inside a function', "export const a = () => import('./target')\n"],
    ['the root alias', "import '~/target'\n"],
  ])('%s is followed, and what it loads in turn', async (_form, entry) => {
    expect([...(await graph(entry))].sort()).toEqual(WHOLE)
  })

  test('a folder is its index file', async () => {
    expect([...(await graph("import './lib'\n"))].sort()).toEqual(['entry.ts', 'lib/index.ts'])
  })

  test.each([
    ['types only', "import type { Shape } from './types'\nexport const a: Shape = { a: 1 }\n"],
    ['a comment', "// import './target'\n/* require('./target') */\nexport const a = 1\n"],
    ['a package', "import { join } from 'node:path'\nexport const a = join\n"],
  ])('%s loads nothing, and is not followed', async (_form, entry) => {
    expect([...(await graph(entry))]).toEqual(['entry.ts'])
  })

  test.each([
    ['a dynamic import', "const name = './target'\nexport const a = await import(name)\n"],
    ['a template', "const name = 'target'\nexport const a = await import(`./${name}`)\n"],
    ['a require', "const name = './target'\nexport const a = require(name)\n"],
    // A name that only begins with a literal is as computed as one that does not.
    [
      'a dynamic import of a literal and more',
      "const n = 'target'\nexport const a = await import('./' + n)\n",
    ],
    [
      'a dynamic import of one of two literals',
      "const c = Date.now() > 0\nexport const a = await import(c ? './target' : './types')\n",
    ],
    ['a require of two literals joined', "export const a = require('./t' + 'arget')\n"],
  ])('%s of a computed name fails the walk, loudly', async (_form, entry) => {
    await expect(graph(entry)).rejects.toThrow(
      /^entry\.ts loads a module by a computed name \(.+\): the walk cannot see what that reaches$/
    )
  })

  // Code built from text can load anything, and no parser sees inside the text.
  test.each([
    ['new Function', 'export const a = new Function(\'return import("./target")\')()\n'],
    ['eval', 'export const a = eval(\'import("./target")\')\n'],
  ])('a file that runs code from text (%s) fails the walk, loudly', async (_form, entry) => {
    await expect(graph(entry)).rejects.toThrow(
      /^entry\.ts runs code built from text \(.+\): the walk cannot see what that loads$/
    )
  })

  test('a method called eval, a literal with an option, and a plain template are not refused', async () => {
    expect(
      [
        ...(await graph(
          [
            'const redis = { eval: (script: string) => script }',
            "export const a = redis.eval('return 1')",
            "export const b = await import('./target', { with: { type: 'x' } } as never)",
            'export const c = await import(`./lib/deeper`)',
            '',
          ].join('\n')
        )),
      ].sort()
    ).toEqual(WHOLE)
  })
})

describe('what the worker is built from', () => {
  test('no router, no API app, no migration and no signing-key bootstrap is reachable from it', async () => {
    const modules = await reached('worker.ts')
    // The walk found the real graph, not just the entry.
    expect(modules.has('jobs.ts')).toBe(true)
    expect(modules.has('modules/webhook/service.ts')).toBe(true)
    expect(modules.has('container.ts')).toBe(true)
    expect(
      [...modules].filter((file) => /(^|\/)(router|admin-router|dev-router)\.ts$/.test(file))
    ).toEqual([])
    expect(modules.has('index.ts')).toBe(false)
    expect(modules.has('server.ts')).toBe(false)
    expect(modules.has('modules/jwks/service.ts')).toBe(false)
    expect([...modules].filter((file) => file.includes('migrat'))).toEqual([])
    // It calls an operator's address through the guard and through nothing else.
    expect(modules.has('lib/outbound.ts')).toBe(true)
  })

  test('the API’s entrypoint still reaches the API (the walk can tell the two apart)', async () => {
    const modules = await reached('server.ts')
    expect(modules.has('index.ts')).toBe(true)
    expect(modules.has('modules/webhook/router.ts')).toBe(true)
    expect(modules.has('worker-app.ts')).toBe(false)
  })
})

describe('bun run src/worker.ts', () => {
  test('where the API instances deliver, it stops at boot and says what to set', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/worker.ts'], {
      cwd,
      env: environment({ WEBHOOK_WORKER: 'api', PORT: String(freePort()) }),
      timeout: SPAWN_TIMEOUT_MS,
    })
    expect(result.exitedDueToTimeout ?? false).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(
      'WEBHOOK_WORKER is `api`: the API instances make the webhook deliveries, so a worker process would not separate anything. Set WEBHOOK_WORKER=separate on every container (the API instances and this worker), or do not start a worker.'
    )
    expect(result.stdout.toString()).not.toContain('worker started')
  })

  test('unset, the variable is `api`: the same refusal', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/worker.ts'], {
      cwd,
      env: environment({ PORT: String(freePort()) }),
      timeout: SPAWN_TIMEOUT_MS,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('Set WEBHOOK_WORKER=separate on every container')
  })

  test('a misspelt value is refused by the environment’s own check, for a worker as for the API', () => {
    const result = Bun.spawnSync(['bun', 'run', 'src/worker.ts'], {
      cwd,
      env: environment({ WEBHOOK_WORKER: 'seperate', PORT: String(freePort()) }),
      timeout: SPAWN_TIMEOUT_MS,
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('WEBHOOK_WORKER: must be `api` or `separate`')
  })

  test(
    'separate: it serves its health endpoint and none of the API, keeps running without a database, and stops cleanly on SIGTERM',
    async () => {
      const port = freePort()
      const child = Bun.spawn(['bun', 'run', 'src/worker.ts'], {
        cwd,
        env: environment({ WEBHOOK_WORKER: 'separate', PORT: String(port) }),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: SPAWN_TIMEOUT_MS,
      })
      try {
        const base = `http://127.0.0.1:${port}`
        let status = 0
        for (let attempt = 0; attempt < 150 && status !== 200; attempt++) {
          status = await fetch(`${base}/v1/status`).then(
            (res) => res.status,
            () => 0
          )
          if (status !== 200) {
            await Bun.sleep(100)
          }
        }
        expect(status).toBe(200)

        // Not ready (its database is away), and saying so rather than exiting.
        const ready = await fetch(`${base}/v1/ready`)
        expect(ready.status).toBe(503)
        expect(await ready.json()).toEqual({ status: 'not_ready', checks: { database: 'fail' } })

        // None of the API is on this port.
        for (const path of ['/v1/client/config', '/v1/admin/users', '/v1/openapi.json']) {
          expect((await fetch(`${base}${path}`)).status).toBe(404)
        }

        child.kill('SIGTERM')
        expect(await child.exited).toBe(0)
        const out = await new Response(child.stdout).text()
        expect(out).toContain('tula webhook worker started')
        // The first round was tried and failed for want of a database: logged, not fatal.
        expect(out).toContain('could not run the webhook delivery job')
        expect(out).toContain('shutting down')
        expect(out).not.toContain('tula api listening')
        // The retention job is the API's.
        expect(out).not.toContain('retention')
        // After it has gone, nothing listens.
        expect(
          await fetch(`${base}/v1/status`).then(
            () => 'answered',
            () => 'refused'
          )
        ).toBe('refused')
      } finally {
        child.kill('SIGKILL')
      }
      // One process, a start of up to fifteen seconds and a shutdown: more than Bun's default.
    },
    SPAWN_TIMEOUT_MS + 10_000
  )
})
