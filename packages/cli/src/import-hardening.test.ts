import { describe, expect, test } from 'bun:test'
import type { AdminFetch } from '@tula-tech/admin'
import type { Host } from './host'
import { parseHashConfig } from './import/firebase'
import { truthy } from './import/formats'
import { COMMANDS, runCli } from './index'
import { fixture } from './testing/import-fixtures'

describe('truthy (H-264)', () => {
  test.each(['on', 'ON', ' enabled ', 'true', 'yes'])('%p is true', (value) => {
    expect(truthy(value)).toBe(true)
  })
  test.each(['off', 'disabled', '', '0', 'no'])('%p is false', (value) => {
    expect(truthy(value)).toBe(false)
  })
})

describe('parseHashConfig (H-273)', () => {
  test('a repeated key is an error, whatever the spelling', () => {
    expect(() =>
      parseHashConfig('base64_signer_key: abc\nrounds: 8\nrounds: 9\nmem_cost: 14')
    ).toThrow('twice')
    expect(() => parseHashConfig('{"base64_signer_key":"abc","base64SignerKey":"def"}')).toThrow(
      'twice'
    )
  })
})

describe('the salt separator from the environment (H-265)', () => {
  test('is redacted in the form it was typed, not only as standard base64', async () => {
    const raw = 'urlsafe-sep_valueXYZ'
    const files: Record<string, string> = { '/work/fb.json': fixture('firebase-users.json') }
    const host = {
      readFile: async (path: string) => files[path] ?? null,
      writeSecretFile: async (path: string, text: string) => {
        files[path] = text
      },
      sleep: async () => {},
    } as unknown as Host
    const fetch: AdminFetch = async () =>
      Response.json(
        { status: 400, code: 'validation.failed', detail: `bad ${raw}` },
        { status: 400 }
      )
    let out = ''
    await runCli(
      [
        'import',
        '--from',
        'firebase',
        'fb.json',
        '--yes',
        '--firebase-rounds',
        '8',
        '--firebase-mem-cost',
        '14',
      ],
      {
        stdout: { write: (t) => (out += t) },
        stderr: { write: (t) => (out += t) },
        env: {
          TULA_API_URL: 'http://localhost:3003',
          TULA_SECRET_KEY: 'tula_sk_dev_importtest00000000000000000000000',
          TULA_FIREBASE_SIGNER_KEY:
            'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
          TULA_FIREBASE_SALT_SEPARATOR: raw,
        },
        cwd: '/work',
        isTTY: false,
        stdinIsTTY: false,
        fetch,
        host,
      },
      COMMANDS
    )
    expect(out).toContain('[redacted]')
    expect(out).not.toContain(raw)
  })
})

describe('--no-trust-verified (H-275)', () => {
  test('sends every address unverified', async () => {
    const sent: { users: { emailVerified?: boolean }[] }[] = []
    const files: Record<string, string> = { '/work/users.csv': fixture('supabase-users.csv') }
    const host = {
      readFile: async (path: string) => files[path] ?? null,
      writeSecretFile: async (path: string, text: string) => {
        files[path] = text
      },
      sleep: async () => {},
    } as unknown as Host
    const fetch: AdminFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'))
      sent.push(body)
      return Response.json({ results: [] })
    }
    const run = async (extra: string[]) => {
      sent.length = 0
      delete files['/work/users.csv.tula-import-progress.json']
      await runCli(
        ['import', '--from', 'supabase', 'users.csv', '--yes', '--allow-passwordless', ...extra],
        {
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          env: {
            TULA_API_URL: 'http://localhost:3003',
            TULA_SECRET_KEY: 'tula_sk_dev_importtest00000000000000000000000',
          },
          cwd: '/work',
          isTTY: false,
          stdinIsTTY: false,
          fetch,
          host,
        },
        COMMANDS
      )
      return sent.flatMap((body) => body.users ?? [])
    }
    expect((await run([])).some((user) => user.emailVerified === true)).toBe(true)
    const users = await run(['--no-trust-verified'])
    expect(users.length).toBeGreaterThan(0)
    expect(users.every((user) => user.emailVerified === false)).toBe(true)
  })
})
