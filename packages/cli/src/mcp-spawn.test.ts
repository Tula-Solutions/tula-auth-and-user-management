import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `tula mcp` as a child process, the way an MCP client starts it: newline-delimited JSON-RPC
// on its standard input and output. Each spawn has a timeout, so a child that never exits
// fails one test instead of hanging the run.
const BIN = join(import.meta.dir, 'bin.ts')
const TIMEOUT_MS = 15_000
const SECRET_KEY = 'tula_sk_dev_mcpspawn000000000000000000000000000'
const ADMIN_TOKEN = 'mcpSpawnAdminToken0000000000000000000000'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tula-mcp-spawn-'))
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { react: '19.0.0' }, devDependencies: { vite: '7.0.0' } })
  )
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function start(env: Record<string, string> = {}) {
  const child = Bun.spawn(['bun', BIN, 'mcp'], {
    timeout: TIMEOUT_MS,
    cwd: dir,
    // Nothing of the developer's own environment: a real TULA_SECRET_KEY must not leak in.
    env: { PATH: process.env.PATH ?? '', NO_COLOR: '1', ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let stdout = ''
  const decoder = new TextDecoder()
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk, { stream: true })
    }
  })()
  const send = (message: object) => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.flush()
  }
  const answer = async (id: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      for (const line of stdout.split('\n').slice(0, -1)) {
        const message = JSON.parse(line) as { id?: number }
        if (message.id === id) {
          return message as Record<string, unknown>
        }
      }
      await Bun.sleep(10)
    }
    throw new Error(`no answer to request ${id}`)
  }
  const finished = async () => {
    const code = await child.exited
    await reading
    return { code, stdout, stderr: await new Response(child.stderr).text() }
  }
  return { child, send, answer, finished }
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spawn-test', version: '0.0.0' },
  },
}

function onlyFrames(stdout: string): void {
  const lines = stdout.split('\n').filter((line) => line !== '')
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) {
    expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0')
  }
}

describe('tula mcp, spawned', () => {
  test('initialize and a tool call; standard output is only protocol; exits 0 when input closes', async () => {
    // A port nothing listens on: a read tool gets as far as its request and fails cleanly.
    const run = start({
      TULA_API_URL: 'http://127.0.0.1:9',
      TULA_SECRET_KEY: SECRET_KEY,
      TULA_ADMIN_TOKEN: ADMIN_TOKEN,
    })
    run.send(INITIALIZE)
    const hello = await run.answer(1)
    expect((hello.result as { serverInfo: { name: string } }).serverInfo.name).toBe('tula')
    run.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    run.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listed = (await run.answer(2)).result as { tools: { name: string }[] }
    expect(listed.tools).toHaveLength(11)

    run.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'detect_framework', arguments: {} },
    })
    const detected = (await run.answer(3)).result as { structuredContent: { framework: string } }
    expect(detected.structuredContent.framework).toBe('react-vite')

    run.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_settings', arguments: {} },
    })
    const failed = (await run.answer(4)).result as {
      isError: boolean
      structuredContent: { error: { code: string } }
    }
    expect(failed.isError).toBe(true)
    expect(failed.structuredContent.error.code).toBe('network.failed')

    run.child.stdin.end()
    const { code, stdout, stderr } = await run.finished()
    expect(code).toBe(0)
    onlyFrames(stdout)
    expect(stderr).toContain('tula mcp: 11 tools, all read-only.')
    expect(stdout + stderr).not.toContain(SECRET_KEY)
    expect(stdout + stderr).not.toContain(ADMIN_TOKEN)
    // The server wrote nothing into the project.
    expect(await readdir(dir)).toEqual(['package.json'])
  })

  test('with nothing configured it still starts, and SIGTERM ends it cleanly', async () => {
    const run = start()
    run.send(INITIALIZE)
    await run.answer(1)
    run.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_users', arguments: {} },
    })
    const answer = (await run.answer(2)).result as {
      structuredContent: { error: { code: string } }
    }
    expect(answer.structuredContent.error.code).toBe('not_configured')
    run.child.kill('SIGTERM')
    const { code, stdout, stderr } = await run.finished()
    expect(code).toBe(0)
    onlyFrames(stdout)
    expect(stderr).toContain('Read tools: not configured')
  })

  test('a refused option prints nothing on standard output', () => {
    const refused = Bun.spawnSync(['bun', BIN, 'mcp', '--secret-key', SECRET_KEY], {
      timeout: TIMEOUT_MS,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(refused.exitCode).toBe(1)
    expect(refused.stdout.toString()).toBe('')
    expect(refused.stderr.toString()).not.toContain(SECRET_KEY)
  })
})
