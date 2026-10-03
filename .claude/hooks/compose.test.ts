import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
// `spawnSync` throws when the binary is missing; without Docker these tests are skipped, since
// unit tests must run on a machine that has none.
function composeAvailable(): boolean {
  try {
    return Bun.spawnSync(['docker', 'compose', 'version']).exitCode === 0
  } catch {
    return false
  }
}
const hasCompose = composeAvailable()

interface Service {
  environment?: Record<string, string>
  ports?: { published: string; target: number; host_ip?: string }[]
}

/** The Compose file as Docker resolves it, with only the given variables set. */
function resolved(variables: Record<string, string>, profile = true): Record<string, Service> {
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
      '--env-file',
      envFile,
      ...(profile ? ['--profile', 'app'] : []),
      'config',
      '--format',
      'json',
    ],
    // Nothing from the developer's shell may leak in: only the env file counts.
    { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } }
  )
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
  })

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

  test('the development stack is unchanged: no API unless the profile is asked for', () => {
    expect(Object.keys(resolved(DEVELOPER_ENV, false)).sort()).toEqual([
      'mailpit',
      'postgres',
      'redis',
    ])
  })
})
