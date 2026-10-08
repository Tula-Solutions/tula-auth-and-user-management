import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')

/**
 * How long a `docker` command may run. `Bun.spawnSync` blocks the thread the test runner's own
 * timeout runs on, so a Docker CLI that never answers (a daemon that is starting, busy or
 * wedged) would hang `bun run verify` for ever; only a timeout on the spawn itself can stop it.
 */
const DOCKER_TIMEOUT_MS = 20_000

// `spawnSync` throws when the binary is missing; without Docker these tests are skipped, since
// unit tests must run on a machine that has none.
function composeAvailable(): boolean {
  try {
    return (
      Bun.spawnSync(['docker', 'compose', 'version'], { timeout: DOCKER_TIMEOUT_MS }).exitCode === 0
    )
  } catch {
    return false
  }
}
const hasCompose = composeAvailable()

interface Service {
  image?: string
  environment?: Record<string, string>
  ports?: { published: string; target: number; host_ip?: string }[]
  volumes?: { source: string; target: string; read_only?: boolean }[]
  depends_on?: Record<string, unknown>
  command?: string[]
  network_mode?: string
  healthcheck?: { disable?: boolean }
  restart?: string
}

/**
 * The Compose file as Docker resolves it, with only the given variables set.
 *
 * @param variables - The variables of the environment file, and nothing else.
 * @param profiles - The profiles asked for; `app` alone unless said.
 * @param files - Further Compose files laid over the repository's, relative to its root.
 */
function resolved(
  variables: Record<string, string>,
  profiles: readonly string[] = ['app'],
  files: readonly string[] = []
): Record<string, Service> {
  const envFile = join(mkdtempSync(join(tmpdir(), 'tula-compose-')), 'env')
  writeFileSync(
    envFile,
    Object.entries(variables)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')
  )
  const result = Bun.spawnSync(
    [
      'docker',
      'compose',
      '-f',
      join(root, 'docker-compose.yml'),
      ...files.flatMap((file) => ['-f', join(root, file)]),
      '--env-file',
      envFile,
      ...profiles.flatMap((profile) => ['--profile', profile]),
      'config',
      '--format',
      'json',
    ],
    // Nothing from the developer's shell may leak in: only the env file counts.
    {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      timeout: DOCKER_TIMEOUT_MS,
    }
  )
  if (result.exitedDueToTimeout) {
    throw new Error(`\`docker compose config\` did not answer within ${DOCKER_TIMEOUT_MS} ms`)
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }
  return (JSON.parse(result.stdout.toString()) as { services: Record<string, Service> }).services
}

// What a developer's `.env` (copied from `.env.example`) contains. Compose reads that file too.
const DEVELOPER_ENV = {
  ENVIRONMENT: 'local',
  DATABASE_URL: 'postgres://tula_api:tula_api@127.0.0.1:5432/tula',
  DATABASE_MIGRATION_URL: 'postgres://tula:tula@127.0.0.1:5432/tula',
  PORT: '3003',
  PUBLIC_URL: 'http://localhost:3003',
  TULA_MASTER_KEY: 'ab'.repeat(32),
  SMTP_URL: 'smtp://127.0.0.1:1025',
  REDIS_URL: 'redis://127.0.0.1:6379',
}

describe.skipIf(!hasCompose)('docker-compose.yml', () => {
  test('a developer’s .env cannot point the packaged API at the host’s loopback', () => {
    const { api, migrate } = resolved(DEVELOPER_ENV)
    // Inside the container 127.0.0.1 is the container itself: mail and the database would fail.
    expect(api?.environment?.SMTP_URL).toBe('smtp://mailpit:1025')
    expect(api?.environment?.REDIS_URL).toBe('redis://redis:6379')
    expect(api?.environment?.DATABASE_URL).toBe('postgres://tula_api:tula_api@postgres:5432/tula')
    expect(migrate?.environment?.DATABASE_MIGRATION_URL).toBe(
      'postgres://tula:tula@postgres:5432/tula'
    )
    expect(api?.environment?.TULA_MASTER_KEY).toBe('ab'.repeat(32))
  })

  test('the mail relay can still be chosen on purpose', () => {
    const { api } = resolved({ API_SMTP_URL: 'smtps://relay.example.com:465' })
    expect(api?.environment?.SMTP_URL).toBe('smtps://relay.example.com:465')
  })

  test('the packaged API shares its state through the stack’s Redis unless told otherwise', () => {
    expect(resolved({}).api?.environment?.REDIS_URL).toBe('redis://redis:6379')
    expect(
      resolved({ API_REDIS_URL: 'rediss://cache.example.com:6380' }).api?.environment?.REDIS_URL
    ).toBe('rediss://cache.example.com:6380')
  })

  test('moving the API port moves its public URL with it', () => {
    const { api } = resolved({ API_PORT: '3010' })
    expect(api?.ports?.[0]).toMatchObject({ published: '3010', target: 3003 })
    expect(api?.environment?.PUBLIC_URL).toBe('http://localhost:3010')
    expect(resolved({}).api?.environment?.PUBLIC_URL).toBe('http://localhost:3003')
    expect(
      resolved({ API_PUBLIC_URL: 'https://auth.example.com' }).api?.environment?.PUBLIC_URL
    ).toBe('https://auth.example.com')
    // A developer's `.env` carries PUBLIC_URL for `bun run dev`; it must not pin the packaged
    // API to the old port.
    expect(
      resolved({ PUBLIC_URL: 'http://localhost:3003', API_PORT: '3010' }).api?.environment
        ?.PUBLIC_URL
    ).toBe('http://localhost:3010')
    // Four `docker compose config` runs in a row: more than the default five seconds of a
    // test on a slow runner. Each spawn still has its own limit.
  }, 60_000)

  test('nothing listens beyond this machine, and the API runs as the non-owner role', () => {
    const services = resolved({})
    for (const [name, service] of Object.entries(services)) {
      for (const port of service.ports ?? []) {
        expect(`${name} ${port.host_ip}`).toBe(`${name} 127.0.0.1`)
      }
    }
    expect(services.api?.environment?.DATABASE_URL).toContain('//tula_api:')
    // No built-in master key: the API must refuse to start rather than share a default secret.
    expect(services.api?.environment?.TULA_MASTER_KEY).toBe('')
  })

  test('the profile runs two API instances that differ only in their host port', () => {
    const services = resolved({ API_PORT: '3010', API_2_PORT: '3011' })
    expect(Object.keys(services).sort()).toEqual([
      'api',
      'api-2',
      'lb',
      'mailpit',
      'migrate',
      'postgres',
      'redis',
    ])
    const { api, 'api-2': second } = services
    // The same settings, most of all PUBLIC_URL: it is the issuer of every access token, so a
    // token signed by one instance is only accepted by the other if they agree on it.
    expect(second?.environment).toEqual(api?.environment ?? {})
    expect(second?.environment?.PUBLIC_URL).toBe('http://localhost:3010')
    expect(second?.environment?.REDIS_URL).toBe('redis://redis:6379')
    expect(second?.image).toBe(api?.image ?? '')
    expect(api?.ports?.[0]).toMatchObject({ published: '3010', target: 3003 })
    expect(second?.ports?.[0]).toMatchObject({ published: '3011', target: 3003 })
    expect(resolved({})['api-2']?.ports?.[0]).toMatchObject({ published: '3004', target: 3003 })
  })

  test('one address in front of both instances, published on this machine only', () => {
    const services = resolved({})
    const { lb } = services
    expect(lb?.ports).toHaveLength(1)
    expect(lb?.ports?.[0]).toMatchObject({ published: '3005', target: 8080, host_ip: '127.0.0.1' })
    expect(resolved({ LB_PORT: '3015' }).lb?.ports?.[0]).toMatchObject({ published: '3015' })
    expect(Object.keys(lb?.depends_on ?? {}).sort()).toEqual(['api', 'api-2'])
    // Its configuration is the file in the repository, mounted read-only.
    expect(lb?.volumes).toEqual([
      expect.objectContaining({
        source: join(root, 'docker/lb/nginx.conf'),
        target: '/etc/nginx/nginx.conf',
        read_only: true,
      }),
      // By default the API is told the address the proxy saw, never one the client sent.
      expect.objectContaining({
        source: join(root, 'docker/lb/forwarded-for.peer.conf'),
        target: '/etc/nginx/forwarded-for.conf',
        read_only: true,
      }),
    ])
    expect(resolved({ LB_CLIENT_ADDRESS: 'client' }).lb?.volumes?.[1]).toMatchObject({
      source: join(root, 'docker/lb/forwarded-for.client.conf'),
      target: '/etc/nginx/forwarded-for.conf',
    })
  })

  test('the built image can be given another tag, so two stacks do not overwrite each other', () => {
    const services = resolved({ API_IMAGE: 'tula-api:other' })
    expect(services.api?.image).toBe('tula-api:other')
    expect(services['api-2']?.image).toBe('tula-api:other')
    expect(services.migrate?.image).toBe('tula-api:other')
    expect(resolved({}).migrate?.image).toBe('tula-api:local')
  })

  test('every image that is pulled is pinned by digest', () => {
    for (const [name, service] of Object.entries(resolved({}))) {
      // The API image is built here, from a Dockerfile whose base is pinned (see below).
      if (service.image === 'tula-api:local') {
        continue
      }
      expect(`${name} ${service.image}`).toMatch(/^\S+ \S+:\S+@sha256:[0-9a-f]{64}$/)
    }
  })

  test('the development stack is unchanged: no API unless the profile is asked for', () => {
    expect(Object.keys(resolved(DEVELOPER_ENV, [])).sort()).toEqual([
      'mailpit',
      'postgres',
      'redis',
    ])
  })
})

// TULA-52: the webhook worker as a container of its own, from the same image.
describe.skipIf(!hasCompose)('the optional worker service', () => {
  const WITH_WORKER = ['app', 'worker']

  test('the app profile alone starts no worker, and its instances deliver', () => {
    const services = resolved({})
    expect(Object.keys(services)).not.toContain('worker')
    expect(services.api?.environment?.WEBHOOK_WORKER).toBe('api')
    expect(services['api-2']?.environment?.WEBHOOK_WORKER).toBe('api')
  })

  test('the worker profile adds one service: the same image and settings, another command', () => {
    const services = resolved({ WEBHOOK_WORKER: 'separate' }, WITH_WORKER)
    expect(Object.keys(services).sort()).toEqual([
      'api',
      'api-2',
      'lb',
      'mailpit',
      'migrate',
      'postgres',
      'redis',
      'worker',
    ])
    const { api, worker } = services
    expect(worker?.image).toBe(api?.image ?? '')
    // Everything the API has: the database, the master key (it opens the signing secrets),
    // Redis, and ENVIRONMENT, which is the tier the outbound guard judges an address in.
    expect(worker?.environment).toEqual(api?.environment ?? {})
    expect(worker?.command).toEqual(['bun', 'run', 'src/worker.ts'])
    // It waits for the migrations like the API, and runs none itself.
    expect(Object.keys(worker?.depends_on ?? {}).sort()).toEqual([
      'mailpit',
      'migrate',
      'postgres',
      'redis',
    ])
    expect(worker?.restart).toBe('unless-stopped')
  })

  test('one variable moves the deliveries: every container is given the same value', () => {
    const services = resolved({ WEBHOOK_WORKER: 'separate' }, WITH_WORKER)
    expect(services.api?.environment?.WEBHOOK_WORKER).toBe('separate')
    expect(services['api-2']?.environment?.WEBHOOK_WORKER).toBe('separate')
    expect(services.worker?.environment?.WEBHOOK_WORKER).toBe('separate')
    // Asked for without the variable, the worker is given `api` and refuses to start
    // (apps/api/src/process.ts): it never runs beside instances that deliver.
    expect(resolved({}, WITH_WORKER).worker?.environment?.WEBHOOK_WORKER).toBe('api')
  })

  test('the worker takes no traffic: nothing of it is published', () => {
    expect(resolved({ WEBHOOK_WORKER: 'separate' }, WITH_WORKER).worker?.ports ?? []).toEqual([])
  })

  test('the image the API tag names is the worker’s too', () => {
    expect(resolved({ API_IMAGE: 'tula-api:other' }, WITH_WORKER).worker?.image).toBe(
      'tula-api:other'
    )
  })
})

describe('docker/lb/nginx.conf', () => {
  const config = Bun.file(join(root, 'docker/lb/nginx.conf')).text()

  test('requests alternate between exactly the two API instances', async () => {
    const upstream = /upstream\s+tula_api\s*\{([^}]*)\}/.exec(await config)?.[1] ?? ''
    const servers = upstream
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('server '))
    expect(servers).toEqual(['server api:3003;', 'server api-2:3003;'])
    // Round robin is nginx's default; any of these would pin a client to one instance.
    expect(upstream).not.toMatch(/ip_hash|hash |sticky|least_conn|backup|weight=/)
  })

  test('the forwarded address is the peer the proxy saw, unless the conformance run asks otherwise', async () => {
    // TRUST_PROXY makes the API read the last X-Forwarded-For entry (lib/client-ip.ts). By
    // default the proxy overwrites the header, so a client cannot choose its rate-limit bucket.
    const text = await config
    const directives = (file: string) =>
      Bun.file(join(root, 'docker/lb', file))
        .text()
        .then((body) => body.split('\n').filter((line) => line !== '' && !line.startsWith('#')))
    expect(text).toContain('include /etc/nginx/forwarded-for.conf;')
    expect(text).not.toContain('proxy_set_header X-Forwarded-For')
    expect(text).not.toContain('$proxy_add_x_forwarded_for')
    expect(await directives('forwarded-for.peer.conf')).toEqual([
      'proxy_set_header X-Forwarded-For $remote_addr;',
    ])
    // The other file passes the runner's header through, and says what that gives away.
    expect(await directives('forwarded-for.client.conf')).toEqual([
      'proxy_set_header X-Forwarded-For $http_x_forwarded_for;',
    ])
    expect(await Bun.file(join(root, 'docker/lb/forwarded-for.client.conf')).text()).toContain(
      'Never use it'
    )
  })

  test('the access log names the instance and never a query string or a header', async () => {
    const text = await config
    const format = /log_format\s+upstream\s+'([^']*)'/.exec(text)?.[1] ?? ''
    expect(format).toContain('$upstream_addr')
    // An OAuth callback carries its code and state in the query; `$request` and
    // `$request_uri` would write them to the log. `$uri` is the path alone.
    expect(format).toContain('$uri')
    expect(text).not.toMatch(/\$request\b|\$request_uri|\$args|\$query_string|\$http_|\$cookie_/)
    expect(text).toContain('access_log /dev/stdout upstream;')
  })

  test('a failed request is not replayed against the other instance', async () => {
    // A retried POST would spend a code or count a guess twice.
    expect(await config).toContain('proxy_next_upstream off;')
  })
})

test('the API image’s base is pinned by digest, at the Bun version the repository uses', async () => {
  const dockerfile = await Bun.file(join(root, 'apps/api/Dockerfile')).text()
  const { packageManager } = (await Bun.file(join(root, 'package.json')).json()) as {
    packageManager: string
  }
  const bases = dockerfile
    .split('\n')
    .filter((line) => line.startsWith('FROM ') && line.includes('/'))
  expect(bases).toHaveLength(1)
  const version = packageManager.replace('bun@', '')
  expect(bases[0]).toMatch(
    new RegExp(`^FROM oven/bun:${version.replaceAll('.', '\\.')}-slim@sha256:[0-9a-f]{64} AS base$`)
  )
})

test('Dependabot watches every place a digest or an action version is pinned', async () => {
  const config = await Bun.file(join(root, '.github/dependabot.yml')).text()
  for (const ecosystem of ['docker', 'docker-compose', 'github-actions']) {
    expect(config).toContain(`package-ecosystem: ${ecosystem}\n`)
  }
  expect(config).toContain('directory: /apps/api\n')
})

test('the API image installs no browser package: their manifests never reach the install stage', async () => {
  // `bun install --production` installs the dependencies (and peers) of every workspace whose
  // manifest it finds. With `packages/react`, `packages/nextjs` or an example copied in, the API image
  // gains React (and Next.js).
  const dockerfile = await Bun.file(join(root, 'apps/api/Dockerfile')).text()
  const copied = dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && !line.startsWith('COPY --from'))
    .map((line) => line.split(/\s+/)[1] ?? '')
  expect(copied.length).toBeGreaterThan(5)
  expect(
    copied.filter((source) => /^(packages\/react|packages\/nextjs|examples|e2e)(\/|$)/.test(source))
  ).toEqual([])
  // Nothing copies the whole repository or a whole workspace group either.
  expect(
    copied.filter((source) => ['.', './', 'packages', 'packages/', 'apps'].includes(source))
  ).toEqual([])
})
