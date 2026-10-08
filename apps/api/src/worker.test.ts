import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

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

describe('what the worker is built from', () => {
  /** Every module a file reaches through `~/` and relative imports, itself included. */
  async function reached(entry: string): Promise<Set<string>> {
    const src = import.meta.dir
    const seen = new Set<string>()
    const queue = [join(src, entry)]
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (seen.has(file)) {
        continue
      }
      seen.add(file)
      const text = await Bun.file(file).text()
      for (const [, specifier] of text.matchAll(
        /(?:from|import\()\s*['"]((?:~\/|\.{1,2}\/)[^'"]+)['"]/g
      )) {
        const base = specifier?.startsWith('~/')
          ? join(src, specifier.slice(2))
          : join(file, '..', specifier ?? '')
        for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
          if (/\.ts$/.test(candidate) && (await Bun.file(candidate).exists())) {
            queue.push(candidate)
            break
          }
        }
      }
    }
    return new Set([...seen].map((file) => file.slice(src.length + 1)))
  }

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
