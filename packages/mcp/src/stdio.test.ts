import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { createTulaMcpServer } from './server'
import { serveOverStdio } from './stdio'

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'by-hand', version: '0.0.0' },
  },
}

function streams() {
  const input = new PassThrough()
  const output = new PassThrough()
  let wire = ''
  output.on('data', (chunk) => {
    wire += String(chunk)
  })
  const answered = async (id: number) => {
    for (let waited = 0; waited < 200; waited += 1) {
      const line = wire.split('\n').find((text) => text.includes(`"id":${id}`))
      if (line) {
        return JSON.parse(line) as { result?: Record<string, unknown>; error?: unknown }
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`no answer to ${id}`)
  }
  return { input, output, wire: () => wire, answered }
}

describe('serveOverStdio', () => {
  test('answers on the output stream and returns when the input ends', async () => {
    const { input, output, wire, answered } = streams()
    const logs: string[] = []
    const served = serveOverStdio(
      createTulaMcpServer({ cwd: import.meta.dir, log: (line) => logs.push(line) }),
      { input, output }
    )
    input.write(`${JSON.stringify(INITIALIZE)}\n`)
    expect((await answered(1)).result?.serverInfo).toMatchObject({ name: 'tula' })
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_settings', arguments: {} } })}\n`
    )
    expect(JSON.stringify(await answered(2))).toContain('not_configured')
    input.end()
    await served
    // The log line went to the logger, not onto the wire.
    expect(logs).toEqual([expect.stringContaining('tula mcp: get_settings error not_configured')])
    for (const line of wire()
      .split('\n')
      .filter((text) => text !== '')) {
      expect((JSON.parse(line) as { jsonrpc: string }).jsonrpc).toBe('2.0')
    }
  })

  test('returns when the process is asked to stop, and stops listening for it', async () => {
    const { input, output, answered } = streams()
    let stop: (() => void) | undefined
    let listening = true
    const served = serveOverStdio(createTulaMcpServer({ cwd: import.meta.dir }), {
      input,
      output,
      onTerminate: (listener) => {
        stop = listener
        return () => {
          listening = false
        }
      },
    })
    input.write(`${JSON.stringify(INITIALIZE)}\n`)
    await answered(1)
    stop?.()
    await served
    expect(listening).toBe(false)
  })
})
