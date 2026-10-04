import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createProcessIo, type ProcessParts, processIo } from './process-io'

const SECRET_KEY = 'tula_sk_dev_processio000000000000000000000000000'

function stream(isTTY: boolean): PassThrough & { isTTY?: boolean } {
  return Object.assign(new PassThrough(), { isTTY })
}

function parts(overrides: Partial<ProcessParts> & { ttys?: [boolean, boolean, boolean] } = {}): {
  parts: ProcessParts
  stderr: () => string
  read: string[]
} {
  const [stdin, stdout, stderr] = overrides.ttys ?? [false, false, false]
  let written = ''
  const read: string[] = []
  const error = stream(stderr)
  error.on('data', (chunk) => {
    written += String(chunk)
  })
  return {
    parts: {
      stdin: stream(stdin),
      stdout: stream(stdout),
      stderr: error,
      env: {},
      cwd: '/work',
      platform: 'linux',
      readFile: async (path) => {
        read.push(path)
        return `${SECRET_KEY}\n`
      },
      stat: async () => ({ mode: 0o100600 }),
      ...overrides,
    },
    stderr: () => written,
    read,
  }
}

describe('who can be asked', () => {
  test.each([
    ['a terminal on both', [true, true, true], true],
    ['standard output in a file (`tula apply > plan.txt`)', [true, false, true], true],
    ['standard error in a file', [true, true, false], false],
    ['standard input piped', [false, true, true], false],
    ['nothing a terminal (CI)', [false, false, false], false],
  ] as [string, [boolean, boolean, boolean], boolean][])('%s', (_name, ttys, expected) => {
    expect(createProcessIo(parts({ ttys }).parts).isTTY).toBe(expected)
  })

  test('whether standard input is a terminal is said on its own', () => {
    expect(createProcessIo(parts({ ttys: [true, false, false] }).parts).stdinIsTTY).toBe(true)
    expect(createProcessIo(parts({ ttys: [false, true, true] }).parts).stdinIsTTY).toBe(false)
  })

  test('the question is written to standard error and the answer read from standard input', async () => {
    const made = parts({ ttys: [true, false, true] })
    const io = createProcessIo(made.parts)
    const answer = io.prompt?.('Type yes to continue: ')
    ;(made.parts.stdin as PassThrough).write('yes\n')
    expect(await answer).toBe('yes')
    expect(made.stderr()).toContain('Type yes to continue: ')
  })
})

describe('the secret key file', () => {
  test.each([
    ['readable by the group', 0o100640],
    ['readable by everyone', 0o100644],
    ['writable by others', 0o100602],
  ])(
    'a file %s is read, with one warning on standard error that shows no content',
    async (_name, mode) => {
      const made = parts({ stat: async () => ({ mode }) })
      const io = createProcessIo(made.parts)
      expect(await io.readFile?.('key.txt')).toBe(`${SECRET_KEY}\n`)
      expect(await io.readFile?.('key.txt')).toBe(`${SECRET_KEY}\n`)
      const warnings = made
        .stderr()
        .split('\n')
        .filter((line) => line.startsWith('warning:'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('readable by other users')
      expect(warnings[0]).toContain('chmod 600')
      expect(made.stderr()).not.toContain(SECRET_KEY)
      expect(made.read).toEqual(['/work/key.txt', '/work/key.txt'])
    }
  )

  test.each([
    ['its owner only (0600)', 0o100600],
    ['its owner, read-only (0400)', 0o100400],
  ])('a file for %s is read without a word', async (_name, mode) => {
    const made = parts({ stat: async () => ({ mode }) })
    expect(await createProcessIo(made.parts).readFile?.('/abs/key.txt')).toBe(`${SECRET_KEY}\n`)
    expect(made.stderr()).toBe('')
    expect(made.read).toEqual(['/abs/key.txt'])
  })

  test('where there are no POSIX modes the check is skipped', async () => {
    let looked = 0
    const made = parts({
      platform: 'win32',
      stat: async () => {
        looked += 1
        return { mode: 0o100666 }
      },
    })
    expect(await createProcessIo(made.parts).readFile?.('key.txt')).toBe(`${SECRET_KEY}\n`)
    expect(made.stderr()).toBe('')
    expect(looked).toBe(0)
  })

  test('a file that cannot be looked at fails as the read does, with no warning', async () => {
    const made = parts({
      stat: () => Promise.reject(new Error('ENOENT')),
      readFile: () => Promise.reject(new Error('ENOENT')),
    })
    await expect(createProcessIo(made.parts).readFile?.('missing.txt')).rejects.toThrow('ENOENT')
    expect(made.stderr()).toBe('')
  })
})

test('standard input is read whole', async () => {
  const made = parts()
  const text = createProcessIo(made.parts).readStdin?.()
  ;(made.parts.stdin as PassThrough).end(` ${SECRET_KEY}\n`)
  expect(await text).toBe(` ${SECRET_KEY}\n`)
})

test('the process’s own io reads a real file, relative to the working directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tula-process-io-'))
  try {
    writeFileSync(join(dir, 'key.txt'), `${SECRET_KEY}\n`, { mode: 0o600 })
    const io = processIo()
    expect(await io.readFile?.(join(dir, 'key.txt'))).toBe(`${SECRET_KEY}\n`)
    expect(io.cwd).toBe(process.cwd())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
