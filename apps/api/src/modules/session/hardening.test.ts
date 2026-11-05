import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { requestMayUseSessionCookie } from '~/middleware/cors'
import { createTestDeps, TEST_TENANT } from '~/testing'

/** Ask `requestMayUseSessionCookie` about one request, through a real Hono context. */
async function mayUse(method: string, headers: Record<string, string>): Promise<boolean> {
  const deps = createTestDeps()
  const app = new Hono()
  app.all('/', async (c) => {
    c.set('deps' as never, deps as never)
    c.set('tenant' as never, TEST_TENANT as never)
    return c.json({ ok: await requestMayUseSessionCookie(c as never) })
  })
  const res = await app.request('/', { method, headers })
  return ((await res.json()) as { ok: boolean }).ok
}

describe('H-098: the literal null origin never carries a session cookie', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'GET']) {
    test(`Origin: null is refused on ${method}`, async () => {
      expect(await mayUse(method, { origin: 'null' })).toBe(false)
    })
  }
  test('an unsafe method with no Origin is refused, a safe one is served', async () => {
    expect(await mayUse('POST', {})).toBe(false)
    expect(await mayUse('GET', {})).toBe(true)
  })
})

describe('H-097: only the start of an attempt fixes its device key', () => {
  test('the device thumbprint is written by asked() alone', () => {
    const source = readFileSync(`${import.meta.dir}/../flow/service.ts`, 'utf8')
    const writes = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /deviceThumbprint\b/.test(line))
      // The declaration, the zod field, asked()'s two lines and the one read at finish.
      .filter(
        (line) =>
          !/^deviceThumbprint\??: (string|z\.string\(\)\.optional\(\)),?$/.test(line) &&
          line !==
            '...(context.deviceThumbprint && { deviceThumbprint: context.deviceThumbprint }),' &&
          line !== 'deviceThumbprint: state.deviceThumbprint,' &&
          !line.includes("'deviceThumbprint'")
      )
    expect(writes).toEqual([])
  })
})
