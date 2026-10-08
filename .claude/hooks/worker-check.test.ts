import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { signWebhook, webhookSecretBytes } from '../../packages/contract/src/webhook-signature'
import {
  deliveriesLogged,
  OWED_WAIT_MS,
  type Received,
  receivedRequests,
  STUCK_WITHIN_MS,
  signedEvent,
  WEBHOOK_WAITING_TOO_LONG_MS,
} from '../../scripts/worker-check/lib'

const root = join(import.meta.dir, '..', '..')

// The receiver and the helpers of `scripts/worker-check/check.ts`, which a CI job runs against
// the packaged stack (TULA-52). What they claim about a run is only as good as they are.
describe('the receiver of the worker check', () => {
  test('it answers 204 on the loopback and writes what it was sent, one line a request', async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000)
    const child = Bun.spawn(['bun', 'run', join(root, 'scripts/worker-check/receiver.ts')], {
      env: { PATH: process.env.PATH ?? '', RECEIVER_PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
      // A receiver that never exits must not outlive the test run.
      timeout: 20_000,
    })
    try {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ''
      const until = async (text: string) => {
        while (!output.includes(text)) {
          const { value, done } = await reader.read()
          if (done) {
            throw new Error(`the receiver ended before it wrote ${text}: ${output}`)
          }
          output += decoder.decode(value)
        }
      }
      await until('"listening"')
      // Only a process in its own network namespace can reach it: that is the proof the check
      // rests on, so the address it binds is part of what it says.
      expect(JSON.parse(output.trim())).toEqual({ listening: `127.0.0.1:${port}` })

      const answer = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: {
          'webhook-id': 'evt_1',
          'webhook-timestamp': '1760000000',
          'webhook-signature': 'v1,c2lnbmF0dXJl',
          'content-type': 'application/json',
        },
        body: '{"id":"evt_1"}',
      })
      expect(answer.status).toBe(204)
      await until('"received"')
      expect(receivedRequests(output)).toEqual([
        {
          method: 'POST',
          path: '/hook',
          peer: '127.0.0.1',
          id: 'evt_1',
          timestamp: '1760000000',
          signature: 'v1,c2lnbmF0dXJl',
          body: '{"id":"evt_1"}',
        },
      ])
    } finally {
      child.kill()
      await child.exited
    }
  }, 30_000)
})

describe('reading the receiver’s output', () => {
  const line = (received: Partial<Received>) => JSON.stringify({ received })

  test('lines that are not a request are left out', () => {
    const log = [
      '{"listening":"127.0.0.1:8787"}',
      'receiver-1  | not json at all',
      line({ method: 'POST', path: '/hook', peer: '127.0.0.1', id: 'a', body: '{}' }),
      '',
      '{"received":"not an object"}',
    ].join('\n')
    expect(receivedRequests(log)).toEqual([
      {
        method: 'POST',
        path: '/hook',
        peer: '127.0.0.1',
        id: 'a',
        timestamp: null,
        signature: null,
        body: '{}',
      },
    ])
  })
})

describe('a request is the server’s only with the endpoint’s signature', () => {
  const secret = `whsec_${Buffer.from(new Uint8Array(32).fill(7)).toString('base64')}`
  const other = `whsec_${Buffer.from(new Uint8Array(32).fill(9)).toString('base64')}`
  const event = {
    id: '0199c1de-0000-7000-8000-000000000001',
    type: 'user.created',
    schemaVersion: 1,
    occurredAt: '2026-10-08T10:00:00.000Z',
    environmentId: '0199c1de-0000-7000-8000-000000000002',
    actor: { type: 'api_key', id: '0199c1de-0000-7000-8000-000000000003' },
    target: { type: 'user', id: '0199c1de-0000-7000-8000-000000000004' },
    data: {},
  }
  const now = new Date('2026-10-08T10:00:30.000Z')

  async function request(key: string, body = JSON.stringify(event)): Promise<Received> {
    const timestamp = Math.floor(now.getTime() / 1000)
    const bytes = webhookSecretBytes(key)
    if (bytes === null) {
      throw new Error('the test secret is malformed')
    }
    return {
      method: 'POST',
      path: '/hook',
      peer: '127.0.0.1',
      id: event.id,
      timestamp: String(timestamp),
      signature: await signWebhook(bytes, event.id, timestamp, body),
      body,
    }
  }

  test('signed with the secret the registration returned: the event', async () => {
    expect(await signedEvent(await request(secret), secret, now)).toEqual({
      id: event.id,
      type: 'user.created',
      test: false,
    })
  })

  test('signed with another secret: nothing', async () => {
    expect(await signedEvent(await request(other), secret, now)).toBeNull()
  })

  test('a body changed after it was signed: nothing', async () => {
    const signed = await request(secret)
    expect(
      await signedEvent(
        { ...signed, body: signed.body.replace('user.created', 'user.deleted') },
        secret,
        now
      )
    ).toBeNull()
  })

  test('no signature at all: nothing', async () => {
    expect(
      await signedEvent({ ...(await request(secret)), signature: null }, secret, now)
    ).toBeNull()
  })
})

// The check leaves an owed event waiting long enough for the server's diagnostics to call
// it stuck. Two numbers in two places would drift apart silently: the check would then pass
// its "more than a minute" before the server had looked, or time out waiting for it.
describe('how long the check waits, against the server’s own threshold', () => {
  test('the server calls an event stuck after a minute', () => {
    expect(WEBHOOK_WAITING_TOO_LONG_MS).toBe(60_000)
  })

  test('the owed event waits longer than that, and the check allows longer still', () => {
    expect(OWED_WAIT_MS).toBe(65_000)
    expect(OWED_WAIT_MS).toBeGreaterThan(WEBHOOK_WAITING_TOO_LONG_MS)
    expect(STUCK_WITHIN_MS).toBe(120_000)
    expect(STUCK_WITHIN_MS).toBeGreaterThan(OWED_WAIT_MS)
  })

  test('the check script uses those two, and no number of its own', async () => {
    const source = await Bun.file(join(root, 'scripts/worker-check/check.ts')).text()
    expect(source).toContain('owedSince + STUCK_WITHIN_MS')
    expect(source).toContain('Date.now() - owedSince < OWED_WAIT_MS')
    expect(source).not.toMatch(/const (OWED_WAIT_MS|STUCK_WITHIN_MS)\b/)
  })

  test('the instance service checks against the same constant', async () => {
    const service = await import('../../apps/api/src/modules/instance/constants')
    expect(service.WEBHOOK_WAITING_TOO_LONG_MS).toBe(WEBHOOK_WAITING_TOO_LONG_MS)
    const source = await Bun.file(join(root, 'apps/api/src/modules/instance/service.ts')).text()
    expect(source).not.toMatch(/const WEBHOOK_WAITING_TOO_LONG_MS\s*=/)
  })
})

describe('which container made a delivery, from its log', () => {
  const round = (delivered: number) =>
    JSON.stringify({ level: 30, msg: 'webhook delivery round finished', delivered, failed: 0 })

  test('the deliveries of every round are added up, and no other line counts', () => {
    const log = [
      '{"level":30,"msg":"tula webhook worker started"}',
      round(0),
      round(1),
      'not json',
      round(2),
      '{"level":30,"msg":"something else","delivered":5}',
    ].join('\n')
    expect(deliveriesLogged(log)).toBe(3)
  })

  test('a log with no round delivered nothing', () => {
    expect(deliveriesLogged('{"level":30,"msg":"tula api listening"}\n')).toBe(0)
  })
})
