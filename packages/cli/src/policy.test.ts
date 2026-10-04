import { beforeEach, describe, expect, test } from 'bun:test'
import type { AdminFetch } from '@tula/admin'
import { PASSWORD_POLICY_PRESETS } from '@tula/contract'
import { createApp } from '../../../apps/api/src/index'
import { createTestDeps, seedApiKey, TEST_CONFIG } from '../../../apps/api/src/testing'
import { type CliIo, COMMANDS, runCli } from './index'

const SECRET_KEY = 'tula_sk_dev_policytest0000000000000000000000000'
const BASE_URL = 'http://localhost:3003'
const STRONG = 'vivid-Harbor-93-lantern-quartz'
const WEAK = 'password'

let app: ReturnType<typeof createApp>
/** Everything that left the process: URLs, headers and bodies of every request. */
let wire: string[]

beforeEach(async () => {
  const deps = createTestDeps()
  await seedApiKey(deps, SECRET_KEY)
  app = createApp(deps)
  wire = []
})

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function tula(args: string[], io: Partial<CliIo> = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const fetch: AdminFetch = async (url, init) => {
    wire.push(
      `${init?.method ?? 'GET'} ${url} ${JSON.stringify([...new Headers(init?.headers)].filter(([name]) => name !== 'authorization'))} ${String(init?.body ?? '')}`
    )
    return app.request(url, init)
  }
  const code = await runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      env: { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: SECRET_KEY },
      cwd: '/nowhere',
      isTTY: false,
      stdinIsTTY: false,
      fetch,
      ...io,
    },
    COMMANDS
  )
  return { code, stdout, stderr }
}

const stdin = (text: string) => ({ readStdin: async () => text })

describe('tula policy test', () => {
  test('a strong password from standard input passes every rule: exit 0', async () => {
    const run = await tula(['policy', 'test'], stdin(`${STRONG}\n`))
    expect(run.code).toBe(0)
    expect(run.stderr).toBe('')
    expect(run.stdout).toMatch(/pass\s+min_length\s+at least 10 characters/)
    expect(run.stdout).toMatch(/pass\s+common/)
    expect(run.stdout).not.toContain('FAIL')
    expect(run.stdout).toContain('would be accepted')
  })

  test('a weak password: the rules it breaks, exit 2', async () => {
    const run = await tula(['policy', 'test'], stdin(WEAK))
    expect(run.code).toBe(2)
    expect(run.stdout).toMatch(/FAIL\s+min_length/)
    expect(run.stdout).toMatch(/FAIL\s+common/)
    expect(run.stdout).toContain('would be refused')
  })

  test('says whether the breach check ran: it does not, and the output says why', async () => {
    const run = await tula(['policy', 'test'], stdin(STRONG))
    expect(run.stdout).toMatch(/not run\s+breach/)
    expect(run.stdout).toContain('was not sent anywhere')
  })

  test('the password is never printed and never leaves the machine', async () => {
    const runs = [
      await tula(['policy', 'test'], stdin(STRONG)),
      await tula(['policy', 'test', '--json'], stdin(STRONG)),
      await tula(['policy', 'test', STRONG]),
      await tula(['policy', 'test'], { stdinIsTTY: true, promptSecret: async () => STRONG }),
      // Failures on the way: a refused key, an API that is down.
      await tula(['policy', 'test'], {
        ...stdin(STRONG),
        env: { TULA_API_URL: BASE_URL, TULA_SECRET_KEY: `${SECRET_KEY}x` },
      }),
      await tula(['policy', 'test'], {
        ...stdin(STRONG),
        fetch: async () => {
          throw new TypeError(`fetch failed for ${STRONG}`)
        },
      }),
      await tula(['policy', 'test', STRONG, 'extra-argument']),
    ]
    for (const run of runs) {
      expect(run.stdout + run.stderr).not.toContain(STRONG)
    }
    expect(wire.length).toBeGreaterThan(0)
    for (const request of wire) {
      expect(request).not.toContain(STRONG)
      expect(request).toMatch(/^GET /)
    }
  })

  test('on a terminal the password is asked for without echo', async () => {
    const questions: string[] = []
    const run = await tula(['policy', 'test'], {
      stdinIsTTY: true,
      promptSecret: async (question) => {
        questions.push(question)
        return WEAK
      },
    })
    expect(questions).toEqual(['Password to test (not shown): '])
    expect(run.code).toBe(2)
  })

  test('a password as an argument works, with a warning about shell history', async () => {
    const run = await tula(['policy', 'test', STRONG])
    expect(run.code).toBe(0)
    expect(run.stderr).toContain('warning:')
    expect(run.stderr).toContain('shell history')
  })

  test('--email and --name feed the "does not contain your name or email" rule', async () => {
    const password = 'mayalin-Harbor-93-lantern'
    const without = await tula(['policy', 'test'], stdin(password))
    expect(without.stdout).toMatch(/pass\s+user_info/)
    expect(without.stdout).toContain('--email')
    const withEmail = await tula(
      ['policy', 'test', '--email', 'mayalin@example.com'],
      stdin(password)
    )
    expect(withEmail.code).toBe(2)
    expect(withEmail.stdout).toMatch(/FAIL\s+user_info/)
    const withName = await tula(['policy', 'test', '--name', 'Harbor Lin'], stdin(password))
    expect(withName.stdout).toMatch(/FAIL\s+user_info/)
  })

  test('--json: the policy’s rules as data, without the password', async () => {
    const run = await tula(['policy', 'test', '--json'], stdin(WEAK))
    expect(run.code).toBe(2)
    const report = JSON.parse(run.stdout) as {
      accepted: boolean
      preset: string
      breachCheck: { policy: string; ran: boolean }
      rules: { rule: string; passed: boolean; code: string }[]
    }
    expect(report.accepted).toBe(false)
    expect(report.preset).toBe('recommended')
    expect(report.breachCheck).toEqual({ policy: 'block', ran: false })
    expect(report.rules.find((rule) => rule.rule === 'min_length')).toMatchObject({
      passed: false,
      code: 'password.too_short',
    })
  })

  test('every rule a policy can have is described in words', async () => {
    const deps = createTestDeps({
      config: {
        ...TEST_CONFIG,
        passwordPolicy: {
          ...PASSWORD_POLICY_PRESETS.recommended,
          preset: 'custom',
          requireLowercase: true,
          requireUppercase: true,
          requireNumber: true,
          requireSpecial: true,
          minCharacterClasses: 3,
          maxRepeatedChars: 2,
          blockSequences: true,
          breachCheck: 'off',
        },
      },
    })
    await seedApiKey(deps, SECRET_KEY)
    app = createApp(deps)
    const run = await tula(['policy', 'test'], stdin('aaaa1234'))
    expect(run.code).toBe(2)
    for (const text of [
      /pass\s+lowercase\s+a lowercase letter/,
      /FAIL\s+uppercase\s+an uppercase letter/,
      /pass\s+number\s+a digit/,
      /FAIL\s+special\s+a special character/,
      /FAIL\s+character_classes\s+at least 3 of/,
      /FAIL\s+repeated_characters\s+no character more than 2 times/,
      /FAIL\s+sequence\s+no run of consecutive/,
      /pass\s+max_length\s+at most/,
      /not run\s+breach\s+the breached-password check is off/,
    ]) {
      expect(run.stdout).toMatch(text)
    }
    expect(run.stdout).toContain('preset: custom')
    expect(run.stdout).toMatch(/breaks \d+ rules/)
  })

  test('the key cannot come from standard input: the password does', async () => {
    const run = await tula(['policy', 'test', '--secret-key-file', '-'], stdin(STRONG))
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('--secret-key-file -')
  })

  test('a password that is an ordinary word does not garble the result', async () => {
    const run = await tula(['policy', 'test'], stdin('characters'))
    expect(run.stdout).toContain('at least 10 characters')
    expect(run.stdout).not.toContain('[redacted]')
  })

  test('an unforeseen error that quotes the password is redacted', async () => {
    const run = await tula(['policy', 'test'], {
      ...stdin(STRONG),
      fetch: async () =>
        Response.json({ status: 500, code: 'internal', detail: `echo ${STRONG}` }, { status: 500 }),
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('[redacted]')
    expect(run.stderr).not.toContain(STRONG)
  })

  test.each([
    [['policy'], 'tula policy test'],
    [['policy', 'lint'], 'tula policy test'],
  ])('%j is a usage error', async (args, hint) => {
    const run = await tula(args, stdin(STRONG))
    expect(run.code).toBe(1)
    expect(run.stderr).toContain(hint)
  })

  test('no password is a usage error, not a pass', async () => {
    const run = await tula(['policy', 'test'], stdin('\n'))
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('No password')
  })

  test('a terminal with no way to hide typing refuses rather than echo', async () => {
    const run = await tula(['policy', 'test'], { stdinIsTTY: true })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('standard input')
  })

  test('needs a secret key: the policy is the environment’s', async () => {
    const run = await tula(['policy', 'test'], {
      ...stdin(STRONG),
      env: { TULA_API_URL: BASE_URL },
    })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('TULA_SECRET_KEY')
  })
})
